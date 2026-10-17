import { describe, expect, test } from "bun:test";
import { TimedCache } from "../src/core/cache";
import { toPlayableUrl, isUrl, sanitizeFileName } from "../src/core/files";
import { searchMirror, isSourcePlugin } from "../src/core/mirror";
import type { SourcePlugin } from "../src/core/types";

describe("TimedCache", () => {
  test("stores and expires values", async () => {
    const cache = new TimedCache<string, number>(20, 4);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
    await Bun.sleep(30);
    expect(cache.get("a")).toBeUndefined();
  });

  test("evicts the oldest entries when full", () => {
    const cache = new TimedCache<string, number>(60_000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  test("resolve caches the factory result", async () => {
    const cache = new TimedCache<string, number>(60_000);
    let calls = 0;
    const factory = async () => ++calls;
    expect(await cache.resolve("x", factory)).toBe(1);
    expect(await cache.resolve("x", factory)).toBe(1);
    expect(calls).toBe(1);
  });
});

describe("files", () => {
  test("isUrl", () => {
    expect(isUrl("https://example.com/x")).toBe(true);
    expect(isUrl("file:///tmp/x.mp3")).toBe(true);
    expect(isUrl("/tmp/x.mp3")).toBe(false);
    expect(isUrl("./x.mp3")).toBe(false);
  });

  test("toPlayableUrl keeps URLs and converts paths", () => {
    expect(toPlayableUrl("https://example.com/x.mp3")).toBe("https://example.com/x.mp3");
    expect(toPlayableUrl("file:///tmp/x.mp3")).toBe("file:///tmp/x.mp3");
    expect(toPlayableUrl("/tmp/x.mp3")).toBe("file:///tmp/x.mp3");
  });

  test("sanitizeFileName", () => {
    expect(sanitizeFileName('a/b\\c:d?*"<>|')).toBe("a_b_c_d______");
    expect(sanitizeFileName("   ")).toBe("audio");
  });
});

describe("mirror", () => {
  function fakePlugin(source: string, calls: string[] | null, result: boolean): SourcePlugin {
    return {
      source,
      searchSong: async (query) => {
        calls?.push(`${source}:${query}`);
        if (!result) return null;
        return { id: `${source}-song`, url: `https://${source}.test/x`, plugin: null } as never;
      },
      getStreamURL: async () => `https://${source}.test/stream.mp3`,
    };
  }

  test("isSourcePlugin", () => {
    expect(isSourcePlugin(fakePlugin("youtube", null, true))).toBe(true);
    expect(isSourcePlugin({})).toBe(false);
    expect(isSourcePlugin(null)).toBe(false);
  });

  test("searches in priority order and stops at the first hit", async () => {
    const calls: string[] = [];
    const plugins = [fakePlugin("soundcloud", calls, true), fakePlugin("youtube", calls, true), fakePlugin("deezer", calls, false)];
    const result = await searchMirror(plugins, ["deezer", "youtube", "soundcloud"], "get lucky");
    expect(result?.source).toBe("youtube");
    expect(calls).toEqual(["deezer:get lucky", "youtube:get lucky"]);
  });

  test("returns null when nothing matches and skips missing sources", async () => {
    const plugins = [fakePlugin("youtube", null, false)];
    expect(await searchMirror(plugins, ["deezer", "youtube", "soundcloud"], "x")).toBeNull();
    expect(await searchMirror(undefined, ["deezer"], "x")).toBeNull();
  });
});
