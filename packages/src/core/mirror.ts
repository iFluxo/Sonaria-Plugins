import type { ResolveOptions, Song } from "sonaria";
import type { MirrorSearchResult, SourcePlugin } from "./types";

/**
 * Check whether an unknown value looks like a {@link SourcePlugin}.
 *
 * Sonaria exposes its registered plugins as a public array, so plugins can find
 * each other at runtime (one extractor can delegate playback to another
 * registered extractor) without hard references between instances.
 */
export function isSourcePlugin(value: unknown): value is SourcePlugin {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SourcePlugin>;
  return (
    typeof candidate.source === "string" &&
    typeof candidate.searchSong === "function" &&
    typeof candidate.getStreamURL === "function"
  );
}

/**
 * Search every requested mirror source, in order, until one returns a song.
 *
 * @param registered - The plugins registered on the Sonaria instance (`sonaria.plugins`).
 * @param order      - Source names in priority order, e.g. `["deezer", "youtube", "soundcloud"]`.
 * @param query      - Search query.
 * @param options    - Resolve options forwarded to `searchSong`.
 */
export async function searchMirror(
  registered: readonly unknown[] | undefined,
  order: readonly string[],
  query: string,
  options: ResolveOptions = {},
): Promise<MirrorSearchResult | null> {
  if (!registered?.length || !order.length) return null;
  for (const source of order) {
    const plugin = registered.find((candidate): candidate is SourcePlugin => isSourcePlugin(candidate) && candidate.source === source);
    if (!plugin) continue;
    try {
      const song = await plugin.searchSong(query, options);
      if (song) return { source, plugin, song };
    } catch {
      // A source that fails to answer (rate limit, no result, network error)
      // must not stop the chain: try the next one.
      continue;
    }
  }
  return null;
}

/**
 * Resolve a playable URL through the mirror sources, in priority order.
 *
 * @returns The stream URL plus which source provided it, or `null`.
 */
export async function resolveMirrorStream(
  registered: readonly unknown[] | undefined,
  order: readonly string[],
  query: string,
  options: ResolveOptions = {},
): Promise<{ source: string; song: Song; url: string } | null> {
  const match = await searchMirror(registered, order, query, options);
  if (!match) return null;
  const url = await match.plugin.getStreamURL(match.song);
  return { source: match.source, song: match.song, url };
}
