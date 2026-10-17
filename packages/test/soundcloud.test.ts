import { afterAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Song } from "sonaria";
import { SonariaPluginsError } from "../src/core";
import { SoundCloudApi, type SoundCloudPlaylist, type SoundCloudTrack } from "../src/soundcloud/api";
import { SoundCloudPlugin } from "../src/soundcloud/index";
import { isSoundCloudUrl } from "../src/soundcloud/url";

const CLIENT_ID_A = "a".repeat(32);

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections?.();
        }),
    ),
  );
});

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function track(id: number, extra: Partial<SoundCloudTrack> = {}): SoundCloudTrack {
  return {
    id,
    kind: "track",
    title: `Track ${id}`,
    permalink_url: `https://soundcloud.com/artist/track-${id}`,
    artwork_url: "https://i1.sndcdn.com/artworks-000-large.jpg",
    duration: 213_000,
    playback_count: 42,
    likes_count: 7,
    user: { id: 5, username: "Artist", permalink_url: "https://soundcloud.com/artist" },
    ...extra,
  };
}

/** Fake `api-v2` + client id discovery page. */
function fakeApi(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", "http://localhost");
    const clientId = url.searchParams.get("client_id");
    if (clientId && clientId !== CLIENT_ID_A) {
      json(res, { error: "unauthorized" }, 401);
      return;
    }
    if (url.pathname === "/assets/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`window.__bundle={client_id:"${CLIENT_ID_A}"};`);
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><script src="${base}/assets/app.js"></script>`);
      return;
    }
    if (url.pathname === "/search/tracks") {
      json(res, { collection: [track(1), track(2)] });
      return;
    }
    if (url.pathname === "/search/playlists") {
      json(res, { collection: [{ id: 9, kind: "playlist", title: "Set", permalink_url: "https://soundcloud.com/artist/sets/set-9" }] });
      return;
    }
    if (url.pathname === "/resolve") {
      const target = url.searchParams.get("url") ?? "";
      if (target.includes("/sets/")) {
        json(res, {
          id: 9,
          kind: "playlist",
          title: "Set",
          permalink_url: target,
          track_count: 2,
          tracks: [track(1), track(2)],
        } satisfies SoundCloudPlaylist);
        return;
      }
      if (target.includes("/profile")) {
        json(res, { id: 5, kind: "user", username: "Artist" });
        return;
      }
      json(
        res,
        track(1, {
          policy: "SNIP",
          track_authorization: "auth-token",
          media: { transcodings: [{ url: `${base}/media/progressive`, format: { protocol: "progressive", mime_type: "audio/mpeg" } }] },
        }),
      );
      return;
    }
    if (url.pathname === "/playlists/9") {
      json(res, { id: 9, kind: "playlist", title: "Set", permalink_url: "https://soundcloud.com/artist/sets/set-9", track_count: 2, tracks: [track(1), track(2)] });
      return;
    }
    if (url.pathname === "/tracks/1") {
      json(
        res,
        track(1, {
          policy: "SNIP",
          track_authorization: "auth-token",
          media: {
            transcodings: [
              { url: `${base}/media/hls`, format: { protocol: "hls", mime_type: "audio/mpeg" } },
              { url: `${base}/media/progressive`, format: { protocol: "progressive", mime_type: "audio/mpeg" } },
            ],
          },
        }),
      );
      return;
    }
    if (url.pathname === "/tracks/2") {
      json(
        res,
        track(2, {
          media: {
            transcodings: [
              { url: `${base}/media/broken`, format: { protocol: "progressive" } },
              { url: `${base}/media/hls`, format: { protocol: "hls" } },
            ],
          },
        }),
      );
      return;
    }
    if (url.pathname === "/tracks/1/related") {
      json(res, { collection: [track(3), { title: "" }] });
      return;
    }
    if (url.pathname === "/media/progressive") {
      json(res, { url: `${base}/audio.mp3` });
      return;
    }
    if (url.pathname === "/media/hls") {
      json(res, { url: `${base}/audio.m3u8` });
      return;
    }
    if (url.pathname === "/media/broken") {
      json(res, { error: "gone" }, 410);
      return;
    }
    if (url.pathname === "/audio.mp3") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end("mp3");
      return;
    }
    json(res, { error: "not found" }, 404);
  });
  return server;
}

describe("isSoundCloudUrl", () => {
  test("matches soundcloud pages", () => {
    expect(isSoundCloudUrl("https://soundcloud.com/artist/track")).toBe(true);
    expect(isSoundCloudUrl("https://www.soundcloud.com/artist/sets/set")).toBe(true);
    expect(isSoundCloudUrl("https://m.soundcloud.com/artist/track")).toBe(true);
    expect(isSoundCloudUrl("https://on.soundcloud.com/abc")).toBe(false);
    expect(isSoundCloudUrl("https://example.com/artist/track")).toBe(false);
  });
});

describe("SoundCloudApi", () => {
  test("discovers the client id, searches, resolves and streams", async () => {
    const port = await listen(fakeApi());
    const api = new SoundCloudApi({ baseUrl: `http://127.0.0.1:${port}`, pageUrl: `http://127.0.0.1:${port}/` });

    const [first] = await api.searchTracks("artist", 2);
    expect(first?.id).toBe(1);
    expect(api.clientId).toBe(CLIENT_ID_A);

    const playlist = await api.resolve("https://soundcloud.com/artist/sets/set-9");
    expect(playlist.kind).toBe("playlist");
    expect((await api.playlist(9)).tracks?.length).toBe(2);

    const resolved = await api.resolve("https://soundcloud.com/artist/track-1");
    expect(resolved.kind).toBe("track");
    const stream = await api.streamUrl(resolved as SoundCloudTrack);
    expect(stream).toBe(`http://127.0.0.1:${port}/audio.mp3`);

    await expect(api.resolve("https://soundcloud.com/artist/profile")).rejects.toThrow(SonariaPluginsError);
  });

  test("falls back to HLS when the progressive transcoding fails", async () => {
    const port = await listen(fakeApi());
    const api = new SoundCloudApi({ baseUrl: `http://127.0.0.1:${port}`, pageUrl: `http://127.0.0.1:${port}/` });
    const stream = await api.streamUrl(await api.track(2));
    expect(stream).toBe(`http://127.0.0.1:${port}/audio.m3u8`);
  });

  test("rediscovers a stale client id once", async () => {
    const port = await listen(fakeApi());
    const api = new SoundCloudApi({ clientId: "c".repeat(32), baseUrl: `http://127.0.0.1:${port}`, pageUrl: `http://127.0.0.1:${port}/` });

    // The configured client id is rejected: the api rediscovers one and retries.
    expect((await api.searchTracks("x"))[0]?.id).toBe(1);
    expect(api.clientId).toBe(CLIENT_ID_A);
  });
});

describe("SoundCloudPlugin", () => {
  test("resolves tracks and playlists, searches and streams", async () => {
    const port = await listen(fakeApi());
    const plugin = new SoundCloudPlugin({ baseUrl: `http://127.0.0.1:${port}`, pageUrl: `http://127.0.0.1:${port}/` });

    expect(await plugin.validate("https://soundcloud.com/artist/track")).toBe(true);

    const song = (await plugin.resolve("https://soundcloud.com/artist/track-1", {})) as Song;
    expect(song.name).toBe("Track 1");
    expect(song.duration).toBe(213);
    expect(song.uploader?.name).toBe("Artist");
    expect(song.source).toBe("soundcloud");

    const playlist = (await plugin.resolve("https://soundcloud.com/artist/sets/set-9", {})) as unknown as { songs: Song[] };
    expect(playlist.songs.length).toBe(2);

    const found = await plugin.searchSong("artist", {});
    expect(found?.id).toBe("1");

    expect(await plugin.getStreamURL(song)).toBe(`http://127.0.0.1:${port}/audio.mp3`);

    const related = await plugin.getRelatedSongs(song);
    expect(related.map((entry) => entry.id)).toEqual(["3"]);
  });
});
