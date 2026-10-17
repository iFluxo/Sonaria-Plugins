import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Playlist, Song } from "sonaria";
import { extractJson, parseCountText, parseDurationText } from "../src/youtube/innertube";
import { YouTubePlugin, type YouTubePluginOptions } from "../src/youtube/index";
import { parseYouTubeUrl } from "../src/youtube/url";

const temporary = await mkdtemp(path.join(tmpdir(), "sonaria-youtube-"));

afterAll(async () => {
  await rm(temporary, { recursive: true, force: true });
});

/** A tiny yt-dlp stand-in: enough flags to exercise every downloader mode. */
const FAKE_YTDLP = `#!/usr/bin/env bash
set -e
args=("$@")
joined="$*"
out=""
for ((i = 0; i < \${#args[@]}; i++)); do
  if [ "\${args[$i]}" = "-o" ]; then out="\${args[$((i + 1))]}"; fi
  if [ "\${args[$i]}" = "--version" ]; then echo "2026.01.01"; exit 0; fi
done
if [[ "$joined" == *"--dump-single-json"* ]]; then
  if [[ "$joined" == *"mergefail"* ]]; then
    echo '{"id":"dQw4w9WgXcQ","title":"Merged without url"}'
  elif [[ "$joined" == *"broken"* ]]; then
    echo '{"id":"dQw4w9WgXcQ","title":"Merged","duration":213,"requested_formats":[{"url":"https://media.example/video.mp4","vcodec":"avc1"},{"url":"https://media.example/audio.webm","vcodec":"none"}]}'
  elif [[ "$joined" == *"ytsearch"* ]]; then
    echo '{"entries":[{"id":"search1","title":"Searched Song","duration":120,"uploader":"Channel","view_count":5}]}'
  elif [[ "$joined" == *"list=RD"* ]]; then
    echo '{"entries":[{"id":"dQw4w9WgXcQ","title":"Original"},{"id":"rel1","title":"Related One","duration":200},{"id":"rel2","title":"Related Two","duration":180}]}'
  elif [[ "$joined" == *"playlist?list="* ]]; then
    echo '{"id":"PL1","title":"My Playlist","webpage_url":"https://www.youtube.com/playlist?list=PL1","entries":[{"id":"v1","title":"One","duration":60},{"id":"v2","title":"Two","duration":70}]}'
  else
    echo '{"id":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","duration":213,"uploader":"Rick Astley","webpage_url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","thumbnails":[{"url":"https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg","width":1280}],"url":"https://media.example/audio.m4a","ext":"m4a","view_count":10}'
  fi
  exit 0
fi
if [[ "$joined" == *"--print"* ]]; then
  target="\${out//%(ext)s/m4a}"
  mkdir -p "$(dirname "$target")"
  printf 'audio' > "$target"
  echo "$target"
  exit 0
fi
echo "unexpected arguments: $joined" >&2
exit 1
`;

const binary = path.join(temporary, "fake-yt-dlp");
await writeFile(binary, FAKE_YTDLP, { mode: 0o755 });

function makePlugin(options: YouTubePluginOptions = {}): YouTubePlugin {
  return new YouTubePlugin({ ytdlp: { path: binary }, ...options });
}

describe("parseYouTubeUrl", () => {
  test("parses every supported video form", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: undefined });
    expect(parseYouTubeUrl("https://youtu.be/dQw4w9WgXcQ?t=30")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: undefined });
    expect(parseYouTubeUrl("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: undefined });
    expect(parseYouTubeUrl("https://music.youtube.com/embed/dQw4w9WgXcQ")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: undefined });
    expect(parseYouTubeUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: undefined });
  });

  test("keeps the list id and parses playlists", () => {
    expect(parseYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123")).toEqual({ type: "video", videoId: "dQw4w9WgXcQ", listId: "PL123" });
    expect(parseYouTubeUrl("https://www.youtube.com/playlist?list=PL123")).toEqual({ type: "playlist", listId: "PL123" });
    expect(parseYouTubeUrl("https://www.youtube.com/watch?list=PL123")).toEqual({ type: "playlist", listId: "PL123" });
  });

  test("rejects foreign URLs", () => {
    expect(parseYouTubeUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(parseYouTubeUrl("https://www.youtube.com/@channel")).toBeNull();
    expect(parseYouTubeUrl("not a url")).toBeNull();
  });
});

