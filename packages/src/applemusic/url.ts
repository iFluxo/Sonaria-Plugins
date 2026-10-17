export type AppleMusicResourceType = "track" | "album" | "playlist" | "artist";

export interface AppleMusicUrl {
  type: AppleMusicResourceType;
  id: string;
  /** Album id when the link points at a track inside an album (`?i=`). */
  albumId?: string;
  /** Storefront from the URL (`us`, `id`, `en-gb`, …). */
  storefront?: string;
}

const STOREFRONT = /^[a-z]{2}(?:-[a-z]{2})?$/iu;

/**
 * Parse an Apple Music URL.
 *
 * ```
 * /us/album/<slug>/<id>            → album
 * /us/album/<slug>/<id>?i=<trackId> → track (albumId kept)
 * /us/song/<slug>/<id>             → track
 * /us/playlist/<slug>/pl.<hash>    → playlist
 * /us/artist/<slug>/<id>           → artist
 * ```
 *
 * The storefront segment is optional.
 */
export function parseAppleMusicUrl(input: string): AppleMusicUrl | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "music.apple.com" && host !== "geo.music.apple.com") return null;

  const segments = url.pathname.split("/").filter(Boolean);
  let storefront: string | undefined;
  if (segments[0] && STOREFRONT.test(segments[0])) storefront = segments.shift();
  const kind = segments.shift()?.toLowerCase();
  const id = segments.at(-1);
  if (!kind || !id) return null;

  const trackId = url.searchParams.get("i") ?? undefined;
  if (kind === "song") return /^\d+$/u.test(id) ? { type: "track", id, storefront } : null;
  if (kind === "album") {
    if (!/^\d+$/u.test(id)) return null;
    if (trackId && /^\d+$/u.test(trackId)) return { type: "track", id: trackId, albumId: id, storefront };
    return { type: "album", id, storefront };
  }
  if (kind === "playlist") return /^pl\.[a-z0-9]+$/iu.test(id) ? { type: "playlist", id, storefront } : null;
  if (kind === "artist") return /^\d+$/u.test(id) ? { type: "artist", id, storefront } : null;
  return null;
}

/** Whether the input is a supported Apple Music URL. */
export function isAppleMusicUrl(input: string): boolean {
  return parseAppleMusicUrl(input) !== null;
}
