import { errorMessage, fetchText, HttpError, requestOk, SonariaPluginsError } from "../core";

export interface SpotifyTrackInfo {
  id: string;
  name?: string;
  /** Artist names, joined for display (`"Daft Punk, Pharrell Williams"`). */
  artists: string[];
  /** Link to the first artist. */
  artistUrl?: string;
  /** Duration in seconds. */
  duration?: number;
  thumbnail?: string;
  url?: string;
  explicit?: boolean;
  album?: {
    id?: string;
    name?: string;
    thumbnail?: string;
    url?: string;
  };
}

export interface SpotifyCollectionInfo {
  id: string;
  name?: string;
  description?: string;
  thumbnail?: string;
  url?: string;
  owner?: string;
  tracks: SpotifyTrackInfo[];
}

export interface SpotifyApiOptions {
  /** Spotify application client id (Web API credentials). */
  clientId?: string;
  /** Spotify application client secret (Web API credentials). */
  clientSecret?: string;
  /** Ready to use bearer token, skips the credentials exchange. */
  accessToken?: string;
  /** Maximum tracks resolved from albums, playlists and artists. Defaults to `100`. */
  maxTracks?: number;
  /** Fall back to the public embed page when the Web API is unavailable. Defaults to `true`. */
  embedFallback?: boolean;
  /** Request timeout in ms. Defaults to `15_000`. */
  timeout?: number;
  /** Web API base, defaults to `https://api.spotify.com/v1`. */
  baseUrl?: string;
  /** Accounts base, defaults to `https://accounts.spotify.com`. */
  accountsUrl?: string;
  /** Embed base, defaults to `https://open.spotify.com/embed`. */
  embedUrl?: string;
  debug?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Web API shapes                                                              */
/* -------------------------------------------------------------------------- */

interface SpotifyApiImage {
  url?: string;
}

interface SpotifyApiArtist {
  id?: string;
  name?: string;
  external_urls?: { spotify?: string };
}

interface SpotifyApiTrack {
  id?: string;
  name?: string;
  duration_ms?: number;
  explicit?: boolean;
  artists?: SpotifyApiArtist[];
  album?: {
    id?: string;
    name?: string;
    images?: SpotifyApiImage[];
    external_urls?: { spotify?: string };
  };
  external_urls?: { spotify?: string };
}

interface SpotifyApiAlbum {
  id?: string;
  name?: string;
  images?: SpotifyApiImage[];
  artists?: SpotifyApiArtist[];
  tracks?: { items?: Array<SpotifyApiTrack | null>; next?: string | null };
}

interface SpotifyApiPlaylist {
  id?: string;
  name?: string;
  description?: string;
  images?: SpotifyApiImage[];
  external_urls?: { spotify?: string };
  owner?: { display_name?: string };
  tracks?: { items?: Array<{ track?: SpotifyApiTrack | null } | null>; next?: string | null };
}

interface SpotifyApiPage<T> {
  items?: Array<T | null>;
  next?: string | null;
}

/* -------------------------------------------------------------------------- */
/* Embed shape                                                                 */
/* -------------------------------------------------------------------------- */

interface SpotifyEmbedEntity {
  type?: string;
  id?: string;
  uri?: string;
  name?: string;
  title?: string;
  subtitle?: string;
  /** Milliseconds. */
  duration?: number;
  isExplicit?: boolean;
  artists?: Array<{ name?: string; uri?: string }>;
  visualIdentity?: { image?: Array<{ url?: string }> };
  coverArt?: { sources?: Array<{ url?: string }> };
  audioPreview?: { url?: string };
  trackList?: Array<{
    uri?: string;
    title?: string;
    subtitle?: string;
    duration?: number;
    isExplicit?: boolean;
    coverArt?: { sources?: Array<{ url?: string }> };
    audioPreview?: { url?: string };
  }>;
}

const OPEN_URL = "https://open.spotify.com";

/**
 * Minimal Spotify client.
 *
 * With `clientId` + `clientSecret` (or a ready `accessToken`) it talks to the
 * Web API. Without credentials it reads the same data the public embed page
 * exposes, which is enough to keep original Spotify metadata for the mirror
 * playback chain.
 */
export class SpotifyApi {
  readonly maxTracks: number;
  readonly timeout: number;
  readonly #clientId?: string;
  readonly #clientSecret?: string;
  readonly #embedFallback: boolean;
  readonly #baseUrl: string;
  readonly #accountsUrl: string;
  readonly #embedUrl: string;
  readonly #debug?: (message: string) => void;
  #bearer?: string;
  #bearerExpiry = 0;
  #tokenPromise?: Promise<string>;

