import path from "node:path";
import { pathToFileURL } from "node:url";

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Whether the input already is an absolute URL (`http://`, `file://`, …). */
export function isUrl(input: string): boolean {
  if (!URL_LIKE.test(input)) return false;
  try {
    new URL(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a downloaded file path (or URL) into something that can be handed to
 * Sonaria / FFmpeg: absolute URLs are returned untouched, file paths are
 * converted to `file://` URLs.
 */
export function toPlayableUrl(input: string): string {
  const value = input.trim();
  if (isUrl(value)) return value;
  return pathToFileURL(path.resolve(value)).href;
}

/** Strip characters that are not safe in file names. */
export function sanitizeFileName(name: string, fallback = "audio"): string {
  const sanitized = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return sanitized.length > 0 ? sanitized : fallback;
}

/** Short, stable-enough identifier derived from any string (for file names). */
export function shortHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
