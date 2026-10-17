import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExtractorPlugin, Playlist, Song, type ResolveOptions } from "sonaria";
import { createYtDlp, errorMessage, SonariaPluginsError, TimedCache, type YtDlp, type YtDlpInfo, type YtDlpOptions } from "../core";
import { Innertube, type InnertubeOptions, type YouTubeVideoDetails } from "./innertube";
import { isYouTubeUrl, parseYouTubeUrl } from "./url";

export * from "./innertube";
export * from "./url";

/** How the plugin obtains playable audio. */
export type YouTubeDownloaderMode =
  /** yt-dlp direct URL, falling back to a download (default). */
  | "auto"
  /** yt-dlp `info.url` (a temporary googlevideo URL). */
  | "direct"
  /** yt-dlp download to a local file exposed as a `file://` URL. */
  | "download"
  /** Your own callback, e.g. a private API or an existing file. */
  | "manual";

export interface YouTubeManualDownloadInfo {
  /** YouTube video id. */
  id: string;
  /** `https://www.youtube.com/watch?v=<id>`. */
  url: string;
  /** The song that is being streamed. */
  song: Song;
}

/** Return an absolute file path, a `file://` URL or an http(s) URL. */
export type YouTubeManualDownloader = (info: YouTubeManualDownloadInfo) => string | Promise<string>;

export interface YouTubePluginOptions {
  /** How audio is obtained. Defaults to `"auto"`. */
  downloader?: YouTubeDownloaderMode;
  /** Download callback used with `downloader: "manual"`. */
  download?: YouTubeManualDownloader;
  /** yt-dlp options: `path`, `cookiesFromBrowser`, `autoInstall`, `cacheDir`, … */
  ytdlp?: YtDlpOptions;
  /** Where `downloader: "download"` stores files. Defaults to the yt-dlp cache. */
  downloadDir?: string;
  /** Delete downloaded files after playback. Defaults to `true`. */
  cleanupDownloads?: boolean;
  /** How long downloads are kept when `cleanupDownloads` is enabled, in ms. Defaults to 30 minutes. */
  downloadTtlMs?: number;
  /** yt-dlp format selector. Defaults to `"bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best"`. */
  format?: string;
  /** Enables the Innertube fallback (metadata, search, playlists). Defaults to `true`. */
  innertube?: boolean | InnertubeOptions;
  /** Preferred search backend. Defaults to `"auto"` (yt-dlp, then Innertube). */
  search?: "auto" | "ytdlp" | "innertube";
  /** Videos returned when resolving a playlist. Defaults to `100`. */
  playlistLimit?: number;
  /** Results considered by `searchSong`. Defaults to `1`. */
  searchLimit?: number;
  /** Tracks returned by `getRelatedSongs`. Defaults to `10`. */
  relatedLimit?: number;
  /** Verbose logging hook. */
  debug?: (message: string) => void;
}

const WATCH_URL = "https://www.youtube.com/watch?v=";
const PLAYLIST_URL = "https://www.youtube.com/playlist?list=";

/**
 * YouTube extractor plugin for Sonaria.
 *
 * Playback is delegated to **yt-dlp** (direct URL or download) or to your own
 * `download` callback — the plugin itself never has to deal with YouTube's
 * signature deciphering. Without yt-dlp, Innertube/HTML metadata is still used
 * for search, video and playlist lookups, and `searchSong` politely returns
 * `null` so the next plugin in the mirror chain can answer.
 */
export class YouTubePlugin extends ExtractorPlugin {
  readonly source = "youtube";

  readonly #options: YouTubePluginOptions;
  readonly #ytdlp: YtDlp;
  readonly #streams = new TimedCache<string, string>(6 * 60_000, 256);
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #innertubeInstance?: Innertube;

  constructor(options: YouTubePluginOptions = {}) {
    super();
    this.#options = options;
    this.#ytdlp = createYtDlp(options.ytdlp);
  }

  /** The yt-dlp wrapper used by this plugin. */
  get ytdlp(): YtDlp {
    return this.#ytdlp;
  }

  /** Stop pending cleanup timers (call when shutting the bot down). */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  override async validate(url: string): Promise<boolean> {
    return isYouTubeUrl(url);
  }

  override async resolve<T>(url: string, options: ResolveOptions<T>): Promise<Song<T> | Playlist<T>> {
    const parsed = parseYouTubeUrl(url);
    if (!parsed) throw new SonariaPluginsError("YOUTUBE_INVALID_URL", `Not a supported YouTube URL: ${url}`);
    if (parsed.type === "playlist") return this.#playlist(parsed.listId ?? "", options);
    return this.#video(parsed.videoId ?? "", options);
  }