  constructor(options: SpotifyApiOptions = {}) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#bearer = options.accessToken;
    this.#bearerExpiry = options.accessToken ? Number.POSITIVE_INFINITY : 0;
    this.#embedFallback = options.embedFallback ?? true;
    this.maxTracks = options.maxTracks ?? 100;
    this.timeout = options.timeout ?? 15_000;
    this.#baseUrl = options.baseUrl ?? "https://api.spotify.com/v1";
    this.#accountsUrl = options.accountsUrl ?? "https://accounts.spotify.com/api/token";
    this.#embedUrl = options.embedUrl ?? `${OPEN_URL}/embed`;
    this.#debug = options.debug;
  }

  /** Whether a Web API credential is configured. */
  get hasCredentials(): boolean {
    return Boolean(this.#bearer) || Boolean(this.#clientId && this.#clientSecret);
  }

  /** Track metadata. */
  async track(id: string): Promise<SpotifyTrackInfo> {
    return this.#withFallback<SpotifyTrackInfo>(
      async () => trackToInfo(await this.#request<SpotifyApiTrack>(this.#api(`/tracks/${id}`)), id),
      async () => embedToTrack(await this.#embed("track", id), id),
    );
  }

  /** Album metadata with (paginated) tracks. */
  async album(id: string): Promise<SpotifyCollectionInfo> {
    return this.#withFallback<SpotifyCollectionInfo>(
      async () => {
        const album = await this.#request<SpotifyApiAlbum>(this.#api(`/albums/${id}`));
        const items = await this.#pages<SpotifyApiTrack>(album.tracks?.items ?? [], album.tracks?.next, this.maxTracks);
        const thumbnail = firstImage(album.images);
        return {
          id,
          name: album.name,
          thumbnail,
          url: `${OPEN_URL}/album/${id}`,
          owner: artistNames(album.artists).join(", ") || undefined,
          tracks: items.map((track) => trackToInfo(track, undefined, thumbnail)),
        } satisfies SpotifyCollectionInfo;
      },
      async () => embedToCollection(await this.#embed("album", id), id, "album"),
    );
  }

  /** Playlist metadata with (paginated) tracks. */
  async playlist(id: string): Promise<SpotifyCollectionInfo> {
    return this.#withFallback<SpotifyCollectionInfo>(
      async () => {
        const playlist = await this.#request<SpotifyApiPlaylist>(this.#api(`/playlists/${id}`));
        const entries = await this.#pages<{ track?: SpotifyApiTrack | null }>(playlist.tracks?.items ?? [], playlist.tracks?.next, this.maxTracks);
        return {
          id,
          name: playlist.name,
          description: playlist.description,
          thumbnail: firstImage(playlist.images),
          url: playlist.external_urls?.spotify ?? `${OPEN_URL}/playlist/${id}`,
          owner: playlist.owner?.display_name,
          tracks: entries
            .map((entry) => entry.track)
            .filter((track): track is SpotifyApiTrack => Boolean(track))
            .map((track) => trackToInfo(track)),
        } satisfies SpotifyCollectionInfo;
      },
      async () => embedToCollection(await this.#embed("playlist", id), id, "playlist"),
    );
  }

  /** Artist top tracks (up to `maxTracks`, Spotify itself caps this at 10). */
  async artist(id: string): Promise<SpotifyCollectionInfo> {
    return this.#withFallback<SpotifyCollectionInfo>(
      async () => {
        const [artist, top] = await Promise.all([
          this.#request<{ name?: string; images?: SpotifyApiImage[] }>(this.#api(`/artists/${id}`)),
          this.#request<{ tracks?: SpotifyApiTrack[] }>(this.#api(`/artists/${id}/top-tracks`), { market: "US" }),
        ]);
        return {
          id,
          name: `${artist.name ?? "Artist"} — Top Tracks`,
          thumbnail: firstImage(artist.images),
          url: `${OPEN_URL}/artist/${id}`,
          owner: artist.name,
          tracks: (top.tracks ?? []).slice(0, this.maxTracks).map((track) => trackToInfo(track)),
        } satisfies SpotifyCollectionInfo;
      },
      async () => embedToCollection(await this.#embed("artist", id), id, "artist"),
    );
  }

  /** Build a Web API URL from a path. */
  #api(path: string): string {
    return `${this.#baseUrl}${path}`;
  }

  async #request<T>(url: string, params: Record<string, string | number> = {}): Promise<T> {
    const target = new URL(url);
    for (const [key, value] of Object.entries(params)) target.searchParams.set(key, String(value));
    try {
      const response = await requestOk(target.toString(), {
        headers: { authorization: `Bearer ${await this.#token()}` },
        timeout: this.timeout,
      });
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 401 || error.status === 403) {
          // The cached token may be stale: drop it so the next attempt re-auths.
          if (this.#bearer && this.#bearerExpiry === Number.POSITIVE_INFINITY) this.#bearer = undefined;
          else this.#bearerExpiry = 0;
          throw new SonariaPluginsError("SPOTIFY_FORBIDDEN", `Spotify rejected the request (${error.status}). Check the clientId/clientSecret or accessToken.`);
        }
        if (error.status === 404) throw new SonariaPluginsError("SPOTIFY_NOT_FOUND", `Spotify has nothing at ${error.url}.`);
        if (error.status === 429) throw new SonariaPluginsError("SPOTIFY_RATE_LIMITED", "Spotify rate limited the request, try again later.");
      }
      throw error;
    }
  }

  async #token(): Promise<string> {
    if (this.#bearer && Date.now() < this.#bearerExpiry) return this.#bearer;
    if (!this.#clientId || !this.#clientSecret) {
      throw new SonariaPluginsError("SPOTIFY_NO_CREDENTIALS", "Spotify Web API credentials are not configured.");
    }
    this.#tokenPromise ??= (async () => {
      try {
        const response = await requestOk(this.#accountsUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            authorization: `Basic ${btoa(`${this.#clientId}:${this.#clientSecret}`)}`,
          },
          body: "grant_type=client_credentials",
          timeout: this.timeout,
        });
        const body = (await response.json()) as { access_token?: string; expires_in?: number };
        if (!body.access_token) throw new SonariaPluginsError("SPOTIFY_AUTH_FAILED", "Spotify did not return an access token.");
        this.#bearer = body.access_token;
        this.#bearerExpiry = Date.now() + Math.max(30, (body.expires_in ?? 3600) - 60) * 1000;
        return body.access_token;
      } finally {
        this.#tokenPromise = undefined;
      }
    })();
    return this.#tokenPromise;
  }

  /** Follow `next` links until `limit` items were collected. */
  async #pages<T>(items: Array<T | null>, next: string | null | undefined, limit: number): Promise<T[]> {
    const collected = items.filter((item): item is T => item != null);
    let cursor = next ?? null;
    while (collected.length < limit && cursor) {
      const page = await this.#request<SpotifyApiPage<T>>(cursor);
      collected.push(...(page.items ?? []).filter((item): item is T => item != null));
      cursor = page.next ?? null;
    }
    return collected.slice(0, limit);
  }

  async #withFallback<T>(fromApi: () => Promise<T>, fromEmbed: () => Promise<T>): Promise<T> {
    if (this.hasCredentials) {
      try {
        return await fromApi();
      } catch (error) {
        if (!this.#embedFallback) throw error;
        this.#debug?.(`Spotify Web API failed (${errorMessage(error)}), falling back to the public embed`);
      }
    } else if (!this.#embedFallback) {
      throw new SonariaPluginsError(
        "SPOTIFY_NO_CREDENTIALS",
        "No Spotify credentials configured: pass `clientId` + `clientSecret`, an `accessToken`, or keep `embedFallback` enabled.",
      );
    }
    return fromEmbed();
  }

  /** Read the `__NEXT_DATA__` entity of a public embed page. */
  async #embed(kind: string, id: string): Promise<SpotifyEmbedEntity> {
    const html = await fetchText(`${this.#embedUrl}/${kind}/${id}`, { timeout: this.timeout });
    const match = /<script id="__NEXT_DATA__" type="application\/json">(.+?)<\/script>/su.exec(html);
    if (!match?.[1]) throw new SonariaPluginsError("SPOTIFY_EMBED_FAILED", `Cannot read the Spotify embed data for ${kind} ${id}.`);
    const data = JSON.parse(match[1]) as { props?: { pageProps?: { state?: { data?: { entity?: SpotifyEmbedEntity } } } } };
    const entity = data.props?.pageProps?.state?.data?.entity;
    if (!entity) throw new SonariaPluginsError("SPOTIFY_EMBED_FAILED", `Spotify embed did not include an entity for ${kind} ${id}.`);
    return entity;
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping helpers                                                             */
/* -------------------------------------------------------------------------- */

