import { describe, expect, test } from "bun:test";
import type { ExtractorPlugin, InfoExtractorPlugin, SonariaPlugin } from "sonaria";
import { isSourcePlugin } from "../src/core";
import { sonariaPlugins } from "../src/index";

/** Sonaria's public plugin union does not declare `source`, but every plugin sets it. */
const sourceOf = (plugin: SonariaPlugin): string => (plugin as unknown as { source: string }).source;

/** One sample link per source, used to prove `validate()` never overlaps. */
const SAMPLES: Record<string, string> = {
  youtube: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  soundcloud: "https://soundcloud.com/octobersveryown/drake-hotline-bling",
  deezer: "https://www.deezer.com/track/3135556",
  spotify: "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
  applemusic: "https://music.apple.com/us/album/after-hours/1499378108",
};

describe("suite integration", () => {
  test("every source is unique and matches its plugin kind", () => {
    const plugins = sonariaPlugins();
    const sources = plugins.map(sourceOf);
    expect(new Set(sources).size).toBe(plugins.length);
    expect([...sources].sort()).toEqual(["applemusic", "deezer", "soundcloud", "spotify", "youtube"]);

    for (const plugin of plugins) {
      const extractor = plugin as ExtractorPlugin;
      const hasStreamContract =
        typeof extractor.searchSong === "function" && typeof extractor.getStreamURL === "function";

      if (hasStreamContract) {
        // Extractors are the only plugins the mirror may pick as a fallback.
        expect(isSourcePlugin(plugin)).toBe(true);
      } else {
        expect(typeof (plugin as InfoExtractorPlugin).createSearchQuery).toBe("function");
        expect(isSourcePlugin(plugin)).toBe(false);
      }
    }

    expect((plugins as unknown[]).filter(isSourcePlugin).map((plugin) => plugin.source)).toEqual([
      "youtube",
      "soundcloud",
      "deezer",
    ]);
  });

  test("validate() accepts only the plugin's own links", async () => {
    for (const plugin of sonariaPlugins()) {
      const source = sourceOf(plugin);
      for (const [name, url] of Object.entries(SAMPLES)) {
        expect({ plugin: source, url: name, valid: await plugin.validate(url) }).toEqual({
          plugin: source,
          url: name,
          valid: name === source,
        });
      }
    }
  });
});