  override async searchSong<T>(query: string, options: ResolveOptions<T>): Promise<Song<T> | null> {
    if (!(await this.#playable())) return null;
    try {
      const [video] = await this.#searchVideos(query, this.#options.searchLimit ?? 1);
      return video ? this.#toSong(video, options) : null;
    } catch (error) {
      this.#debug(`search failed for "${query}": ${errorMessage(error)}`);
      return null;
    }
  }

  override async getStreamURL<T>(song: Song<T>): Promise<string> {
    const cached = this.#streams.get(song.id);
    if (cached) return cached;
    const url = await this.#obtainStream(song);
    this.#streams.set(song.id, url);
    return url;
  }

  override async getRelatedSongs(song: Song): Promise<Song[]> {
    if (!(await this.#ytdlp.available())) return [];
    const limit = this.#options.relatedLimit ?? 10;
    try {
      const info = await this.#ytdlp.json(`${WATCH_URL}${song.id}&list=RD${song.id}`, {
        playlist: true,
        format: this.#format(),
        extraArgs: ["--flat-playlist", "--playlist-end", String(limit + 1)],
      });
      return (info.entries ?? [])
        .filter((entry) => entry.id && entry.id !== song.id)
        .slice(0, limit)
        .map((entry) => this.#fromYtDlp(entry));
    } catch (error) {
      this.#debug(`related songs failed for ${song.id}: ${errorMessage(error)}`);
      return [];
    }
  }

  async #video<T>(id: string, options?: ResolveOptions<T>): Promise<Song<T>> {
    if (await this.#ytdlp.available()) {
      const info = await this.#ytdlp.json(`${WATCH_URL}${id}`, { format: this.#format(), extraArgs: ["--no-playlist"] });
      return this.#fromYtDlp(info, options);
    }
    if (!this.#canPlay()) {
      throw new SonariaPluginsError(
        "YOUTUBE_NO_DOWNLOADER",
        "Cannot play YouTube videos: yt-dlp is not installed (enable `ytdlp.autoInstall` or point `ytdlp.path` at the binary) and no manual downloader is configured.",
      );
    }
    return this.#toSong(await this.#innertubeClient().video(id), options);
  }

  async #playlist<T>(id: string, options?: ResolveOptions<T>): Promise<Playlist<T>> {
    const limit = this.#options.playlistLimit ?? 100;
    if (await this.#ytdlp.available()) {
      const info = await this.#ytdlp.json(`${PLAYLIST_URL}${id}`, {
        playlist: true,
        format: this.#format(),
        extraArgs: ["--flat-playlist", "--playlist-end", String(limit)],
      });
      return new Playlist<T>(
        {
          source: this.source,
          id,
          name: info.title ?? info.fulltitle,
          url: info.webpage_url ?? `${PLAYLIST_URL}${id}`,
          thumbnail: thumbnailOf(info),
          songs: (info.entries ?? []).filter((entry) => entry.id).map((entry) => this.#fromYtDlp(entry, options)),
        },
        options,
      );
    }
    if (!this.#canPlay()) {
      throw new SonariaPluginsError("YOUTUBE_NO_DOWNLOADER", "Cannot resolve YouTube playlists: yt-dlp is not installed and no manual downloader is configured.");
    }
    const details = await this.#innertubeClient().playlist(id, limit);
    return new Playlist<T>(
      {
        source: this.source,
        id,
        name: details.title,
        url: `${PLAYLIST_URL}${id}`,
        thumbnail: details.videos[0]?.thumbnail,
        songs: details.videos.map((video) => this.#toSong(video, options)),
      },
      options,
    );
  }

  async #searchVideos(query: string, limit: number): Promise<YouTubeVideoDetails[]> {
    const mode = this.#options.search ?? "auto";
    if (mode !== "innertube" && (mode === "ytdlp" || (await this.#ytdlp.available()))) {
      const entries = await this.#ytdlp.search(query, limit);
      return entries.map((entry) => detailsOf(entry));
    }
    return this.#innertubeClient().search(query, limit);
  }

  async #obtainStream(song: Song): Promise<string> {
    const mode = this.#options.downloader ?? "auto";
    if (mode === "manual") return this.#manualStream(song);
    if (mode === "download") return this.#downloadStream(song);
    if (mode === "direct") return this.#directStream(song);
    try {
      return await this.#directStream(song);
    } catch (error) {
      this.#debug(`direct stream failed for ${song.id} (${errorMessage(error)}), downloading instead`);
      return this.#downloadStream(song);
    }
  }

  async #directStream(song: Song): Promise<string> {
    const info = await this.#ytdlp.json(`${WATCH_URL}${song.id}`, { format: this.#format(), extraArgs: ["--no-playlist"] });
    const url = directUrlOf(info);
    if (!url) {
      throw new SonariaPluginsError(
        "YOUTUBE_NO_DIRECT_URL",
        `yt-dlp returned no direct audio URL for ${song.id} (the selected format is probably a merged stream). Use \`downloader: "download"\` instead.`,
      );
    }
    return url;
  }

