import { InfoExtractorPlugin, Playlist, Song, type ResolveOptions } from "sonaria";
import { errorMessage, SonariaPluginsError } from "../core";
import { SpotifyApi, type SpotifyApiOptions, type SpotifyCollectionInfo, type SpotifyTrackInfo } from "./api";
import { isSpotifyUrl, parseSpotifyUrl } from "./url";

export * from "./api";
export * from "./url";

export interface SpotifyPluginOptions extends SpotifyApiOptions {
  /** Tracks returned by {@link SpotifyPlugin.getRelatedSongs}. Defaults to `10`. */
  relatedLimit?: number;
  /** Builds the query used to mirror the track on Deezer/YouTube/SoundCloud. */
  searchQuery?: (song: Song) => string;
  debug?: (message: string) => void;
}

/**
 * Spotify info plugin for Sonaria.
 *
 * Spotify cannot be streamed directly, so this is an `InfoExtractorPlugin`:
 * resolving a Spotify link returns a {@link Song}/{@link Playlist} that keeps
 * the **original Spotify metadata**, while playback is delegated to the
 * registered extractor plugins through `createSearchQuery()` — automatically,
 * in registration order.
 *
 * Metadata comes from the Web API when `clientId` + `clientSecret` (or an
 * `accessToken`) are configured, and from the public embed page otherwise.
 */
export class SpotifyPlugin extends InfoExtractorPlugin {
  readonly source = "spotify";

  readonly #options: SpotifyPluginOptions;
  readonly #api: SpotifyApi;

  constructor(options: SpotifyPluginOptions = {}) {
    super();
    this.#options = options;
    this.#api = new SpotifyApi(options);
  }

  /** The underlying Spotify client. */
  get api(): SpotifyApi {
    return this.#api;
  }

  override async validate(url: string): Promise<boolean> {
    return isSpotifyUrl(url);
  }

  override async resolve<T>(url: string, options: ResolveOptions<T>): Promise<Song<T> | Playlist<T>> {
    const parsed = parseSpotifyUrl(url);
    if (!parsed) throw new SonariaPluginsError("SPOTIFY_INVALID_URL", `Not a supported Spotify URL: ${url}`);
    switch (parsed.type) {
      case "track":
        return this.#toSong(await this.#api.track(parsed.id), options);
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
    const artist = song.uploader?.url ? parseSpotifyUrl(song.uploader.url) : null;
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

  #toSong<T>(track: SpotifyTrackInfo, options?: ResolveOptions<T>): Song<T> {
    return new Song<T>(
      {
        plugin: this,
        source: this.source,
        // Spotify never streams directly: Sonaria mirrors it through the
        // registered extractor plugins using createSearchQuery().
        playFromSource: false,
        id: track.id,
        name: track.name,
        url: track.url,
        thumbnail: track.thumbnail,
        duration: track.duration,
        uploader: track.artists.length
          ? { name: track.artists.join(", "), url: track.artistUrl }
          : undefined,
      },
      options,
    );
  }

  #toPlaylist<T>(collection: SpotifyCollectionInfo, options?: ResolveOptions<T>): Playlist<T> {
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
    this.#options.debug?.(`[spotify] ${message}`);
  }
}

/**
 * Create a Spotify plugin.
 *
 * ```ts
 * const plugins = [spotify({ clientId: process.env.SPOTIFY_ID, clientSecret: process.env.SPOTIFY_SECRET })];
 * ```
 */
export function spotify(options: SpotifyPluginOptions = {}): SpotifyPlugin {
  return new SpotifyPlugin(options);
}

export default spotify;
