import { errorMessage, fetchJson, fetchText, HttpError, SonariaPluginsError } from "../core";

export interface AppleMusicTrackInfo {
  id: string;
  name?: string;
  artists: string[];
  artistUrl?: string;
  /** Duration in seconds. */
  duration?: number;
  thumbnail?: string;
  url?: string;
  album?: {
    id?: string;
    name?: string;
    thumbnail?: string;
    url?: string;
  };
}

export interface AppleMusicCollectionInfo {
  id: string;
  name?: string;
  description?: string;
  thumbnail?: string;
  url?: string;
  owner?: string;
  tracks: AppleMusicTrackInfo[];
}

export interface AppleMusicApiOptions {
  /** Storefront used for page URLs, e.g. `"us"`, `"id"`. Defaults to `"us"`. */
  storefront?: string;
  /** Maximum tracks resolved from albums/playlists/artists. Defaults to `100`. */
  maxTracks?: number;
  /** Request timeout in ms. Defaults to `15_000`. */
  timeout?: number;
  /** Web page base, defaults to `https://music.apple.com`. */
  pageUrl?: string;
  /** Lookup API base, defaults to `https://itunes.apple.com/lookup`. */
  lookupUrl?: string;
  debug?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* iTunes lookup shapes                                                        */
/* -------------------------------------------------------------------------- */

interface ItunesResult {
  wrapperType?: string;
  kind?: string;
  artistId?: number;
  artistName?: string;
  artistViewUrl?: string;
  collectionId?: number;
  collectionName?: string;
  collectionViewUrl?: string;
  trackId?: number;
  trackName?: string;
  trackTimeMillis?: number;
  trackViewUrl?: string;
  artworkUrl100?: string;
  discNumber?: number;
  trackNumber?: number;
  trackCount?: number;
  previewUrl?: string;
}

/* -------------------------------------------------------------------------- */
/* Apple Music page (`serialized-server-data`) shapes                          */
/* -------------------------------------------------------------------------- */

interface PageLink {
  title?: string;
  segue?: {
    destination?: {
      contentDescriptor?: {
        kind?: string;
        identifiers?: { storeAdamID?: string };
        url?: string;
      };
    };
  };
}

interface PageItem {
  id?: string;
  title?: string;
  /** Milliseconds. */
  duration?: number;
  artwork?: { dictionary?: { url?: string } } | null;
  subtitleLinks?: PageLink[] | null;
  tertiaryLinks?: PageLink[] | null;
  contentDescriptor?: {
    kind?: string;
    identifiers?: { storeAdamID?: string };
    url?: string;
  } | null;
}

interface PageSection {
  itemKind?: string;
  items?: PageItem[];
}

const PAGE_HEADER = "containerDetailHeaderLockup";
const ARTIST_HEADER = "artistDetailHeader";

/**
 * Minimal Apple Music client.
 *
 * Tracks and albums come from the public iTunes lookup API (fast and
 * detailed), playlists and artist top songs from the web page's
 * `serialized-server-data` JSON, which is exactly what the Apple Music site
 * renders itself.
 */
export class AppleMusicApi {
  readonly storefront: string;
  readonly maxTracks: number;
  readonly timeout: number;
  readonly #pageUrl: string;
  readonly #lookupUrl: string;
  readonly #debug?: (message: string) => void;

  constructor(options: AppleMusicApiOptions = {}) {
    this.storefront = options.storefront ?? "us";
    this.maxTracks = options.maxTracks ?? 100;
    this.timeout = options.timeout ?? 15_000;
    this.#pageUrl = options.pageUrl ?? "https://music.apple.com";
    this.#lookupUrl = options.lookupUrl ?? "https://itunes.apple.com/lookup";
    this.#debug = options.debug;
  }

  /** Track metadata (iTunes lookup, with the album page as fallback). */
  async track(id: string, options: { albumId?: string; storefront?: string } = {}): Promise<AppleMusicTrackInfo> {
    const lookup = await this.#lookup({ id }).catch((error: unknown) => {
      this.#debug?.(`iTunes lookup failed for track ${id}: ${String(error)}`);
      return null;
    });
    const result = lookup?.results.find((entry) => entry.wrapperType === "track" && String(entry.trackId) === id);
    if (result) return trackFromLookup(result);

