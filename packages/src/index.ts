import type { SonariaPlugin } from "sonaria";
import { applemusic, type AppleMusicPluginOptions } from "./applemusic";
import { deezer, type DeezerPluginOptions } from "./deezer";
import { soundcloud, type SoundCloudPluginOptions } from "./soundcloud";
import { spotify, type SpotifyPluginOptions } from "./spotify";
import { youtube, type YouTubePluginOptions } from "./youtube";

export * from "./core";
export * from "./deezer";
export * from "./soundcloud";
export * from "./youtube";
export * from "./spotify";
export * from "./applemusic";

export interface SonariaPluginsOptions {
  /** YouTube extractor options, or `false` to leave it out. */
  youtube?: YouTubePluginOptions | false;
  /** SoundCloud extractor options, or `false` to leave it out. */
  soundcloud?: SoundCloudPluginOptions | false;
  /** Deezer extractor options, or `false` to leave it out. */
  deezer?: DeezerPluginOptions | false;
  /** Spotify info plugin options, or `false` to leave it out. */
  spotify?: SpotifyPluginOptions | false;
  /** Apple Music info plugin options, or `false` to leave it out. */
  applemusic?: AppleMusicPluginOptions | false;
}

/**
 * Create the full plugin list in the recommended registration order.
 *
 * Extractor plugins are registered first; that order also drives the
 * automatic fallback used when an info source (Spotify, Apple Music) resolves
 * playback through the registered extractors. Everything runs automatically —
 * you only pass options for the sources you want to customize.
 *
 * ```ts
 * const sonaria = new Sonaria(client, { plugins: sonariaPlugins() });
 * ```
 */
export function sonariaPlugins(options: SonariaPluginsOptions = {}): SonariaPlugin[] {
  const plugins: SonariaPlugin[] = [];
  if (options.youtube !== false) plugins.push(youtube(options.youtube ?? {}));
  if (options.soundcloud !== false) plugins.push(soundcloud(options.soundcloud ?? {}));
  if (options.deezer !== false) plugins.push(deezer(options.deezer ?? {}));
  if (options.spotify !== false) plugins.push(spotify(options.spotify ?? {}));
  if (options.applemusic !== false) plugins.push(applemusic(options.applemusic ?? {}));
  return plugins;
}

export default sonariaPlugins;
