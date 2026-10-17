import { createHash } from "node:crypto";

/**
 * Secret used by Deezer to derive the per-track Blowfish key.
 * The pattern is public knowledge from the community downloader ecosystem.
 */
export const DEEZER_BLOWFISH_SECRET = "g4el58wc0zvf9na1";

/**
 * Derive the Blowfish key Deezer uses for `BF_CBC_STRIPE` files.
 *
 * `key[i] = md5(trackId)[i] ^ md5(trackId)[i + 16] ^ secret[i]`
 */
export function deriveDeezerBlowfishKey(trackId: string | number): Uint8Array {
  const md5 = createHash("md5").update(String(trackId)).digest("hex");
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = md5.charCodeAt(i) ^ md5.charCodeAt(i + 16) ^ DEEZER_BLOWFISH_SECRET.charCodeAt(i);
  }
  return key;
}

/**
 * Parse the optional `masterDecryptKey`.
 *
 * - A 32 character hex string (spaces, dashes and colons ignored) is used as-is.
 * - Anything else is treated as text and padded/truncated to 16 bytes.
 *
 * When omitted the plugin derives the standard per-track key through
 * {@link deriveDeezerBlowfishKey}.
 */
export function parseMasterDecryptKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) throw new RangeError("masterDecryptKey must not be empty");
  const hex = trimmed.replace(/[\s:-]/gu, "");
  if (/^[0-9a-f]{32}$/iu.test(hex)) {
    const key = new Uint8Array(16);
    for (let i = 0; i < 16; i++) key[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return key;
  }
  const bytes = new TextEncoder().encode(trimmed);
  const key = new Uint8Array(16);
  key.set(bytes.subarray(0, 16));
  return key;
}