  async #downloadStream(song: Song): Promise<string> {
    const dir = this.#options.downloadDir ?? path.join(this.#ytdlp.cacheDir, "downloads");
    const file = await this.#ytdlp.download(`${WATCH_URL}${song.id}`, { dir, filename: song.id, format: this.#format() });
    if (this.#options.cleanupDownloads !== false) this.#scheduleCleanup(file);
    return pathToFileURL(file).toString();
  }

  async #manualStream(song: Song): Promise<string> {
    const download = this.#options.download;
    if (!download) {
      throw new SonariaPluginsError("YOUTUBE_MANUAL_DOWNLOAD", 'The YouTube plugin uses `downloader: "manual"` but no `download` callback was provided.');
    }
    const result = await download({ id: song.id, url: `${WATCH_URL}${song.id}`, song });
    if (!result) throw new SonariaPluginsError("YOUTUBE_MANUAL_DOWNLOAD", `The manual download callback returned nothing for ${song.id}.`);
    const scheme = /^([a-z][\w+.-]*):/iu.exec(result)?.[1]?.toLowerCase();
    if (scheme === "http" || scheme === "https" || scheme === "file" || scheme === "data") return result;
    return pathToFileURL(path.resolve(result)).toString();
  }

  #scheduleCleanup(file: string): void {
    const ttl = this.#options.downloadTtlMs ?? 30 * 60_000;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#ytdlp.remove(file);
    }, ttl);
    timer.unref?.();
    this.#timers.add(timer);
  }

  async #playable(): Promise<boolean> {
    return (await this.#ytdlp.available()) || this.#canPlay();
  }

  #canPlay(): boolean {
    return (this.#options.downloader ?? "auto") === "manual" && typeof this.#options.download === "function";
  }

  #innertubeClient(): Innertube {
    if (this.#options.innertube === false) {
      throw new SonariaPluginsError("YOUTUBE_INNERTUBE_DISABLED", "The Innertube fallback is disabled and yt-dlp is not available.");
    }
    const options = typeof this.#options.innertube === "object" ? this.#options.innertube : {};
    this.#innertubeInstance ??= new Innertube(options);
    return this.#innertubeInstance;
  }

  #format(): string {
    return this.#options.format ?? "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best";
  }

  #toSong<T>(video: YouTubeVideoDetails, options?: ResolveOptions<T>): Song<T> {
    return new Song<T>(
      {
        plugin: this,
        source: this.source,
        playFromSource: true,
        id: video.id,
        name: video.title,
        url: `${WATCH_URL}${video.id}`,
        thumbnail: video.thumbnail ?? `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`,
        duration: video.duration,
        views: video.views,
        isLive: video.isLive,
        uploader: video.author ? { name: video.author } : undefined,
      },
      options,
    );
  }

  #fromYtDlp<T>(info: YtDlpInfo, options?: ResolveOptions<T>): Song<T> {
    const id = info.id ?? "";
    return new Song<T>(
      {
        plugin: this,
        source: this.source,
        playFromSource: true,
        id,
        name: info.title ?? info.fulltitle,
        url: info.webpage_url ?? (id ? `${WATCH_URL}${id}` : undefined),
        thumbnail: thumbnailOf(info),
        duration: info.duration,
        views: info.view_count,
        likes: info.like_count,
        dislikes: info.dislike_count,
        isLive: Boolean(info.is_live),
        uploader: info.uploader ?? info.channel ? { name: info.uploader ?? info.channel, url: info.uploader_url ?? info.channel_url } : undefined,
      },
      options,
    );
  }

  #debug(message: string): void {
    this.#options.debug?.(`[youtube] ${message}`);
  }
}

function thumbnailOf(info: YtDlpInfo): string | undefined {
  const thumbnails = info.thumbnails ?? [];
  const best = [...thumbnails].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
  return best?.url ?? info.thumbnail;
}

function directUrlOf(info: YtDlpInfo): string | undefined {
  if (info.url) return info.url;
  const formats = info.requested_formats ?? [];
  return formats.find((format) => format.url && format.vcodec === "none")?.url ?? formats.find((format) => format.url)?.url;
}

function detailsOf(info: YtDlpInfo): YouTubeVideoDetails {
  return {
    id: info.id ?? "",
    title: info.title ?? info.fulltitle,
    author: info.uploader ?? info.channel,
    duration: info.duration,
    views: info.view_count,
    isLive: info.is_live,
    thumbnail: thumbnailOf(info),
  };
}

/**
 * Create a YouTube plugin.
 *
 * ```ts
 * const plugins = [youtube({ ytdlp: { autoInstall: true } })];
 * // or bring your own downloader:
 * const plugins = [youtube({ downloader: "manual", download: ({ id }) => `/music/${id}.opus` })];
 * ```
 */
export function youtube(options: YouTubePluginOptions = {}): YouTubePlugin {
  return new YouTubePlugin(options);
}

export default youtube;
