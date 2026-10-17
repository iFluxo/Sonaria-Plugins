import { ExtractorPlugin, Playlist, Song, type ResolveOptions } from "sonaria";
import {
  errorMessage,
  searchMirror,
  SonariaPluginsError,
  TimedCache,
  type MirrorSearchResult,
  type MirrorSourceName,
} from "../core";
import { DeezerGateway, DeezerPublicApi, type DeezerAccount, type DeezerPublicAlbum, type DeezerPublicArtist, type DeezerPublicPlaylist, type DeezerPublicTrack, type DeezerQuality } from "./api";
import { deriveDeezerBlowfishKey, parseMasterDecryptKey } from "./crypto";
import { DeezerStreamProxy, type DeezerStreamProxyOptions } from "./stream";
import { parseDeezerUrl } from "./url";

export * from "./api";
export * from "./crypto";
export * from "./stream";
export * from "./url";

/** Default mirror priority when direct Deezer playback is not available. */
export const DEEZER_MIRROR_ORDER: readonly MirrorSourceName[] = ["youtube", "soundcloud"];

export interface DeezerPluginOptions {
  /**
   * Deezer `arl` cookie. Optional: with it (and a valid account) the plugin
   * streams full length tracks directly from Deezer's CDN. Without it the
   * automatic mirror chain or 30 second previews are used.
   */
  arl?: string;
  /**
   * Optional Blowfish key override for `BF_CBC_STRIPE` media. When omitted the
   * standard per-track key (`md5(trackId)` based) is derived automatically.
   */
  masterDecryptKey?: string;
  /** Requested stream quality. Defaults to `"MP3_128"`, downgraded when the account cannot stream it. */
  quality?: DeezerQuality;
  /**
   * Mirror sources used when direct playback is unavailable, in priority
   * order. `true` uses {@link DEEZER_MIRROR_ORDER}, `false` disables mirroring.
   * Defaults to `true`.
   */
  mirror?: boolean | MirrorSourceName[];
  /** Fall back to Deezer's 30 second preview when nothing else works. Defaults to `true`. */
  previewFallback?: boolean;
  /** How many search results to consider in {@link DeezerPlugin.searchSong}. Defaults to `1`. */
  searchLimit?: number;
  /** Build the query used for mirror lookups. Defaults to `"<title> <artist>"`. */
  searchQuery?: (song: Song) => string;
  /** Number of tracks returned by the `artist` URL resolver. Defaults to `50`. */
  artistTracks?: number;
  /** Number of tracks returned by {@link DeezerPlugin.getRelatedSongs}. Defaults to `10`. */
  relatedLimit?: number;
  /** Timeout for Deezer HTTP calls, in ms. Defaults to `15_000`. */
  requestTimeout?: number;
  /** Options for the local decrypting stream proxy. */
  proxy?: DeezerStreamProxyOptions;
  /** Verbose logging hook. */
  debug?: (message: string) => void;
}

/**
 * Deezer extractor plugin for Sonaria.
 *
 * Playback strategy, in order:
 *
 * 1. **Direct** — `arl` + `masterDecryptKey` (optional, derived when absent)
 *    unlock full length tracks through Deezer's CDN. The plugin transparently
 *    decrypts `BF_CBC_STRIPE` files through a loopback stream proxy.
 * 2. **Mirror** — when configured, the track is searched through the other
 *    registered extractor plugins (priority configurable). Metadata stays
 *    Deezer's own.
 * 3. **Preview** — Deezer's 30 second public preview, when `previewFallback`
 *    is enabled.
 */
export class DeezerPlugin extends ExtractorPlugin {
  readonly source = "deezer";

  readonly #options: DeezerPluginOptions;
  readonly #api: DeezerPublicApi;
  readonly #gateway?: DeezerGateway;
  readonly #masterKey?: Uint8Array;
  readonly #streamUrls = new TimedCache<string, string>(10 * 60_000, 64);
  readonly #previews = new TimedCache<string, string>(10 * 60_000, 64);
  readonly #mirrors = new WeakMap<object, MirrorSearchResult>();
  readonly #artists = new WeakMap<object, string>();
  readonly #warned = new Set<string>();
  #proxy?: DeezerStreamProxy;
  #loginPromise?: Promise<DeezerAccount | null>;

  constructor(options: DeezerPluginOptions = {}) {
    super();
    this.#options = options;
    this.#api = new DeezerPublicApi({ timeout: options.requestTimeout });
    this.#gateway = options.arl ? new DeezerGateway({ arl: options.arl, timeout: options.requestTimeout }) : undefined;
    this.#masterKey = options.masterDecryptKey ? parseMasterDecryptKey(options.masterDecryptKey) : undefined;
  }

  /** Whether an ARL cookie was configured. */
  get hasArl(): boolean {
    return this.#gateway !== undefined;
  }

  /** The logged in Deezer account, or `null` when no valid ARL is configured. */
  async login(): Promise<DeezerAccount | null> {
    return this.#login();
  }