    if (options.albumId) {
      const scraped = await this.trackFromAlbumPage(options.albumId, id, options.storefront).catch((error: unknown) => {
        this.#debug?.(`album page fallback failed for track ${id}: ${String(error)}`);
        return null;
      });
      if (scraped) return scraped;
    }
    throw new SonariaPluginsError("APPLEMUSIC_NOT_FOUND", `Apple Music has no track with id ${id}.`);
  }

  /** Album metadata with its track list. */
  async album(id: string): Promise<AppleMusicCollectionInfo> {
    const lookup = await this.#lookup({ id, entity: "song", limit: this.maxTracks + 1 }).catch(() => null);
    const collection = lookup?.results.find((entry) => entry.wrapperType === "collection");
    if (collection) {
      const thumbnail = itunesArtwork(collection.artworkUrl100);
      const tracks = lookup!.results
        .filter((entry) => entry.wrapperType === "track")
        .slice(0, this.maxTracks)
        .map((entry) => trackFromLookup(entry, thumbnail));
      return {
        id,
        name: collection.collectionName,
        thumbnail,
        url: collection.collectionViewUrl,
        owner: collection.artistName,
        tracks,
      };
    }

    const sections = await this.#scrape(`${this.#pageUrl}/${this.storefront}/album/${id}`);
    const header = findItem(sections, PAGE_HEADER);
    const items = findItems(sections, "trackLockup");
    if (!items.length) throw new SonariaPluginsError("APPLEMUSIC_NOT_FOUND", `Apple Music has no album with id ${id}.`);
    const context = pageContext(header, `${this.#pageUrl}/${this.storefront}/album/${id}`);
    return {
      id,
      name: header?.title,
      thumbnail: context.thumbnail,
      url: context.url,
      owner: context.artists.join(", ") || undefined,
      tracks: items.slice(0, this.maxTracks).map((item) => trackFromPage(item, context)).filter((track): track is AppleMusicTrackInfo => track !== null),
    };
  }

  /** Playlist metadata with its tracks (up to the first page, ~50 tracks). */
  async playlist(id: string): Promise<AppleMusicCollectionInfo> {
    const url = `${this.#pageUrl}/${this.storefront}/playlist/${id}`;
    const sections = await this.#scrape(url);
    const header = findItem(sections, PAGE_HEADER);
    const items = findItems(sections, "trackLockup");
    if (!items.length) throw new SonariaPluginsError("APPLEMUSIC_NOT_FOUND", `Apple Music has no playlist with id ${id}.`);
    const context = pageContext(header, url);
    return {
      id,
      name: header?.title,
      thumbnail: context.thumbnail,
      url,
      owner: context.artists.join(", ") || undefined,
      tracks: items.slice(0, this.maxTracks).map((item) => trackFromPage(item, context)).filter((track): track is AppleMusicTrackInfo => track !== null),
    };
  }

  /** An artist's top songs. */
  async artist(id: string): Promise<AppleMusicCollectionInfo> {
    const url = `${this.#pageUrl}/${this.storefront}/artist/${id}`;
    const sections = await this.#scrape(url);
    const header = findItem(sections, ARTIST_HEADER);
    const items = findItems(sections, "trackLockup");
    if (!items.length) throw new SonariaPluginsError("APPLEMUSIC_NOT_FOUND", `Apple Music has no artist with id ${id}.`);
    const artists = header?.title ? [header.title] : [];
    const context = { artists, thumbnail: formatArtwork(header?.artwork?.dictionary?.url), albumName: undefined, albumId: undefined, albumUrl: undefined, url };
    return {
      id,
      name: header?.title ? `${header.title} — Top Songs` : "Top Songs",
      thumbnail: context.thumbnail,
      url,
      owner: header?.title,
      tracks: items.slice(0, this.maxTracks).map((item) => trackFromPage(item, context)).filter((track): track is AppleMusicTrackInfo => track !== null),
    };
  }

  /** Read a track from an album page (`/album/<id>?i=<trackId>`). */
  async trackFromAlbumPage(albumId: string, trackId: string, storefront?: string): Promise<AppleMusicTrackInfo | null> {
    const url = `${this.#pageUrl}/${storefront ?? this.storefront}/album/${albumId}?i=${trackId}`;
    const sections = await this.#scrape(url);
    const header = findItem(sections, PAGE_HEADER);
    const items = findItems(sections, "trackLockup");
    const context = pageContext(header, url);
    const item = items.find((entry) => String(entry.contentDescriptor?.identifiers?.storeAdamID ?? "") === trackId);
    return item ? trackFromPage(item, context) : null;
  }

  async #lookup(params: Record<string, string | number>): Promise<{ results: ItunesResult[] }> {
    const url = new URL(this.#lookupUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const body = await fetchJson<{ results?: ItunesResult[] }>(url.toString(), { timeout: this.timeout });
    return { results: body.results ?? [] };
  }

  async #scrape(url: string): Promise<PageSection[]> {
    const html = await fetchText(url, { timeout: this.timeout }).catch((error: unknown) => {
      if (error instanceof HttpError && error.status === 404) {
        throw new SonariaPluginsError("APPLEMUSIC_NOT_FOUND", `Apple Music has nothing at ${url}.`);
      }
      throw new SonariaPluginsError("APPLEMUSIC_PAGE_FAILED", `Cannot read the Apple Music page at ${url}: ${errorMessage(error)}`);
    });
    const match = /<script[^>]*id="serialized-server-data"[^>]*>(.+?)<\/script>/su.exec(html);
    if (!match?.[1]) throw new SonariaPluginsError("APPLEMUSIC_PAGE_FAILED", `Cannot read the Apple Music page data at ${url}.`);
    const parsed = JSON.parse(match[1]) as { data?: Array<{ data?: { sections?: PageSection[] } }> };
    return parsed.data?.[0]?.data?.sections ?? [];
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                             */
/* -------------------------------------------------------------------------- */

