import { afterAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Playlist, Song } from "sonaria";
import { SonariaPluginsError } from "../src/core";
import { SpotifyApi } from "../src/spotify/api";
import { SpotifyPlugin } from "../src/spotify/index";
import { parseSpotifyUrl } from "../src/spotify/url";

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

function embedPage(res: ServerResponse, entity: unknown | null): void {
  res.writeHead(200, { "content-type": "text/html" });
  if (!entity) {
    res.end("<!doctype html><html><body>no data</body></html>");
    return;
  }
  res.end(`<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></body></html>`);
}

const ARTIST_ID = "1Xyo4u8uXC1ZmMpatF05PJ";

function apiTrack(id: string, name: string, durationMs = 200_040): Record<string, unknown> {
  return {
    id,
    name,
    duration_ms: durationMs,
    artists: [{ id: ARTIST_ID, name: "The Weeknd", external_urls: { spotify: `https://open.spotify.com/artist/${ARTIST_ID}` } }],
    album: { id: "album1", name: "After Hours", images: [{ url: "https://img.example/cover.jpg" }], external_urls: { spotify: "https://open.spotify.com/album/album1" } },
    external_urls: { spotify: `https://open.spotify.com/track/${id}` },
  };
}

interface FakeSpotify {
  /** `/token` requests. */
  tokenHits: number;
  /** `authorization` headers seen by the Web API routes. */
  authorizations: Array<string | undefined>;
}

function fakeSpotify(): { server: Server; state: FakeSpotify } {
  const state: FakeSpotify = { tokenHits: 0, authorizations: [] };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const base = (): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const url = new URL(req.url ?? "/", "http://localhost");
    const [, root, kind, id] = url.pathname.split("/");

    if (root === "token") {
      state.tokenHits++;
      json(res, { access_token: "test-token", expires_in: 3600 });
      return;
    }

    if (root === "embed") {
      if (id === "missing") {
        embedPage(res, null);
        return;
      }
      if (kind === "track") {
        embedPage(res, {
          type: "track",
          id,
          uri: `spotify:track:${id}`,
          name: "Blinding Lights",
          isExplicit: false,
          duration: 200_040,
          artists: [{ name: "The Weeknd", uri: `spotify:artist:${ARTIST_ID}` }],
          visualIdentity: { image: [{ url: "https://img.example/embed-cover.jpg" }] },
          audioPreview: { url: "https://p.scdn.co/mp3-preview/abc" },
        });
        return;
      }
      if (kind === "album") {
        embedPage(res, {
          type: "album",
          id,
          uri: `spotify:album:${id}`,
          title: "After Hours",
          subtitle: "The Weeknd",
          visualIdentity: { image: [{ url: "https://img.example/embed-album.jpg" }] },
          trackList: [
            { uri: "spotify:track:t1", title: "Alone Again", subtitle: "The Weeknd", duration: 250_053 },
            { uri: "spotify:track:t2", title: "Too Late", subtitle: "The Weeknd", duration: 239_600 },
          ],
        });
        return;
      }
      if (kind === "playlist") {
        embedPage(res, {
          type: "playlist",
          id,
          uri: `spotify:playlist:${id}`,
          title: "Today's Top Hits",
          subtitle: "Spotify",
          visualIdentity: { image: [{ url: "https://img.example/embed-playlist.jpg" }] },
          trackList: [{ uri: "spotify:track:p1", title: "Blinding Lights", subtitle: "The Weeknd", duration: 200_040 }],
        });
        return;
      }
      if (kind === "artist") {
        embedPage(res, {
          type: "artist",
          id,
          uri: `spotify:artist:${id}`,
          name: "The Weeknd",
          visualIdentity: { image: [{ url: "https://img.example/embed-artist.jpg" }] },
          trackList: [
            { uri: "spotify:track:0VjIjW4GlUZAMYd2vXMi3b", title: "Blinding Lights", subtitle: "The Weeknd", duration: 200_040 },
            { uri: "spotify:track:a2", title: "Save Your Tears", subtitle: "The Weeknd", duration: 215_000 },
          ],
        });
        return;
      }
      json(res, { error: "not found" }, 404);
      return;
    }

    if (root === "v1") {
      state.authorizations.push(req.headers.authorization);
      if (kind === "tracks") {
        if (id === "unknown") {
          json(res, { error: { status: 404, message: "Not found" } }, 404);
          return;
        }
        json(res, apiTrack(id ?? "t0", "Blinding Lights"));
        return;
      }
      if (kind === "albums") {
        if (url.pathname.endsWith("/tracks")) {
          json(res, { items: [{ ...apiTrack("t2", "Too Late"), album: undefined }], next: null });
          return;
        }
        json(res, {
          id,
          name: "After Hours",
          images: [{ url: "https://img.example/api-album.jpg" }],
          artists: [{ id: ARTIST_ID, name: "The Weeknd" }],
          tracks: { items: [apiTrack("t1", "Alone Again")], next: `${base()}/v1/albums/${id}/tracks?offset=1` },
        });
        return;
      }
      if (kind === "playlists") {
        if (url.pathname.endsWith("/tracks")) {
          json(res, { items: [{ track: apiTrack("t2", "Too Late") }], next: null });
          return;
        }
        json(res, {
          id,
          name: "Today's Top Hits",
          description: "The hottest tracks",
          images: [{ url: "https://img.example/api-playlist.jpg" }],
          external_urls: { spotify: `https://open.spotify.com/playlist/${id}` },
          owner: { display_name: "Spotify" },
          tracks: { items: [{ track: apiTrack("t1", "Alone Again") }], next: `${base()}/v1/playlists/${id}/tracks?offset=1` },
        });
        return;
      }
      if (kind === "artists") {
        if (url.pathname.endsWith("/top-tracks")) {
          json(res, { tracks: [apiTrack("a1", "Blinding Lights"), apiTrack("a2", "Save Your Tears")] });
          return;
        }
        json(res, { id, name: "The Weeknd", images: [{ url: "https://img.example/api-artist.jpg" }] });
        return;
      }
      json(res, { error: "not found" }, 404);
      return;
    }

    json(res, { error: "not found" }, 404);
  });
  return { server, state };
}