function firstImage(images: SpotifyApiImage[] | undefined): string | undefined {
  return images?.[0]?.url;
}

function artistNames(artists: SpotifyApiArtist[] | undefined): string[] {
  return (artists ?? []).map((artist) => artist.name).filter((name): name is string => Boolean(name));
}

function trackToInfo(track: SpotifyApiTrack, fallbackId?: string, fallbackThumbnail?: string): SpotifyTrackInfo {
  const artists = artistNames(track.artists);
  const album = track.album;
  return {
    id: track.id ?? fallbackId ?? "",
    name: track.name,
    artists,
    artistUrl: track.artists?.[0]?.external_urls?.spotify ?? (track.artists?.[0]?.id ? `${OPEN_URL}/artist/${track.artists[0].id}` : undefined),
    duration: track.duration_ms !== undefined ? track.duration_ms / 1000 : undefined,
    thumbnail: firstImage(album?.images) ?? fallbackThumbnail,
    url: track.external_urls?.spotify ?? (track.id ? `${OPEN_URL}/track/${track.id}` : undefined),
    explicit: track.explicit,
    album: album
      ? {
          id: album.id,
          name: album.name,
          thumbnail: firstImage(album.images) ?? fallbackThumbnail,
          url: album.external_urls?.spotify ?? (album.id ? `${OPEN_URL}/album/${album.id}` : undefined),
        }
      : undefined,
  };
}

