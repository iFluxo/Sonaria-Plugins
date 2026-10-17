import { InfoExtractorPlugin, Playlist, Song, type ResolveOptions } from "sonaria";
import { errorMessage, SonariaPluginsError } from "../core";
import { AppleMusicApi, type AppleMusicApiOptions, type AppleMusicCollectionInfo, type AppleMusicTrackInfo } from "./api";
import { isAppleMusicUrl, parseAppleMusicUrl } from "./url";

export * from "./api";
export * from "./url";

export interface AppleMusicPluginOptions extends AppleMusicApiOptions {
  /** Tracks returned by {@link AppleMusicPlugin.getRelatedSongs}. Defaults to `10`. */
  relatedLimit?: number;
  /** Builds the query used to mirror the track on Deezer/YouTube/SoundCloud. */
  searchQuery?: (song: Song) => string;
  debug?: (message: string) => void;
}

/**
 * Apple Music info plugin for Sonaria.
 *
 * Apple Music cannot be streamed directly, so this is an `InfoExtractorPlugin`:
 * resolving an Apple Music link returns a {@link Song}/{@link Playlist} that
 * keeps the **original Apple Music metadata**, while playback is delegated to
 * the registered extractor plugins through `createSearchQuery()` —
 * automatically, in registration order.
 *
 * Tracks and albums come from the public iTunes lookup API, playlists and
 * artist top songs from the Apple Music page's `serialized-server-data`.
 */
export class AppleMusicPlugin extends InfoExtractorPlugin {
  readonly source = "applemusic";

  readonly #options: AppleMusicPluginOptions;
  readonly #api: AppleMusicApi;

  constructor(options: AppleMusicPluginOptions = {}) {
    super();
    this.#options = options;
    this.#api = new AppleMusicApi(options);
  }

  /** The underlying Apple Music client. */
  get api(): AppleMusicApi {
    return this.#api;
  }

  override async validate(url: string): Promise<boolean> {
    return isAppleMusicUrl(url);
  }

  override async resolve<T>(url: string, options: ResolveOptions<T>): Promise<Song<T> | Playlist<T>> {
    const parsed = parseAppleMusicUrl(url);
    if (!parsed) throw new SonariaPluginsError("APPLEMUSIC_INVALID_URL", `Not a supported Apple Music URL: ${url}`);
    switch (parsed.type) {
      case "track":
        return this.#toSong(await this.#api.track(parsed.id, { albumId: parsed.albumId, storefront: parsed.storefront }), options);
      case "album":
        return this.#toPlaylist(await this.#api.album(parsed.id), options);
      case "playlist":
        return this.#toPlaylist(await this.#api.playlist(parsed.id), options);
      case "artist":
        return this.#toPlaylist(await this.#api.artist(parsed.id), options);
    }
  }

  override async createSearchQuery<T>(song: Song<T>): Promise<string> {
    const custom = this.#options.searchQuery?.(song);
    if (custom) return custom;
    const query = [song.name, song.uploader?.name].filter((value): value is string => Boolean(value?.trim())).join(" ").trim();
    return query || song.url || song.id;
  }

  override async getRelatedSongs(song: Song): Promise<Song[]> {
    const artist = song.uploader?.url ? parseAppleMusicUrl(song.uploader.url) : null;
    if (artist?.type !== "artist") return [];
    try {
      const collection = await this.#api.artist(artist.id);
      return collection.tracks
        .filter((track) => track.id && track.id !== song.id)
        .slice(0, this.#options.relatedLimit ?? 10)
        .map((track) => this.#toSong(track));
    } catch (error) {
      this.#debug(`related songs failed for ${song.id}: ${errorMessage(error)}`);
      return [];
    }
  }

  #toSong<T>(track: AppleMusicTrackInfo, options?: ResolveOptions<T>): Song<T> {
    return new Song<T>(
      {
        plugin: this,
        source: this.source,
        // Apple Music never streams directly: Sonaria mirrors it through the
        // registered extractor plugins using createSearchQuery().
        playFromSource: false,
        id: track.id,
        name: track.name,
        url: track.url,
        thumbnail: track.thumbnail,
        duration: track.duration,
        uploader: track.artists.length ? { name: track.artists.join(", "), url: track.artistUrl } : undefined,
      },
      options,
    );
  }

  #toPlaylist<T>(collection: AppleMusicCollectionInfo, options?: ResolveOptions<T>): Playlist<T> {
    return new Playlist<T>(
      {
        source: this.source,
        id: collection.id,
        name: collection.name,
        url: collection.url,
        thumbnail: collection.thumbnail,
        songs: collection.tracks.filter((track) => track.id).map((track) => this.#toSong(track, options)),
      },
      options,
    );
  }

  #debug(message: string): void {
    this.#options.debug?.(`[applemusic] ${message}`);
  }
}

/**
 * Create an Apple Music plugin.
 *
 * ```ts
 * const plugins = [applemusic({ storefront: "us" })];
 * ```
 */
export function applemusic(options: AppleMusicPluginOptions = {}): AppleMusicPlugin {
  return new AppleMusicPlugin(options);
}

export default applemusic;
