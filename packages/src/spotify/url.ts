export type SpotifyResourceType = "track" | "album" | "playlist" | "artist";

export interface SpotifyUrl {
  type: SpotifyResourceType;
  id: string;
}

const ID = "([a-zA-Z0-9]{22})";
const URL_PATTERN = new RegExp(`^https?://open\\.spotify\\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(track|album|playlist|artist)/${ID}`, "iu");
const URI_PATTERN = new RegExp(`^spotify:(track|album|playlist|artist):${ID}$`, "u");

/**
 * Parse a Spotify URL or URI (`spotify:track:<id>`) into its resource type
 * and id. `open.spotify.com/intl-<locale>/…` links are supported as well.
 */
export function parseSpotifyUrl(input: string): SpotifyUrl | null {
  const value = input.trim();
  const uri = URI_PATTERN.exec(value);
  if (uri?.[1] && uri[2]) return { type: uri[1].toLowerCase() as SpotifyResourceType, id: uri[2] };
  const match = URL_PATTERN.exec(value);
  const type = match?.[1]?.toLowerCase() as SpotifyResourceType | undefined;
  const id = match?.[2];
  return type && id ? { type, id } : null;
}

/** Whether the input is a supported Spotify URL or URI. */
export function isSpotifyUrl(input: string): boolean {
  return parseSpotifyUrl(input) !== null;
}