function idFromUri(uri: string | undefined): string | undefined {
  return uri?.split(":").at(2);
}

function embedImage(entity: SpotifyEmbedEntity, item?: { coverArt?: { sources?: Array<{ url?: string }> } }): string | undefined {
  return item?.coverArt?.sources?.[0]?.url ?? entity.coverArt?.sources?.[0]?.url ?? entity.visualIdentity?.image?.[0]?.url;
}

function embedToTrack(entity: SpotifyEmbedEntity, fallbackId: string): SpotifyTrackInfo {
  const id = entity.id ?? idFromUri(entity.uri) ?? fallbackId;
  return {
    id,
    name: entity.name ?? entity.title,
    artists: (entity.artists ?? []).map((artist) => artist.name).filter((name): name is string => Boolean(name)),
    artistUrl: idFromUri(entity.artists?.[0]?.uri) ? `${OPEN_URL}/artist/${idFromUri(entity.artists?.[0]?.uri)}` : undefined,
    duration: entity.duration !== undefined ? entity.duration / 1000 : undefined,
    thumbnail: embedImage(entity),
    url: id ? `${OPEN_URL}/track/${id}` : undefined,
    explicit: entity.isExplicit,
    album: entity.coverArt?.sources?.[0]?.url ? { thumbnail: entity.coverArt.sources[0].url } : undefined,
  };
}

function embedToCollection(entity: SpotifyEmbedEntity, fallbackId: string, kind: "album" | "playlist" | "artist"): SpotifyCollectionInfo {
  const id = entity.id ?? idFromUri(entity.uri) ?? fallbackId;
  const thumbnail = embedImage(entity);
  return {
    id,
    name: kind === "artist" ? `${entity.name ?? entity.title ?? "Artist"} — Top Tracks` : entity.name ?? entity.title,
    description: entity.subtitle,
    thumbnail,
    url: id ? `${OPEN_URL}/${kind}/${id}` : undefined,
    owner: kind === "artist" ? entity.name ?? entity.title : entity.subtitle,
    tracks: (entity.trackList ?? []).map((item) => {
      const trackId = idFromUri(item.uri) ?? "";
      return {
        id: trackId,
        name: item.title,
        artists: item.subtitle ? item.subtitle.split(/,\s*/u).filter(Boolean) : [],
        duration: item.duration !== undefined ? item.duration / 1000 : undefined,
        thumbnail: embedImage(entity, item) ?? thumbnail,
        url: trackId ? `${OPEN_URL}/track/${trackId}` : undefined,
        explicit: item.isExplicit,
      } satisfies SpotifyTrackInfo;
    }),
  };
}
