/** Deezer resource kinds handled by the plugin. */
export type DeezerResourceType = "track" | "album" | "playlist" | "artist";

export interface DeezerUrl {
  type: DeezerResourceType;
  id: string;
}

const DEEZER_URL = /^https?:\/\/(?:www\.|m\.)?deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(track|album|playlist|artist)\/(\d+)(?:[/?#].*)?$/iu;

/** Parse a `deezer.com` URL into its resource type and id. */
export function parseDeezerUrl(url: string): DeezerUrl | null {
  const match = DEEZER_URL.exec(url.trim());
  const type = match?.[1]?.toLowerCase() as DeezerResourceType | undefined;
  const id = match?.[2];
  if (!type || !id) return null;
  return { type, id };
}

/** Check whether a URL points at a Deezer resource. */
export function isDeezerUrl(url: string): boolean {
  return parseDeezerUrl(url) !== null;
}
