import { fetchJson, fetchText, SonariaPluginsError } from "../core";

export interface YouTubeVideoDetails {
  id: string;
  title?: string;
  author?: string;
  duration?: number;
  views?: number;
  thumbnail?: string;
  isLive?: boolean;
}

export interface YouTubePlaylistDetails {
  id: string;
  title?: string;
  videos: YouTubeVideoDetails[];
}

export interface InnertubeOptions {
  /** Innertube API key. Defaults to the public web key. */
  key?: string;
  /** Client version sent with every request. */
  clientVersion?: string;
  /** Request timeout in ms. Defaults to `15_000`. */
  timeout?: number;
}

const DEFAULT_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const DEFAULT_CLIENT_VERSION = "2.20250101.00.00";
const API = "https://www.youtube.com/youtubei/v1";
const WATCH_URL = "https://www.youtube.com/watch?v=";
const PLAYLIST_URL = "https://www.youtube.com/playlist?list=";

/* TypeScript port of the loose JSON shapes YouTube returns. */
type Any = any;

function pick(source: Any, ...keys: Array<string | number>): Any {
  let current: Any = source;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function asList(value: Any): Any[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: Any): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

/** `"4:02"`, `"1:02:03"` and `"242"` to seconds. */
export function parseDurationText(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (/^\d+(\.\d+)?$/u.test(text)) return Math.round(Number(text));
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/u.exec(text);
  if (!match) return undefined;
  const [, hours, minutes, seconds] = match;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/** `"1.2M views"`, `"2,345"` to a number. */
export function parseCountText(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /([\d.,]+)\s*([KMB])?/iu.exec(value.replace(/\u00a0/gu, " "));
  if (!match?.[1]) return undefined;
  const base = Number(match[1].replace(/,/gu, ""));
  if (!Number.isFinite(base)) return undefined;
  const scale = { k: 1_000, m: 1_000_000, b: 1_000_000_000 }[match[2]?.toLowerCase() ?? ""] ?? 1;
  return Math.round(base * scale);
}

/**
 * Extract a JSON object that follows `marker` inside an HTML page.
 * String and escape aware brace matching, so nested objects and `"}` in
 * strings do not break the scan.
 */
export function extractJson(html: string, marker: string): Any {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const begin = html.indexOf("{", start + marker.length);
  if (begin < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = begin; index < html.length; index++) {
    const character = html[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth++;
    else if (character === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(begin, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function tokenOf(value: Any): string | undefined {
  const token =
    pick(value, "continuationItemRenderer", "continuationEndpoint", "continuationCommand", "token") ??
    pick(value, "continuationItemViewModel", "continuationCommand", "innertubeCommand", "continuationCommand", "token") ??
    pick(value, "continuationCommand", "token");
  return typeof token === "string" ? token : undefined;
}

function continuationItems(response: Any): Any[] {
  const actions = [...asList(pick(response, "onResponseReceivedActions")), ...asList(pick(response, "onResponseReceivedCommands"))];
  const items: Any[] = [];
  for (const action of actions) {
    items.push(...asList(pick(action, "appendContinuationItemsAction", "continuationItems")));
    items.push(...asList(pick(action, "reloadContinuationItemsCommand", "continuationItems")));
  }
  return items;
}

function thumbnailsOf(value: Any): string | undefined {
  const list = asList(value);
  const last = list.at(-1);
  return typeof last?.url === "string" ? last.url : undefined;
}

function videoFromRenderer(renderer: Any): YouTubeVideoDetails {
  const id = String(pick(renderer, "videoId") ?? "");
  return {
    id,
    title: pick(renderer, "title", "runs", 0, "text"),
    author: pick(renderer, "ownerText", "runs", 0, "text") ?? pick(renderer, "longBylineText", "runs", 0, "text"),
    duration: parseDurationText(pick(renderer, "lengthText", "simpleText")),
    views: parseCountText(pick(renderer, "viewCountText", "simpleText")),
    thumbnail: thumbnailsOf(pick(renderer, "thumbnail", "thumbnails")) ?? (id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined),
    isLive: asList(pick(renderer, "badges")).some((badge) => pick(badge, "metadataBadgeRenderer", "style") === "BADGE_STYLE_TYPE_LIVE_NOW"),
  };
}

/** Playlists now render items as `lockupViewModel`. */
function videoFromLockup(lockup: Any): YouTubeVideoDetails {
  const id = String(pick(lockup, "contentId") ?? "");
  const rows = asList(pick(lockup, "metadata", "lockupMetadataViewModel", "metadata", "contentMetadataViewModel", "metadataRows"));
  const author = asList(pick(rows, 0, "metadataParts"))
    .map((part) => pick(part, "text", "content"))
    .filter((value) => typeof value === "string")
    .join(" ");
  const badges = asList(pick(lockup, "contentImage", "thumbnailViewModel", "overlays", 0, "thumbnailBottomOverlayViewModel", "badges"));
  const durationText = pick(badges, 0, "thumbnailBadgeViewModel", "text");
  return {
    id,
    title: pick(lockup, "metadata", "lockupMetadataViewModel", "title", "content"),
    author: author || undefined,
    duration: parseDurationText(typeof durationText === "string" ? durationText : undefined),
    thumbnail: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : undefined,
  };
}

/**
 * Small, dependency free YouTube client for the pieces yt-dlp cannot help with
 * when it is not installed: search results, video metadata (watch page /
 * oEmbed) and playlists (browse page + `lockupViewModel`s).
 *
 * Playback is intentionally out of scope: YouTube's player requires signature
 * deciphering, so the plugin uses yt-dlp (or a manual downloader) for streams.
 */
export class Innertube {
  readonly #key: string;
  readonly #clientVersion: string;
  readonly timeout: number;

  constructor(options: InnertubeOptions = {}) {
    this.#key = options.key ?? DEFAULT_KEY;
    this.#clientVersion = options.clientVersion ?? DEFAULT_CLIENT_VERSION;
    this.timeout = options.timeout ?? 15_000;
  }

  /** Search YouTube and return up to `limit` videos. */
  async search(query: string, limit = 1): Promise<YouTubeVideoDetails[]> {
    const first = await this.#post("search", { query });
    const sections = asList(pick(first, "contents", "twoColumnSearchResultsRenderer", "primaryContents", "sectionListRenderer", "contents"));
    const videos: YouTubeVideoDetails[] = [];
    let token: string | undefined;
    for (const section of sections) {
      for (const item of asList(pick(section, "itemSectionRenderer", "contents"))) {
        const renderer = pick(item, "videoRenderer");
        if (renderer) videos.push(videoFromRenderer(renderer));
        token ??= tokenOf(item);
      }
      token ??= tokenOf(section);
    }
    while (videos.length < limit && token) {
      const response = await this.#post("search", { continuation: token });
      token = undefined;
      for (const item of continuationItems(response)) {
        const direct = pick(item, "videoRenderer");
        if (direct) videos.push(videoFromRenderer(direct));
        for (const entry of asList(pick(item, "itemSectionRenderer", "contents"))) {
          const renderer = pick(entry, "videoRenderer");
          if (renderer) videos.push(videoFromRenderer(renderer));
        }
        token ??= tokenOf(item);
      }
    }
    return videos.filter((video) => video.id).slice(0, Math.max(1, limit));
  }

  /** Video metadata from the watch page, falling back to oEmbed. */
  async video(id: string): Promise<YouTubeVideoDetails> {
    const html = await fetchText(WATCH_URL + id, { timeout: this.timeout }).catch(() => "");
    const details = pick(extractJson(html, "ytInitialPlayerResponse ="), "videoDetails");
    if (details?.videoId) {
      return {
        id: String(details.videoId),
        title: details.title,
        author: details.author,
        duration: details.isLive ? undefined : asNumber(details.lengthSeconds),
        views: asNumber(details.viewCount),
        thumbnail: thumbnailsOf(pick(details, "thumbnail", "thumbnails")) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        isLive: Boolean(details.isLive),
      };
    }
    const oembed = await fetchJson<{ title?: string; author_name?: string; thumbnail_url?: string }>(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(WATCH_URL + id)}&format=json`,
      { timeout: this.timeout },
    ).catch(() => null);
    if (!oembed) throw new SonariaPluginsError("YOUTUBE_NOT_FOUND", `Cannot load YouTube video ${id}.`);
    return {
      id,
      title: oembed.title,
      author: oembed.author_name,
      thumbnail: oembed.thumbnail_url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }

  /** Playlist metadata and videos from the browse page. */
  async playlist(id: string, limit = 100): Promise<YouTubePlaylistDetails> {
    const html = await fetchText(PLAYLIST_URL + id, { timeout: this.timeout });
    const data = extractJson(html, "ytInitialData =");
    if (!data) throw new SonariaPluginsError("YOUTUBE_NOT_FOUND", `Cannot load YouTube playlist ${id}.`);

    const sections = asList(pick(data, "contents", "twoColumnBrowseResultsRenderer", "tabs", 0, "tabRenderer", "content", "sectionListRenderer", "contents"));
    const lockups = asList(pick(sections, 0, "itemSectionRenderer", "contents"))
      .map((item) => pick(item, "lockupViewModel"))
      .filter(Boolean);
    const videos = lockups.map((lockup) => videoFromLockup(lockup));
    let token = sections.map((section) => tokenOf(section)).find(Boolean);
    while (videos.length < limit && token) {
      const response = await this.#post("browse", { continuation: token });
      token = undefined;
      for (const item of continuationItems(response)) {
        const lockup = pick(item, "lockupViewModel");
        if (lockup) videos.push(videoFromLockup(lockup));
        token ??= tokenOf(item);
      }
    }
    return {
      id,
      title: pick(data, "metadata", "playlistMetadataRenderer", "title"),
      videos: videos.filter((video) => video.id).slice(0, Math.max(1, limit)),
    };
  }

  async #post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return fetchJson<T>(`${API}/${path}?key=${this.#key}&prettyPrint=false`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://www.youtube.com" },
      body: JSON.stringify({ context: this.#context(), ...body }),
      timeout: this.timeout,
    });
  }

  #context(): Record<string, unknown> {
    return { client: { clientName: "WEB", clientVersion: this.#clientVersion, hl: "en", gl: "US" } };
  }
}
