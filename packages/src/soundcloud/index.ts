import { ExtractorPlugin, Playlist, Song, type ResolveOptions } from "sonaria";
import { errorMessage, TimedCache } from "../core";
import { SoundCloudApi, type SoundCloudApiOptions, type SoundCloudPlaylist, type SoundCloudTrack } from "./api";
import { isSoundCloudUrl } from "./url";

export * from "./api";
export * from "./url";

export interface SoundCloudPluginOptions extends SoundCloudApiOptions {
  /** Results considered in {@link SoundCloudPlugin.searchSong}. Defaults to `1`. */
  searchLimit?: number;
  /** Tracks returned by {@link SoundCloudPlugin.getRelatedSongs}. Defaults to `10`. */
  relatedLimit?: number;
  /** Verbose logging hook. */
  debug?: (message: string) => void;
}

/**
 * SoundCloud extractor plugin for Sonaria.
 *
 * Uses SoundCloud's own `api-v2` directly:
 *
 * - the client id is discovered from SoundCloud's JavaScript assets (or can be
 *   passed explicitly), and re-discovered automatically when it goes stale;
 * - `oauthToken` is optional and unlocks full length streams of tracks that are
 *   otherwise `SNIP` limited to a 30 second preview;
 * - playback uses the track's progressive transcoding, with the HLS playlist as
 *   a fallback (FFmpeg handles both).
 */
export class SoundCloudPlugin extends ExtractorPlugin {
  readonly source = "soundcloud";

  readonly #options: SoundCloudPluginOptions;
  readonly #api: SoundCloudApi;
  readonly #tracks = new TimedCache<string, SoundCloudTrack>(5 * 60_000, 128);
  readonly #warned = new Set<string>();

  constructor(options: SoundCloudPluginOptions = {}) {
    super();
    this.#options = options;
    this.#api = new SoundCloudApi(options);
  }

  /** The underlying `api-v2` client (client id discovery, search, resolve). */
  get api(): SoundCloudApi {
    return this.#api;
  }

  override async validate(url: string): Promise<boolean> {
    return isSoundCloudUrl(url);
  }

  override async resolve<T>(url: string, options: ResolveOptions<T>): Promise<Song<T> | Playlist<T>> {
    const resource = await this.#api.resolve(url);
    if (isPlaylist(resource)) {
      // `resolve` usually inlines every track, but a fresh fetch is a bit more
      // reliable for large sets: it keeps the ordering and full track objects.
      const playlist = resource.id !== undefined ? await this.#api.playlist(resource.id).catch(() => resource) : resource;
      return this.#toPlaylist(playlist, options);
    }
    return this.#toSong(resource, options);
  }

  override async searchSong<T>(query: string, options: ResolveOptions<T>): Promise<Song<T> | null> {
    try {
      const [track] = await this.#api.searchTracks(query, this.#options.searchLimit ?? 1);
      return track ? this.#toSong(track, options) : null;
    } catch (error) {
      this.#debug(`search failed for "${query}": ${errorMessage(error)}`);
      return null;
    }
  }

  override async getStreamURL<T>(song: Song<T>): Promise<string> {
    const track = await this.#track(song.id);
    if (track.policy === "SNIP" && !this.#api.authenticated) {
      this.#warning(
        `snip:${song.id}`,
        `"${song.name ?? song.id}" is SNIP protected: without an oauthToken SoundCloud only serves a 30 second preview.`,
      );
    }
    try {
      return await this.#api.streamUrl(track);
    } catch (error) {
      // The track authorization token may have expired: refetch and retry once.
      this.#tracks.delete(song.id);
      const fresh = await this.#track(song.id);
      if (fresh.track_authorization !== track.track_authorization) return this.#api.streamUrl(fresh);
      throw error;
    }
  }

  override async getRelatedSongs(song: Song): Promise<Song[]> {
    try {
      const tracks = await this.#api.related(song.id, this.#options.relatedLimit ?? 10);
      return tracks.filter((track) => track.title).map((track) => this.#toSong(track));
    } catch (error) {
      this.#debug(`related songs failed for ${song.id}: ${errorMessage(error)}`);
      return [];
    }
  }

  async #track(id: string): Promise<SoundCloudTrack> {
    return this.#tracks.resolve(id, () => this.#api.track(id));
  }

  #toSong<T>(track: SoundCloudTrack, options?: ResolveOptions<T>): Song<T> {
    if (track.id !== undefined) this.#tracks.set(String(track.id), track);
    const durationMs = track.full_duration ?? track.duration;
    return new Song<T>(
      {
        plugin: this,
        source: this.source,
        playFromSource: true,
        id: String(track.id ?? ""),
        name: track.title,
        url: track.permalink_url,
        thumbnail: track.artwork_url ?? undefined,
        duration: durationMs !== undefined ? durationMs / 1000 : undefined,
        views: track.playback_count,
        likes: track.likes_count ?? undefined,
        reposts: track.reposts_count ?? undefined,
        uploader: track.user?.username ? { name: track.user.username, url: track.user.permalink_url } : undefined,
      },
      options,
    );
  }

  #toPlaylist<T>(playlist: SoundCloudPlaylist, options?: ResolveOptions<T>): Playlist<T> {
    return new Playlist<T>(
      {
        source: this.source,
        id: playlist.id !== undefined ? String(playlist.id) : undefined,
        name: playlist.title,
        url: playlist.permalink_url,
        thumbnail: playlist.artwork_url ?? undefined,
        songs: (playlist.tracks ?? []).filter((track) => track.title).map((track) => this.#toSong(track, options)),
      },
      options,
    );
  }

  #debug(message: string): void {
    this.#options.debug?.(`[soundcloud] ${message}`);
  }

  #warning(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    console.warn(`[sonaria-plugins:soundcloud] ${message}`);
  }
}

function isPlaylist(resource: SoundCloudTrack | SoundCloudPlaylist): resource is SoundCloudPlaylist {
  return resource.kind === "playlist";
}

/**
 * Create a SoundCloud plugin.
 *
 * ```ts
 * const plugins = [soundcloud({ oauthToken: process.env.SOUNDCLOUD_TOKEN })];
 * ```
 */
export function soundcloud(options: SoundCloudPluginOptions = {}): SoundCloudPlugin {
  return new SoundCloudPlugin(options);
}

export default soundcloud;
