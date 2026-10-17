import { afterAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Playlist, Song } from "sonaria";
import { SonariaPluginsError } from "../src/core";
import { AppleMusicApi } from "../src/applemusic/api";
import { AppleMusicPlugin } from "../src/applemusic/index";
import { parseAppleMusicUrl } from "../src/applemusic/url";

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

function page(res: ServerResponse, sections: unknown[]): void {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><body><script type="application/json" id="serialized-server-data">${JSON.stringify({ data: [{ data: { sections } }] })}</script></body></html>`);
}

const ALBUM_HEADER = {
  title: "After Hours",
  subtitleLinks: [{ title: "The Weeknd" }],
  artwork: { dictionary: { url: "https://is1.example/image/Features125/{w}x{h}bb.{f}" } },
  contentDescriptor: { kind: "album", identifiers: { storeAdamID: "1499378108" }, url: "https://music.apple.com/us/album/after-hours/1499378108" },
};

const ALBUM_SECTIONS = [
  { itemKind: "containerDetailHeaderLockup", items: [ALBUM_HEADER] },
  {
    itemKind: "trackLockup",
    items: [
      {
        title: "Alone Again",
        duration: 250_057,
        artwork: null,
        subtitleLinks: null,
        contentDescriptor: { kind: "song", identifiers: { storeAdamID: "1499378115" }, url: "https://music.apple.com/us/album/alone-again/1499378108?i=1499378115" },
      },
      {
        title: "Too Late",
        duration: 239_612,
        artwork: null,
        subtitleLinks: null,
        contentDescriptor: { kind: "song", identifiers: { storeAdamID: "1499378120" }, url: "https://music.apple.com/us/album/too-late/1499378108?i=1499378120" },
      },
    ],
  },
];

const PLAYLIST_SECTIONS = [
  {
    itemKind: "containerDetailHeaderLockup",
    items: [
      {
        title: "Today's Hits",
        subtitleLinks: [{ title: "Apple Music Pop" }],
        artwork: { dictionary: { url: "https://is1.example/image/Features124/{w}x{h}bb.{f}" } },
        contentDescriptor: { kind: "playlist", identifiers: { storeAdamID: "pl.f4d106fed2bd41149aaacabb233eb5eb" }, url: "https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb" },
      },
    ],
  },
  {
    itemKind: "trackLockup",
    items: [
      {
        title: "Blinding Lights",
        duration: 200_040,
        artwork: { dictionary: { url: "https://is1.example/image/track/{w}x{h}bb.{f}" } },
        subtitleLinks: [{ title: "The Weeknd" }],
        tertiaryLinks: [
          {
            title: "After Hours",
            segue: { destination: { contentDescriptor: { kind: "album", identifiers: { storeAdamID: "1499378108" }, url: "https://music.apple.com/us/album/after-hours/1499378108" } } },
          },
        ],
        contentDescriptor: { kind: "song", identifiers: { storeAdamID: "1499378115" }, url: "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378115" },
      },
    ],
  },
];

const ARTIST_SECTIONS = [
  {
    itemKind: "artistDetailHeader",
    items: [
      {
        title: "The Weeknd",
        artwork: { dictionary: { url: "https://is1.example/image/artist/{w}x{h}bb.{f}" } },
        contentDescriptor: { kind: "artist", identifiers: { storeAdamID: "479756766" }, url: "https://music.apple.com/us/artist/the-weeknd/479756766" },
      },
    ],
  },
  {
    itemKind: "trackLockup",
    items: [
      {
        id: "1499378115",
        title: "Blinding Lights",
        artwork: { dictionary: { url: "https://is1.example/image/song/{w}x{h}bb.{f}" } },
        contentDescriptor: { kind: "song", identifiers: { storeAdamID: "1499378115" }, url: "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378115" },
      },
      {
        id: "1440833098",
        title: "Save Your Tears",
        artwork: { dictionary: { url: "https://is1.example/image/song2/{w}x{h}bb.{f}" } },
        contentDescriptor: { kind: "song", identifiers: { storeAdamStoreID: "1440833098", storeAdamID: "1440833098" }, url: "https://music.apple.com/us/album/save-your-tears/1499378108?i=1440833098" },
      },
    ],
  },
];

function fakeApple(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/lookup") {
      const id = url.searchParams.get("id");
      if (id === "1499378115") {
        json(res, {
          resultCount: 1,
          results: [
            {
              wrapperType: "track",
              kind: "song",
              artistId: 479756766,
              artistName: "The Weeknd",
              artistViewUrl: "https://music.apple.com/us/artist/the-weeknd/479756766?uo=4",
              collectionId: 1499378108,
              collectionName: "After Hours",
              collectionViewUrl: "https://music.apple.com/us/album/after-hours/1499378108?uo=4",
              trackId: 1499378115,
              trackName: "Blinding Lights",
              trackTimeMillis: 200_040,
              trackViewUrl: "https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378115&uo=4",
              artworkUrl100: "https://is1.example/image/100x100bb.jpg",
            },
          ],
        });
        return;
      }
      if (id === "1499378108") {
        json(res, {
          resultCount: 3,
          results: [
            {
              wrapperType: "collection",
              collectionType: "Album",
              artistName: "The Weeknd",
              collectionId: 1499378108,
              collectionName: "After Hours",
              collectionViewUrl: "https://music.apple.com/us/album/after-hours/1499378108?uo=4",
              artworkUrl100: "https://is1.example/image/100x100bb.jpg",
            },
            { wrapperType: "track", trackId: 1499378115, trackName: "Alone Again", artistName: "The Weeknd", collectionId: 1499378108, collectionName: "After Hours", trackTimeMillis: 250_057, artworkUrl100: "https://is1.example/image/100x100bb.jpg" },
            { wrapperType: "track", trackId: 1499378120, trackName: "Too Late", artistName: "The Weeknd", collectionId: 1499378108, collectionName: "After Hours", trackTimeMillis: 239_612 },
          ],
        });
        return;
      }
      json(res, { resultCount: 0, results: [] });
      return;
    }
    if (url.pathname === "/us/album/1499378108") {
      page(res, ALBUM_SECTIONS);
      return;
    }
    if (url.pathname === "/us/playlist/pl.f4d106fed2bd41149aaacabb233eb5eb") {
      page(res, PLAYLIST_SECTIONS);
      return;
    }
    if (url.pathname === "/us/artist/479756766") {
      page(res, ARTIST_SECTIONS);
      return;
    }
    res.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><html></html>");
  });
}

describe("parseAppleMusicUrl", () => {
  test("parses every supported link", () => {
    expect(parseAppleMusicUrl("https://music.apple.com/us/album/after-hours/1499378108")).toEqual({ type: "album", id: "1499378108", storefront: "us" });
    expect(parseAppleMusicUrl("https://music.apple.com/us/album/alone-again/1499378108?i=1499378115")).toEqual({ type: "track", id: "1499378115", albumId: "1499378108", storefront: "us" });
    expect(parseAppleMusicUrl("https://music.apple.com/us/song/alone-again/1499378115")).toEqual({ type: "track", id: "1499378115", storefront: "us" });
    expect(parseAppleMusicUrl("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb")).toEqual({ type: "playlist", id: "pl.f4d106fed2bd41149aaacabb233eb5eb", storefront: "us" });
    expect(parseAppleMusicUrl("https://music.apple.com/id/artist/the-weeknd/479756766")).toEqual({ type: "artist", id: "479756766", storefront: "id" });
    expect(parseAppleMusicUrl("https://music.apple.com/album/after-hours/1499378108")).toEqual({ type: "album", id: "1499378108", storefront: undefined });
  });

  test("rejects foreign URLs", () => {
    expect(parseAppleMusicUrl("https://open.spotify.com/track/1499378108")).toBeNull();
    expect(parseAppleMusicUrl("https://music.apple.com/us/browse")).toBeNull();
    expect(parseAppleMusicUrl("not a url")).toBeNull();
  });
});

describe("AppleMusicApi", () => {
  test("reads tracks and albums from the iTunes lookup", async () => {
    const port = await listen(fakeApple());
    const api = new AppleMusicApi({ lookupUrl: `http://127.0.0.1:${port}/lookup`, pageUrl: `http://127.0.0.1:${port}` });

    const track = await api.track("1499378115");
    expect(track.name).toBe("Blinding Lights");
    expect(track.artists).toEqual(["The Weeknd"]);
    expect(track.duration).toBe(200.04);
    expect(track.thumbnail).toBe("https://is1.example/image/1000x1000bb.jpg");
    expect(track.album?.name).toBe("After Hours");
    expect(track.artistUrl).toBe("https://music.apple.com/us/artist/the-weeknd/479756766?uo=4");

    const album = await api.album("1499378108");
    expect(album.name).toBe("After Hours");
    expect(album.owner).toBe("The Weeknd");
    expect(album.tracks.map((entry) => entry.name)).toEqual(["Alone Again", "Too Late"]);
    expect(album.tracks[1]?.thumbnail).toBe("https://is1.example/image/1000x1000bb.jpg");
  });

  test("scrapes the page when the lookup fails", async () => {
    const port = await listen(fakeApple());
    const api = new AppleMusicApi({ lookupUrl: `http://127.0.0.1:${port}/lookup-missing`, pageUrl: `http://127.0.0.1:${port}` });

    const album = await api.album("1499378108");
    expect(album.name).toBe("After Hours");
    expect(album.owner).toBe("The Weeknd");
    expect(album.thumbnail).toBe("https://is1.example/image/Features125/1000x1000bb.jpg");
    expect(album.tracks.map((entry) => entry.name)).toEqual(["Alone Again", "Too Late"]);
    expect(album.tracks[0]?.duration).toBe(250.057);
    expect(album.tracks[0]?.artists).toEqual(["The Weeknd"]);
    expect(album.tracks[0]?.album?.id).toBe("1499378108");

    const track = await api.track("1499378115", { albumId: "1499378108" });
    expect(track.name).toBe("Alone Again");
    expect(track.album?.name).toBe("After Hours");

    const playlist = await api.playlist("pl.f4d106fed2bd41149aaacabb233eb5eb");
    expect(playlist.name).toBe("Today's Hits");
    expect(playlist.owner).toBe("Apple Music Pop");
    expect(playlist.tracks[0]?.id).toBe("1499378115");
    expect(playlist.tracks[0]?.artists).toEqual(["The Weeknd"]);
    expect(playlist.tracks[0]?.album?.name).toBe("After Hours");
    expect(playlist.tracks[0]?.thumbnail).toBe("https://is1.example/image/track/1000x1000bb.jpg");

    const artist = await api.artist("479756766");
    expect(artist.name).toBe("The Weeknd — Top Songs");
    expect(artist.tracks.map((entry) => entry.name)).toEqual(["Blinding Lights", "Save Your Tears"]);
  });

  test("reports unknown resources", async () => {
    const port = await listen(fakeApple());
    const api = new AppleMusicApi({ lookupUrl: `http://127.0.0.1:${port}/lookup`, pageUrl: `http://127.0.0.1:${port}` });
    await expect(api.playlist("pl.missing")).rejects.toThrow(SonariaPluginsError);
    await expect(api.track("123")).rejects.toThrow(SonariaPluginsError);
  });
});