describe("innertube helpers", () => {
  test("parses durations and counts", () => {
    expect(parseDurationText("4:02")).toBe(242);
    expect(parseDurationText("1:02:03")).toBe(3723);
    expect(parseDurationText("242")).toBe(242);
    expect(parseDurationText("Now playing")).toBeUndefined();
    expect(parseCountText("2.7B views")).toBe(2_700_000_000);
    expect(parseCountText("1,234")).toBe(1234);
    expect(parseCountText("no count")).toBeUndefined();
  });

  test("extracts nested JSON without tripping on braces in strings", () => {
    const html = '<script>var ytInitialData = {"a":{"b":"} { \\"nested\\""},"c":[1,2]};</script>';
    expect(extractJson(html, "ytInitialData =")).toEqual({ a: { b: '} { "nested"' }, c: [1, 2] });
    expect(extractJson("<html></html>", "ytInitialData =")).toBeNull();
  });
});

describe("YouTubePlugin", () => {
  test("resolves videos with full yt-dlp metadata", async () => {
    const plugin = makePlugin({ downloader: "direct" });
    const song = (await plugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})) as Song;
    expect(song.name).toBe("Never Gonna Give You Up");
    expect(song.duration).toBe(213);
    expect(song.views).toBe(10);
    expect(song.thumbnail).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg");
    expect(song.uploader?.name).toBe("Rick Astley");
    expect(await plugin.getStreamURL(song)).toBe("https://media.example/audio.m4a");
    plugin.dispose();
  });

  test("download mode exposes a file:// URL", async () => {
    const plugin = makePlugin({ downloader: "download", downloadDir: path.join(temporary, "downloads"), cleanupDownloads: false });
    const song = (await plugin.resolve("https://youtu.be/dQw4w9WgXcQ", {})) as Song;
    const url = await plugin.getStreamURL(song);
    expect(url.startsWith("file://")).toBe(true);
    expect(await readFile(fileURLToPath(url), "utf8")).toBe("audio");
    plugin.dispose();
  });

  test("auto mode falls back to downloading when no direct URL exists", async () => {
    const messages: string[] = [];
    const plugin = makePlugin({ format: "mergefail", downloadDir: path.join(temporary, "fallback"), debug: (message) => messages.push(message) });
    const song = (await plugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})) as Song;
    const url = await plugin.getStreamURL(song);
    expect(url.startsWith("file://")).toBe(true);
    expect(messages.some((message) => message.includes("downloading instead"))).toBe(true);
    plugin.dispose();
  });

  test("manual mode accepts paths and URLs", async () => {
    const plugin = makePlugin({ downloader: "manual", download: ({ id }) => path.join(temporary, `${id}.opus`) });
    const song = (await plugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})) as Song;
    expect(await plugin.getStreamURL(song)).toBe(pathToFileURL(path.join(temporary, "dQw4w9WgXcQ.opus")).toString());

    const urlPlugin = makePlugin({ downloader: "manual", download: () => "https://cdn.example/audio.opus" });
    const urlSong = (await urlPlugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})) as Song;
    expect(await urlPlugin.getStreamURL(urlSong)).toBe("https://cdn.example/audio.opus");
    plugin.dispose();
    urlPlugin.dispose();
  });

  test("searches, resolves playlists and lists related songs", async () => {
    const plugin = makePlugin({ downloader: "direct" });
    const found = await plugin.searchSong("never gonna", {});
    expect(found?.id).toBe("search1");
    expect(found?.name).toBe("Searched Song");

    const playlist = (await plugin.resolve("https://www.youtube.com/playlist?list=PL1", {})) as Playlist;
    expect(playlist.name).toBe("My Playlist");
    expect(playlist.songs.map((song) => song.id)).toEqual(["v1", "v2"]);

    const song = (await plugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})) as Song;
    const related = await plugin.getRelatedSongs(song);
    expect(related.map((entry) => entry.id)).toEqual(["rel1", "rel2"]);
    plugin.dispose();
  });

  test("stays silent when no playable backend exists", async () => {
    const plugin = new YouTubePlugin({ ytdlp: { path: path.join(temporary, "missing-yt-dlp") } });
    expect(await plugin.searchSong("anything", {})).toBeNull();
    await expect(plugin.resolve("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {})).rejects.toThrow("yt-dlp is not installed");
    plugin.dispose();
  });
});
