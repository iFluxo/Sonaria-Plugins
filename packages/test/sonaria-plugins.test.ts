import { describe, expect, test } from "bun:test";
import { sonariaPlugins } from "../src/index";

const names = (plugins: ReturnType<typeof sonariaPlugins>): string[] =>
  plugins.map((plugin) => plugin.constructor.name);

describe("sonariaPlugins", () => {
  test("returns the suite in the recommended registration order", () => {
    expect(names(sonariaPlugins())).toEqual([
      "YouTubePlugin",
      "SoundCloudPlugin",
      "DeezerPlugin",
      "SpotifyPlugin",
      "AppleMusicPlugin",
    ]);
  });

  test("allows skipping individual sources", () => {
    expect(names(sonariaPlugins({ soundcloud: false, spotify: false, applemusic: false }))).toEqual([
      "YouTubePlugin",
      "DeezerPlugin",
    ]);
  });

  test("passes options through to the factories", () => {
    const [youtube, soundcloud, deezer, spotifyPlugin, appleMusic] = sonariaPlugins({
      youtube: { search: "innertube" },
      soundcloud: { searchLimit: 3 },
      deezer: { searchLimit: 3 },
      spotify: { embedFallback: false },
      applemusic: { storefront: "id" },
    });
    expect(youtube).toBeDefined();
    expect(soundcloud).toBeDefined();
    expect(deezer).toBeDefined();
    expect(spotifyPlugin).toBeDefined();
    expect(appleMusic).toBeDefined();
  });
});
