/**
 * Individual function-call setups.
 *
 * Every source is created by calling its factory: `youtube()`, `soundcloud()`,
 * `deezer()`, `spotify()`, `applemusic()`.
 */
import {
  applemusic,
  deezer,
  soundcloud,
  sonariaPlugins,
  spotify,
  youtube,
} from "sonaria-plugins";

/** Manual list. Automatic fallbacks follow the plugin registration order. */
export const plugins = [
  youtube({ downloader: "auto" }),
  soundcloud(),
  deezer({ arl: process.env.DEEZER_ARL }),
  spotify({
    clientId: process.env.SPOTIFY_ID,
    clientSecret: process.env.SPOTIFY_SECRET,
  }),
  applemusic(),
];

/** Same thing through the helper, which fills in the recommended defaults. */
export const suite = sonariaPlugins({
  deezer: { arl: process.env.DEEZER_ARL },
  spotify: {
    clientId: process.env.SPOTIFY_ID,
    clientSecret: process.env.SPOTIFY_SECRET,
  },
});

/** Skip what you do not need by passing `false`. */
export const extractorsOnly = sonariaPlugins({
  spotify: false,
  applemusic: false,
});
