import type { ResolveOptions, Song } from "sonaria";

/** A value that may be returned synchronously or through a promise. */
export type Awaitable<T> = T | PromiseLike<T>;

/**
 * Mirror source names natively understood by this plugin suite.
 *
 * The automatic resolution order follows the plugin registration order.
 */
export type MirrorSourceName = "deezer" | "youtube" | "soundcloud";

/**
 * The minimal shape every extractor plugin of this suite exposes so mirror
 * fallbacks can search a query and resolve a playable stream from it.
 */
export interface SourcePlugin {
  /** Stable identifier of the source, e.g. `"youtube"`. */
  readonly source: string;
  /** Search a playable song on this source. Returns `null` when nothing was found. */
  searchSong(query: string, options: ResolveOptions): Awaitable<Song | null>;
  /** Resolve the actual stream URL of a song created by this plugin. */
  getStreamURL(song: Song): Awaitable<string>;
}

/** Result of a successful mirror lookup. */
export interface MirrorSearchResult {
  /** Source name that answered the query, e.g. `"youtube"`. */
  source: string;
  /** The plugin instance that created {@link song}. */
  plugin: SourcePlugin;
  /** A song that can be played through {@link plugin}. */
  song: Song;
}
