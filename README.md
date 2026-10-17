# Sonaria-Plugins

Plugin suite for [Sonaria](https://www.npmjs.com/package/sonaria) — extended
link resolution and playback for Deezer, YouTube, SoundCloud, Spotify and
Apple Music.

Every source is set up with a plain function call, or all at once:

```ts
import { Sonaria, voice } from "sonaria";
import { sonariaPlugins } from "sonaria-plugins";
import { Client } from "seyfert";

const client = new Client({ plugins: [voice()] });

const sonaria = new Sonaria(client, {
  plugins: sonariaPlugins({
    deezer: { arl: process.env.DEEZER_ARL },
    spotify: { clientId: process.env.SPOTIFY_ID, clientSecret: process.env.SPOTIFY_SECRET },
  }),
});
```

```ts
import { deezer, soundcloud, spotify, youtube, applemusic } from "sonaria-plugins";
```

Extractor sources play audio themselves; sources that only provide metadata
(Spotify, Apple Music) keep their original metadata and are played
automatically through the registered extractors — no extra configuration.

See the full documentation in
[`packages/README.md`](packages/README.md).

## License

MIT © Fluxo
