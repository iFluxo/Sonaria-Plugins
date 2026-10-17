# sonaria-plugins

Plugin suite for [Sonaria](https://www.npmjs.com/package/sonaria) — extended
link resolution and playback for:

- **Deezer**
- **YouTube**
- **SoundCloud**
- **Spotify**
- **Apple Music**

Everything is set up with plain function calls — `youtube()`, `soundcloud()`,
`deezer()`, `spotify()`, `applemusic()` — or all at once with
`sonariaPlugins()`. Zero runtime dependencies, ESM, Node ≥ 24.22 and Bun.

## Install

```bash
bun add sonaria-plugins
# or: npm install sonaria-plugins
```

## Quick start

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

Options only need to be passed for the sources you want to customize —
everything else runs with sensible defaults.

## `sonariaPlugins(options)`

| Option       | Type                               | Description                                          |
| ------------ | ---------------------------------- | ---------------------------------------------------- |
| `youtube`    | `YouTubePluginOptions \| false`    | Video extractor options, `false` to leave it out.    |
| `soundcloud` | `SoundCloudPluginOptions \| false` | SoundCloud extractor options.                        |
| `deezer`     | `DeezerPluginOptions \| false`     | Deezer extractor options.                             |
| `spotify`    | `SpotifyPluginOptions \| false`    | Spotify metadata options.                             |
| `applemusic` | `AppleMusicPluginOptions \| false` | Apple Music metadata options.                         |

```ts
sonariaPlugins({ spotify: false, applemusic: false }); // only the extractors
```

## Factories

Individual function calls, if you prefer to build the list yourself:

```ts
import { deezer, soundcloud, spotify, youtube, applemusic } from "sonaria-plugins";

const plugins = [
  youtube({ downloader: "auto" }),
  soundcloud(),
  deezer({ arl: process.env.DEEZER_ARL }),
  spotify(),
  applemusic(),
];
```

### `youtube(options)`

| Option             | Type                                                    | Default                          | Description                                        |
| ------------------ | ------------------------------------------------------- | -------------------------------- | -------------------------------------------------- |
| `downloader`       | `"auto" \| "direct" \| "download" \| "manual"`          | `"auto"`                         | How audio is obtained.                             |
| `download`         | `(info) => string \| Promise<string>`                   | –                                | Custom downloader for `"manual"` mode.             |
| `ytdlp`            | `YtDlpOptions`                                          | –                                | `path`, `cookiesFromBrowser`, `autoInstall`, `cacheDir`, … |
| `downloadDir`      | `string`                                                | yt-dlp cache                     | Where `"download"` mode stores files.              |
| `cleanupDownloads` | `boolean`                                               | `true`                           | Delete downloaded files after playback.            |
| `format`           | `string`                                                | `"bestaudio[…]`                  | yt-dlp format selector.                            |
| `search`           | `"auto" \| "ytdlp" \| "innertube"`                      | `"auto"`                         | Preferred search backend.                          |
| `playlistLimit`    | `number`                                                | `100`                            | Videos per playlist.                               |
| `searchLimit`      | `number`                                                | `1`                              | Results considered by `searchSong`.                |
| `relatedLimit`     | `number`                                                | `10`                             | Tracks from `getRelatedSongs`.                     |

### `soundcloud(options)`

| Option       | Type     | Default                    | Description                                            |
| ------------ | -------- | -------------------------- | ------------------------------------------------------ |
| `clientId`   | `string` | discovered automatically   | Explicit api-v2 client id.                             |
| `oauthToken` | `string` | –                          | Unlocks full length streams for protected tracks.      |
| `searchLimit`| `number` | `1`                        | Results considered by `searchSong`.                    |
| `relatedLimit`| `number`| `10`                       | Tracks from `getRelatedSongs`.                         |
| `timeout`    | `number` | `15_000`                   | Request timeout in ms.                                 |

### `deezer(options)`

| Option             | Type                          | Default  | Description                                                     |
| ------------------ | ----------------------------- | -------- | --------------------------------------------------------------- |
| `arl`              | `string`                      | –        | Deezer account cookie: full length direct playback.             |
| `masterDecryptKey` | `string`                      | –        | Blowfish key override (derived automatically when omitted).     |
| `quality`          | `DeezerQuality`               | `MP3_128`| Requested stream quality.                                       |
| `mirror`           | `boolean \| MirrorSourceName[]` | `true` | Automatic fallback through other registered extractors.         |
| `previewFallback`  | `boolean`                     | `true`   | Fall back to the 30 second public preview.                      |
| `searchLimit`      | `number`                      | `1`      | Results considered by `searchSong`.                             |
| `artistTracks`     | `number`                      | `50`     | Tracks from the `artist` URL resolver.                          |
| `relatedLimit`     | `number`                      | `10`     | Tracks from `getRelatedSongs`.                                  |
| `requestTimeout`   | `number`                      | `15_000` | Request timeout in ms.                                          |

### `spotify(options)`

| Option          | Type                        | Default         | Description                                        |
| --------------- | --------------------------- | --------------- | -------------------------------------------------- |
| `clientId`      | `string`                    | –               | Spotify app client id (Web API).                   |
| `clientSecret`  | `string`                    | –               | Spotify app client secret (Web API).               |
| `accessToken`   | `string`                    | –               | Ready to use bearer token.                         |
| `embedFallback` | `boolean`                   | `true`          | Read the public embed page when no credentials.    |
| `maxTracks`     | `number`                    | `100`           | Tracks resolved from albums/playlists/artists.     |
| `relatedLimit`  | `number`                    | `10`            | Tracks from `getRelatedSongs`.                     |
| `searchQuery`   | `(song: Song) => string`    | `"<name> <artist>"` | Query used for the automatic playback lookup. |
| `timeout`       | `number`                    | `15_000`        | Request timeout in ms.                             |

### `applemusic(options)`

| Option         | Type                        | Default             | Description                                        |
| -------------- | --------------------------- | ------------------- | -------------------------------------------------- |
| `storefront`   | `string`                    | `"us"`              | Storefront used for page URLs (`us`, `id`, …).     |
| `maxTracks`    | `number`                    | `100`               | Tracks resolved from albums/playlists/artists.     |
| `relatedLimit` | `number`                    | `10`                | Tracks from `getRelatedSongs`.                     |
| `searchQuery`  | `(song: Song) => string`    | `"<name> <artist>"` | Query used for the automatic playback lookup.      |
| `timeout`      | `number`                    | `15_000`            | Request timeout in ms.                             |

## How playback works

1. A link is resolved by the matching plugin, returning a `Song`/`Playlist`
   with that source's metadata.
2. Extractor sources provide the audio themselves.
3. Sources that cannot stream directly are played automatically: Sonaria
   queries the registered extractor plugins (in registration order) with the
   original title/artist and keeps showing the original metadata while the
   audio plays.

No extra configuration is needed for that fallback — it uses whatever
extractor plugins are registered.

## Supported links

```
YouTube      https://www.youtube.com/watch?v=<id>   youtu.be/<id>   /playlist?list=<id>
SoundCloud   https://soundcloud.com/<user>/<track>  /sets/<playlist>
Deezer       https://www.deezer.com/track/<id>      /album/<id>  /playlist/<id>  /artist/<id>
Spotify      https://open.spotify.com/track|album|playlist|artist/<id>  spotify:<type>:<id>
Apple Music  https://music.apple.com/<country>/album|song|playlist|artist/…
```

## Notes

- **Deezer** works without an `arl` through previews/fallbacks; an ARL unlocks
  full length direct streaming.
- **SoundCloud** works without credentials; `oauthToken` unlocks tracks that
  are otherwise limited to a 30 second preview.
- **Spotify** works without credentials through the public embed page; app
  credentials unlock paginated albums/playlists and exact data.
- **Apple Music** needs no credentials: tracks/albums come from the public
  iTunes lookup API, playlists/artist top songs from the web page data.
- **YouTube** playback uses `yt-dlp` when available, can auto-install it, and
  can be replaced with your own `download` callback.

## License

MIT © Fluxo