describe("parseSpotifyUrl", () => {
  test("parses URLs and URIs", () => {
    expect(parseSpotifyUrl("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b")).toEqual({ type: "track", id: "0VjIjW4GlUZAMYd2vXMi3b" });
    expect(parseSpotifyUrl("https://open.spotify.com/intl-de/track/0VjIjW4GlUZAMYd2vXMi3b?si=abc")).toEqual({ type: "track", id: "0VjIjW4GlUZAMYd2vXMi3b" });
    expect(parseSpotifyUrl("https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj")).toEqual({ type: "album", id: "4yP0hdKOZPNshxUOjY0cZj" });
    expect(parseSpotifyUrl("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")).toEqual({ type: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
    expect(parseSpotifyUrl("spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ")).toEqual({ type: "artist", id: "1Xyo4u8uXC1ZmMpatF05PJ" });
  });

  test("rejects foreign URLs", () => {
    expect(parseSpotifyUrl("https://example.com/track/0VjIjW4GlUZAMYd2vXMi3b")).toBeNull();
    expect(parseSpotifyUrl("spotify:episode:123")).toBeNull();
    expect(parseSpotifyUrl("not a url")).toBeNull();
  });
});

describe("SpotifyApi", () => {
  test("uses the Web API with credentials and caches the token", async () => {
    const { server, state } = fakeSpotify();
    const port = await listen(server);
    const api = new SpotifyApi({ clientId: "id", clientSecret: "secret", accountsUrl: `http://127.0.0.1:${port}/token`, baseUrl: `http://127.0.0.1:${port}/v1` });

    const track = await api.track("0VjIjW4GlUZAMYd2vXMi3b");
    expect(track.name).toBe("Blinding Lights");
    expect(track.duration).toBe(200.04);
    expect(track.artists).toEqual(["The Weeknd"]);
    expect(track.thumbnail).toBe("https://img.example/cover.jpg");
    expect(track.album?.name).toBe("After Hours");

    const album = await api.album("4yP0hdKOZPNshxUOjY0cZj");
    expect(album.name).toBe("After Hours");
    expect(album.owner).toBe("The Weeknd");
    expect(album.tracks.map((entry) => entry.id)).toEqual(["t1", "t2"]);
    expect(album.tracks[1]?.thumbnail).toBe("https://img.example/api-album.jpg");

    const playlist = await api.playlist("37i9dQZF1DXcBWIGoYBM5M");
    expect(playlist.owner).toBe("Spotify");
    expect(playlist.tracks.map((entry) => entry.id)).toEqual(["t1", "t2"]);

    const artist = await api.artist(ARTIST_ID);
    expect(artist.name).toBe("The Weeknd — Top Tracks");
    expect(artist.tracks.map((entry) => entry.name)).toEqual(["Blinding Lights", "Save Your Tears"]);

    expect(state.tokenHits).toBe(1);
    expect(state.authorizations.length).toBeGreaterThan(0);
    expect(state.authorizations.every((header) => header === "Bearer test-token")).toBe(true);
  });

  test("maps Web API errors when the embed fallback is disabled", async () => {
    const port = await listen(fakeSpotify().server);
    const api = new SpotifyApi({
      clientId: "id",
      clientSecret: "secret",
      embedFallback: false,
      accountsUrl: `http://127.0.0.1:${port}/token`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
    });
    await expect(api.track("unknown")).rejects.toThrow(SonariaPluginsError);
  });

  test("reads the public embed without credentials", async () => {
    const port = await listen(fakeSpotify().server);
    const api = new SpotifyApi({ embedUrl: `http://127.0.0.1:${port}/embed` });

    const track = await api.track("0VjIjW4GlUZAMYd2vXMi3b");
    expect(track.name).toBe("Blinding Lights");
    expect(track.duration).toBe(200.04);
    expect(track.artists).toEqual(["The Weeknd"]);
    expect(track.thumbnail).toBe("https://img.example/embed-cover.jpg");
    expect(track.artistUrl).toBe(`https://open.spotify.com/artist/${ARTIST_ID}`);

    const album = await api.album("4yP0hdKOZPNshxUOjY0cZj");
    expect(album.tracks.map((entry) => entry.name)).toEqual(["Alone Again", "Too Late"]);
    expect(album.tracks[0]?.duration).toBe(250.053);
    expect(album.owner).toBe("The Weeknd");

    const playlist = await api.playlist("37i9dQZF1DXcBWIGoYBM5M");
    expect(playlist.name).toBe("Today's Top Hits");
    expect(playlist.tracks[0]?.id).toBe("p1");

    const artist = await api.artist(ARTIST_ID);
    expect(artist.tracks.map((entry) => entry.id)).toEqual(["0VjIjW4GlUZAMYd2vXMi3b", "a2"]);

    await expect(api.track("missing")).rejects.toThrow(SonariaPluginsError);
  });

  test("falls back to the embed when the Web API fails", async () => {
    const port = await listen(fakeSpotify().server);
    const api = new SpotifyApi({
      clientId: "id",
      clientSecret: "secret",
      accountsUrl: `http://127.0.0.1:${port}/token`,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      embedUrl: `http://127.0.0.1:${port}/embed`,
    });
    const track = await api.track("unknown");
    expect(track.name).toBe("Blinding Lights");
  });
});

describe("SpotifyPlugin", () => {
  test("resolves Spotify metadata and keeps it for the mirror chain", async () => {
    const port = await listen(fakeSpotify().server);
    const plugin = new SpotifyPlugin({ embedUrl: `http://127.0.0.1:${port}/embed` });

    expect(await plugin.validate("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b")).toBe(true);
    expect(await plugin.validate("https://example.com/track/0VjIjW4GlUZAMYd2vXMi3b")).toBe(false);

    const song = (await plugin.resolve("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b", {})) as Song;
    expect(song.source).toBe("spotify");
    expect(song.name).toBe("Blinding Lights");
    expect(song.duration).toBe(200.04);
    expect(song.uploader?.name).toBe("The Weeknd");
    expect(song.url).toBe("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b");
    expect(song.stream.playFromSource).toBe(false);

    expect(await plugin.createSearchQuery(song)).toBe("Blinding Lights The Weeknd");

    const playlist = (await plugin.resolve("https://open.spotify.com/album/4yP0hdKOZPNshxUOjY0cZj", {})) as Playlist;
    expect(playlist.name).toBe("After Hours");
    expect(playlist.songs.map((entry) => entry.name)).toEqual(["Alone Again", "Too Late"]);

    const related = await plugin.getRelatedSongs(song);
    expect(related.map((entry) => entry.name)).toEqual(["Save Your Tears"]);
  });

  test("respects a custom search query", async () => {
    const port = await listen(fakeSpotify().server);
    const plugin = new SpotifyPlugin({ embedUrl: `http://127.0.0.1:${port}/embed`, searchQuery: (song) => `lyrics:${song.name}` });
    const song = (await plugin.resolve("https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b", {})) as Song;
    expect(await plugin.createSearchQuery(song)).toBe("lyrics:Blinding Lights");
  });
});