describe("AppleMusicPlugin", () => {
  test("resolves Apple Music metadata and keeps it for the mirror chain", async () => {
    const port = await listen(fakeApple());
    const plugin = new AppleMusicPlugin({ lookupUrl: `http://127.0.0.1:${port}/lookup`, pageUrl: `http://127.0.0.1:${port}` });

    expect(await plugin.validate("https://music.apple.com/us/album/after-hours/1499378108?i=1499378115")).toBe(true);
    expect(await plugin.validate("https://open.spotify.com/track/1499378115")).toBe(false);

    const song = (await plugin.resolve("https://music.apple.com/us/album/after-hours/1499378108?i=1499378115", {})) as Song;
    expect(song.source).toBe("applemusic");
    expect(song.name).toBe("Blinding Lights");
    expect(song.duration).toBe(200.04);
    expect(song.uploader?.name).toBe("The Weeknd");
    expect(song.stream.playFromSource).toBe(false);
    expect(song.url).toBe("https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378115&uo=4");

    expect(await plugin.createSearchQuery(song)).toBe("Blinding Lights The Weeknd");

    const playlist = (await plugin.resolve("https://music.apple.com/us/playlist/todays-hits/pl.f4d106fed2bd41149aaacabb233eb5eb", {})) as Playlist;
    expect(playlist.name).toBe("Today's Hits");
    expect(playlist.songs.map((entry) => entry.name)).toEqual(["Blinding Lights"]);

    const related = await plugin.getRelatedSongs(song);
    expect(related.map((entry) => entry.name)).toEqual(["Save Your Tears"]);
  });

  test("supports a custom search query", async () => {
    const port = await listen(fakeApple());
    const plugin = new AppleMusicPlugin({ lookupUrl: `http://127.0.0.1:${port}/lookup`, pageUrl: `http://127.0.0.1:${port}`, searchQuery: (song) => `apple:${song.name}` });
    const song = (await plugin.resolve("https://music.apple.com/us/song/alone-again/1499378115", {})) as Song;
    expect(await plugin.createSearchQuery(song)).toBe("apple:Blinding Lights");
  });
});
