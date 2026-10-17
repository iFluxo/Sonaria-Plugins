export type YouTubeResourceType = "video" | "playlist";

export interface YouTubeUrl {
  type: YouTubeResourceType;
  videoId?: string;
  listId?: string;
}

const VIDEO_ID = /^[\w-]{11}$/u;
const VIDEO_PATH = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/u;

function listOf(url: URL): string | undefined {
  return url.searchParams.get("list") ?? undefined;
}

/**
 * Parse a YouTube URL into a video or playlist reference.
 *
 * Supports `watch?v=`, `youtu.be`, `shorts`, `embed`, `live`, `v/` and
 * `playlist?list=` on `youtube.com`, `m.youtube.com` and `music.youtube.com`.
 */
export function parseYouTubeUrl(input: string): YouTubeUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./u, "");
  const list = listOf(url);

  if (host === "youtu.be") {
    const id = url.pathname.split("/")[1] ?? "";
    return VIDEO_ID.test(id) ? { type: "video", videoId: id, listId: list } : null;
  }
  if (host !== "youtube.com" && host !== "m.youtube.com" && host !== "music.youtube.com") return null;

  if (url.pathname === "/watch") {
    const id = url.searchParams.get("v") ?? "";
    if (VIDEO_ID.test(id)) return { type: "video", videoId: id, listId: list };
    return list ? { type: "playlist", listId: list } : null;
  }
  if (url.pathname === "/playlist") {
    return list ? { type: "playlist", listId: list } : null;
  }
  const match = VIDEO_PATH.exec(url.pathname);
  return match?.[1] ? { type: "video", videoId: match[1], listId: list } : null;
}

/** Whether the URL is a supported YouTube URL. */
export function isYouTubeUrl(url: string): boolean {
  return parseYouTubeUrl(url) !== null;
}