  /** Stop the local decrypting proxy server, if it was started. */
  async close(): Promise<void> {
    await this.#proxy?.close();
  }

  override async validate(url: string): Promise<boolean> {
    return parseDeezerUrl(url) !== null;
  }

  override async resolve<T>(url: string, options: ResolveOptions<T>): Promise<Song<T> | Playlist<T>> {
    const info = parseDeezerUrl(url);
    if (!info) throw new SonariaPluginsError("DEEZER_INVALID_URL", `Not a supported Deezer URL: ${url}`);
    switch (info.type) {
      case "track": {
        const track = await this.#api.track(info.id);
        return this.#toSong(track, options);
      }
      case "album": {
        const album = await this.#api.album(info.id);
        const tracks = await this.#api.albumTracks(album);
        return this.#toPlaylist(album, tracks, options, album.cover_xl ?? album.cover_big ?? album.cover_medium ?? album.cover);
      }
      case "playlist": {
        const playlist = await this.#api.playlist(info.id);
        const tracks = await this.#api.playlistTracks(playlist);
        return this.#toPlaylist(playlist, tracks, options, playlist.picture_xl ?? playlist.picture_big ?? playlist.picture_medium ?? playlist.picture);
      }
      case "artist": {
        const artist = await this.#api.artist(info.id);
        const tracks = await this.#api.artistTop(info.id, this.#options.artistTracks ?? 50);
        return new Playlist<T>({ source: this.source, id: String(artist.id), name: artist.name, url: artist.link, thumbnail: artist.picture_xl ?? artist.picture_big, songs: tracks.map((track) => this.#toSong(track, options)) }, options);
      }
    }
  }

  /**
   * Search Deezer.
   *
   * When full lenght playback is possible (valid ARL) the Deezer song is
   * returned directly. Otherwise the query is mirrored through the configured
   * sources; when neither works `null` is returned so Sonaria can continue
   * with the next extractor plugin (this is what powers the automatic fallback
   * used by the info plugins).
   */
  override async searchSong<T>(query: string, options: ResolveOptions<T>): Promise<Song<T> | null> {
    let track: DeezerPublicTrack | undefined;
    try {
      [track] = await this.#api.searchTracks(query, this.#options.searchLimit ?? 1);
    } catch (error) {
      this.#debug(`search failed for "${query}": ${errorMessage(error)}`);
      return null;
    }
    if (!track) return null;

    const song = this.#toSong(track, options);
    if (await this.#login()) return song;

    const sources = this.#mirrorSources();
    if (!sources.length) return null;
    const match = await searchMirror(this.sonaria?.plugins, sources, this.#queryFor(song), options);
    if (!match) return null;
    this.#mirrors.set(song, match);
    return song;
  }

  override async getStreamURL<T>(song: Song<T>): Promise<string> {
    const direct = await this.#directStream(song).catch((error: unknown) => {
      this.#debug(`direct stream failed for ${song.id}: ${errorMessage(error)}`);
      return null;
    });
    if (direct) return direct;

    const mirrored = await this.#mirrorStream(song).catch((error: unknown) => {
      this.#debug(`mirror stream failed for ${song.id}: ${errorMessage(error)}`);
      return null;
    });
    if (mirrored) return mirrored;

    const preview = await this.#previewStream(song).catch(() => null);
    if (preview) return preview;

    throw new SonariaPluginsError(
      "DEEZER_NO_PLAYABLE_SOURCE",
      `No playable source for Deezer track ${song.id} (${song.name ?? "unknown"}): ` +
        `${this.#gateway ? "the ARL could not unlock it" : "no ARL/masterDecryptKey configured"}, ` +
        `${this.#mirrorSources().length ? "mirror sources found nothing" : "mirroring is disabled"} and preview fallback is ${this.#options.previewFallback === false ? "disabled" : "unavailable"}.`,
    );
  }

  override async getRelatedSongs(song: Song): Promise<Song[]> {
    try {
      let artistId = this.#artists.get(song);
      if (!artistId) {
        const track = await this.#api.track(song.id);
        const id = track.artist?.id;
        if (!id) return [];
        artistId = String(id);
        this.#artists.set(song, artistId);
      }
      const limit = this.#options.relatedLimit ?? 10;
      const tracks = await this.#api.artistTop(artistId, limit);
      return tracks
        .filter((track) => String(track.id) !== song.id)
        .slice(0, limit)
        .map((track) => this.#toSong(track));
    } catch (error) {
      this.#debug(`related songs failed for ${song.id}: ${errorMessage(error)}`);
      return [];
    }
  }

  #toSong<T>(track: DeezerPublicTrack, options?: ResolveOptions<T>): Song<T> {
    const artist = track.artist;
    const song = new Song<T>(
      {
        plugin: this,
        source: this.source,
        playFromSource: true,
        id: String(track.id),
        name: track.title_short || track.title,
        duration: track.duration,
        url: track.link ?? `https://www.deezer.com/track/${track.id}`,
        thumbnail: coverOf(track),
        uploader: artist?.name ? { name: artist.name, url: artist.link } : undefined,
      },
      options,
    );
    if (artist?.id) this.#artists.set(song, String(artist.id));
    return song;
  }

  #toPlaylist<T>(
    resource: { id: number; title: string; link?: string },
    tracks: DeezerPublicTrack[],
    options?: ResolveOptions<T>,
    thumbnail?: string,
  ): Playlist<T> {
    return new Playlist<T>(
      {
        source: this.source,
        id: String(resource.id),
        name: resource.title,
        url: resource.link,
        thumbnail,
        songs: tracks.map((track) => this.#toSong(track, options)),
      },
      options,
    );
  }

  async #directStream(song: Song): Promise<string | null> {
    const gateway = this.#gateway;
    if (!gateway) return null;
    const cached = this.#streamUrls.get(song.id);
    if (cached) return cached;
    const account = await this.#login();
    if (!account) return null;
    const quality = this.#effectiveQuality(account);
    const trackToken = await gateway.trackToken(song.id);
    const mediaUrl = await gateway.mediaUrl(trackToken.token, quality);
    const key = this.#masterKey ?? deriveDeezerBlowfishKey(song.id);
    const proxy = (this.#proxy ??= new DeezerStreamProxy(this.#options.proxy));
    const url = await proxy.create({ url: mediaUrl, key });
    return this.#streamUrls.set(song.id, url);
  }

  async #mirrorStream(song: Song): Promise<string | null> {
    const known = this.#mirrors.get(song);
    if (known) return known.plugin.getStreamURL(known.song);

    const sources = this.#mirrorSources();
    if (!sources.length) return null;
    const match = await searchMirror(this.sonaria?.plugins, sources, this.#queryFor(song));
    if (!match) return null;
    this.#mirrors.set(song, match);
    return match.plugin.getStreamURL(match.song);
  }

  async #previewStream(song: Song): Promise<string | null> {
    if (this.#options.previewFallback === false) return null;
    const cached = this.#previews.get(song.id);
    if (cached) return cached;
    const track = await this.#api.track(song.id);
    if (!track.preview) return null;
    return this.#previews.set(song.id, track.preview);
  }

  async #login(): Promise<DeezerAccount | null> {
    const gateway = this.#gateway;
    if (!gateway) return null;
    this.#loginPromise ??= gateway.login().catch((error: unknown) => {
      this.#warning("arl", `ARL login failed (${errorMessage(error)}). Continuing without direct Deezer playback.`);
      return null;
    });
    return this.#loginPromise;
  }

  #effectiveQuality(account: DeezerAccount): DeezerQuality {
    const requested = this.#options.quality ?? "MP3_128";
    if (requested === "FLAC") {
      if (account.canStreamLossless) return "FLAC";
      const fallback: DeezerQuality = account.canStreamHQ ? "MP3_320" : "MP3_128";
      this.#debugOnce(`quality:${requested}`, `Account cannot stream FLAC, using ${fallback} instead.`);
      return fallback;
    }
    if (requested === "MP3_320" && !account.canStreamHQ) {
      this.#debugOnce(`quality:${requested}`, "Account cannot stream MP3_320, using MP3_128 instead.");
      return "MP3_128";
    }
    return requested;
  }

  #mirrorSources(): string[] {
    const { mirror } = this.#options;
    if (mirror === false) return [];
    if (Array.isArray(mirror)) return mirror.filter((source) => source !== "deezer");
    return [...DEEZER_MIRROR_ORDER];
  }

  #queryFor(song: Song): string {
    const custom = this.#options.searchQuery?.(song);
    if (custom) return custom;
    const name = song.name ?? "";
    const artist = song.uploader?.name ?? "";
    return `${name} ${artist}`.trim() || song.id;
  }

  #debug(message: string): void {
    this.#options.debug?.(`[deezer] ${message}`);
  }

  #debugOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#debug(message);
  }

  #warning(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(`[sonaria-plugins:deezer] ${message}`);
  }
}

function coverOf(track: DeezerPublicTrack): string | undefined {
  const album = track.album;
  if (album?.cover_xl) return album.cover_xl;
  if (album?.cover_big) return album.cover_big;
  if (album?.cover_medium) return album.cover_medium;
  if (album?.cover) return album.cover;
  if (album?.md5_image) return `https://e-cdns-images.dzcdn.net/images/cover/${album.md5_image}/1000x1000-000000-80-0-0.jpg`;
  return undefined;
}

/**
 * Create a Deezer plugin.
 *
 * ```ts
 * const plugins = [deezer({ arl: process.env.DEEZER_ARL, masterDecryptKey: process.env.DEEZER_MDK })];
 * ```
 */
export function deezer(options: DeezerPluginOptions = {}): DeezerPlugin {
  return new DeezerPlugin(options);
}

export default deezer;

export type { DeezerPublicAlbum, DeezerPublicArtist, DeezerPublicPlaylist, DeezerPublicTrack };
