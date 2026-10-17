/**
 * Full setup: a Seyfert client with Sonaria and the plugin suite.
 *
 * ```bash
 * bun run examples/bot.ts
 * ```
 */
import { Sonaria, voice } from "sonaria";
import { sonariaPlugins } from "sonaria-plugins";
import { Client } from "seyfert";

// `voice()` must be registered on the Seyfert client, otherwise Sonaria cannot
// manage voice connections.
const client = new Client({ plugins: [voice()] });

const sonaria = new Sonaria(client, {
  // The suite resolves links and picks playback automatically; options are
  // only needed for the sources you want to customize.
  plugins: sonariaPlugins({
    youtube: { downloader: "auto" },
    soundcloud: { clientId: process.env.SOUNDCLOUD_CLIENT_ID },
    deezer: {
      arl: process.env.DEEZER_ARL,
      masterDecryptKey: process.env.DEEZER_MDK,
    },
    spotify: {
      clientId: process.env.SPOTIFY_ID,
      clientSecret: process.env.SPOTIFY_SECRET,
    },
    applemusic: { storefront: "us" },
  }),
});

// Your bot: client.start() with your token/events, then commands use
// `sonaria` to create queues and play links from any supported source.

export { client, sonaria };