function itunesArtwork(url: string | undefined): string | undefined {
  return url?.replace(/\/\d+x\d+(?:bb|sr)?\./u, "/1000x1000bb.");
}

function formatArtwork(url: string | undefined, size = 1000): string | undefined {
  if (!url) return undefined;
  return url.replace(/\{w\}/gu, String(size)).replace(/\{h\}/gu, String(size)).replace(/\{f\}/gu, "jpg");
}

function trackFromLookup(result: ItunesResult, fallbackThumbnail?: string): AppleMusicTrackInfo {
  const thumbnail = itunesArtwork(result.artworkUrl100) ?? fallbackThumbnail;
  return {
    id: String(result.trackId ?? ""),
    name: result.trackName,
    artists: result.artistName ? [result.artistName] : [],
    artistUrl: result.artistViewUrl,
    duration: result.trackTimeMillis !== undefined ? result.trackTimeMillis / 1000 : undefined,
    thumbnail,
    url: result.trackViewUrl,
    album: result.collectionName
      ? {
          id: result.collectionId !== undefined ? String(result.collectionId) : undefined,
          name: result.collectionName,
          thumbnail,
          url: result.collectionViewUrl,
        }
      : undefined,
  };
}

interface PageContext {
  artists: string[];
  thumbnail?: string;
  albumName?: string;
  albumId?: string;
  albumUrl?: string;
  url?: string;
}

function findItem(sections: PageSection[], kind: string): PageItem | undefined {
  return sections.find((section) => section.itemKind === kind)?.items?.[0];
}

function findItems(sections: PageSection[], kind: string): PageItem[] {
  return sections.find((section) => section.itemKind === kind)?.items ?? [];
}

function pageContext(header: PageItem | undefined, url: string): PageContext {
  const artists = (header?.subtitleLinks ?? []).map((link) => link.title).filter((title): title is string => Boolean(title));
  return {
    artists,
    thumbnail: formatArtwork(header?.artwork?.dictionary?.url),
    albumName: header?.title,
    albumId: header?.contentDescriptor?.identifiers?.storeAdamID,
    albumUrl: header?.contentDescriptor?.url ?? url,
    url,
  };
}

function trackFromPage(item: PageItem, context: PageContext): AppleMusicTrackInfo | null {
  const id = String(item.contentDescriptor?.identifiers?.storeAdamID ?? (/^\d+$/u.test(item.id ?? "") ? item.id : ""));
  if (!id) return null;
  const subtitleArtists = (item.subtitleLinks ?? []).map((link) => link.title).filter((title): title is string => Boolean(title));
  const albumLink = (item.tertiaryLinks ?? []).find((link) => link.segue?.destination?.contentDescriptor?.kind === "album");
  const albumId = albumLink?.segue?.destination?.contentDescriptor?.identifiers?.storeAdamID;
  const albumName = context.albumName ?? albumLink?.title;
  const thumbnail = formatArtwork(item.artwork?.dictionary?.url) ?? context.thumbnail;
  return {
    id,
    name: item.title,
    artists: subtitleArtists.length ? subtitleArtists : context.artists,
    duration: item.duration !== undefined ? item.duration / 1000 : undefined,
    thumbnail,
    url: item.contentDescriptor?.url,
    album: albumName
      ? {
          id: albumId ?? context.albumId,
          name: albumLink?.title ?? albumName,
          thumbnail,
          url: albumLink?.segue?.destination?.contentDescriptor?.url ?? context.albumUrl,
        }
      : undefined,
  };
}
