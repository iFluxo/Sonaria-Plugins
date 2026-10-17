import { afterAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Blowfish, BLOWFISH_IV, SonariaPluginsError } from "../src/core";
import { DeezerGateway, DeezerPublicApi } from "../src/deezer/api";
import { deriveDeezerBlowfishKey, parseMasterDecryptKey } from "../src/deezer/crypto";
import { DeezerPlugin } from "../src/deezer/index";
import { DeezerStreamProxy } from "../src/deezer/stream";
import { isDeezerUrl, parseDeezerUrl } from "../src/deezer/url";

const CHUNK = 2048;
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

function stripeEncrypt(plain: Uint8Array, key: Uint8Array): Buffer {
  const out = Buffer.from(plain);
  const blowfish = new Blowfish(key);
  const complete = plain.length - (plain.length % CHUNK);
  for (let offset = 0; offset < complete; offset += CHUNK) {
    if (offset / CHUNK % 3 === 0) blowfish.encryptCbc(plain, offset, CHUNK, out, BLOWFISH_IV);
  }
  return out;
}

function payload(length = CHUNK * 5 + 500): Buffer {
  const buffer = Buffer.alloc(length);
  for (let i = 0; i < length; i++) buffer[i] = (i * 7 + 11) % 256;
  return buffer;
}

/** Minimal `Range` aware file server, standing in for the Deezer CDN. */
function fileServer(data: Buffer): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const header = req.headers.range;
    if (header) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(header);
      if (!match) {
        res.writeHead(416).end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      if (start >= data.length) {
        res.writeHead(416, { "content-range": `bytes */${data.length}` }).end();
        return;
      }
      res.writeHead(206, {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${data.length}`,
        "content-length": end - start + 1,
      });
      res.end(data.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "content-type": "audio/mpeg", "accept-ranges": "bytes", "content-length": data.length });
    res.end(data);
  });
}

function jsonServer(handler: (url: URL, req: IncomingMessage, res: ServerResponse) => void): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");
    handler(url, req, res);
  });
}

describe("parseDeezerUrl", () => {
  test("parses resource URLs", () => {
    expect(parseDeezerUrl("https://www.deezer.com/track/3135556")).toEqual({ type: "track", id: "3135556" });
    expect(parseDeezerUrl("https://deezer.com/album/302127")).toEqual({ type: "album", id: "302127" });
    expect(parseDeezerUrl("http://deezer.com/playlist/908622995")).toEqual({ type: "playlist", id: "908622995" });
    expect(parseDeezerUrl("https://www.deezer.com/artist/27")).toEqual({ type: "artist", id: "27" });
  });

  test("parses localized URLs", () => {
    expect(parseDeezerUrl("https://www.deezer.com/en/track/3135556?utm_source=x")).toEqual({ type: "track", id: "3135556" });
    expect(parseDeezerUrl("https://www.deezer.com/pt-br/album/302127")).toEqual({ type: "album", id: "302127" });
  });

  test("rejects foreign URLs", () => {
    expect(parseDeezerUrl("https://example.com/track/1")).toBeNull();
    expect(parseDeezerUrl("https://www.deezer.com/profile/123")).toBeNull();
    expect(parseDeezerUrl("not a url")).toBeNull();
  });

  test("isDeezerUrl mirrors parseDeezerUrl", () => {
    expect(isDeezerUrl("https://www.deezer.com/track/3135556")).toBe(true);
    expect(isDeezerUrl("https://example.com/track/1")).toBe(false);
  });
});

describe("Deezer keys", () => {
  test("derives the standard Blowfish key from the track id", () => {
    // md5("3135556") = 29a15fc70fb278009ab6988ce9a422e8
    expect(Buffer.from(deriveDeezerBlowfishKey("3135556")).toString("hex")).toBe("6c6c666b39662c37652575603c643439");
  });

  test("parses masterDecryptKey", () => {
    expect([...parseMasterDecryptKey("000102030405060708090a0b0c0d0e0f")]).toEqual([...Array(16).keys()]);
    expect([...parseMasterDecryptKey("0001-0203 0405:0607-0809-0a0b-0c0d-0e0f")]).toEqual([...Array(16).keys()]);
    const text = parseMasterDecryptKey("secret");
    expect(text.length).toBe(16);
    expect(String.fromCharCode(...text)).toBe("secret\0\0\0\0\0\0\0\0\0\0");
    expect(() => parseMasterDecryptKey("  ")).toThrow(RangeError);
  });
});

describe("DeezerStreamProxy", () => {
  test("streams, decrypts and supports ranges", async () => {
    const key = deriveDeezerBlowfishKey("3135556");
    const plain = payload();
    const encrypted = stripeEncrypt(plain, key);
    const upstream = fileServer(encrypted);
    const upstreamPort = await listen(upstream);

    const proxy = new DeezerStreamProxy();
    try {
      const url = await proxy.create({ url: `http://127.0.0.1:${upstreamPort}/track`, key });

      const full = await fetch(url);
      expect(full.status).toBe(200);
      expect(Buffer.from(await full.arrayBuffer()).equals(plain)).toBe(true);

      const ranged = await fetch(url, { headers: { range: "bytes=2500-6000" } });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(`bytes 2500-6000/${plain.length}`);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(plain.subarray(2500, 6001))).toBe(true);

      const fromStart = await fetch(url, { headers: { range: "bytes=0-" } });
      expect(fromStart.status).toBe(206);
      expect(Buffer.from(await fromStart.arrayBuffer()).equals(plain)).toBe(true);

      const head = await fetch(url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(String(plain.length));

      const missing = await fetch(`${url}-nope`);
      expect(missing.status).toBe(404);
    } finally {
      await proxy.close();
    }
  });

  test("does not double decrypt plaintext stripes", async () => {
    const key = deriveDeezerBlowfishKey("42");
    const plain = payload(CHUNK * 3);
    const upstream = fileServer(stripeEncrypt(plain, key));
    const upstreamPort = await listen(upstream);
    const proxy = new DeezerStreamProxy();
    try {
      const url = await proxy.create({ url: `http://127.0.0.1:${upstreamPort}/x`, key });
      const response = await fetch(url, { headers: { range: "bytes=2048-4095" } });
      expect(response.status).toBe(206);
      expect(Buffer.from(await response.arrayBuffer()).equals(plain.subarray(2048, 4096))).toBe(true);
    } finally {
      await proxy.close();
    }
  });
});

describe("DeezerPublicApi", () => {
  test("propagates API errors and paginates collections", async () => {
    let port = 0;
    const track = (id: number) => ({ id, title: `Track ${id}`, duration: 210, artist: { id: 27, name: "Daft Punk" }, album: { id: 9, cover_xl: "https://cdn/cover.jpg" } });
    const server = jsonServer((url, _req, res) => {
      if (url.pathname === "/track/1") {
        res.end(JSON.stringify({ error: { type: "DataException", message: "no data", code: 800 } }));
        return;
      }
      if (url.pathname === "/album/42") {
        res.end(
          JSON.stringify({
            id: 42,
            title: "Discovery",
            cover_xl: "https://cdn/album.jpg",
            tracks: { data: [track(1)], next: `http://127.0.0.1:${port}/album/42/tracks?index=1` },
          }),
        );
        return;
      }
      if (url.pathname === "/album/42/tracks") {
        if (url.searchParams.get("index") === "1") {
          res.end(JSON.stringify({ data: [track(2)], next: `http://127.0.0.1:${port}/album/42/tracks?index=2` }));
          return;
        }
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      if (url.pathname === "/search") {
        res.end(JSON.stringify({ data: [track(3)] }));
        return;
      }
      res.writeHead(404).end("{}");
    });
    port = await listen(server);
    const api = new DeezerPublicApi({ baseUrl: `http://127.0.0.1:${port}` });

    await expect(api.track(1)).rejects.toThrow(SonariaPluginsError);
    const album = await api.album(42);
    expect((await api.albumTracks(album)).map((entry) => entry.id)).toEqual([1, 2]);
    expect((await api.searchTracks("daft punk", 1))[0]?.id).toBe(3);
  });
});

describe("DeezerGateway", () => {
  test("logs in with the arl cookie and resolves media urls", async () => {
    const cookies: Array<string | undefined> = [];
    let port = 0;
    const server = jsonServer((url, req, res) => {
      if (url.pathname === "/gw") {
        cookies.push(req.headers.cookie);
        const method = url.searchParams.get("method");
        if (method === "deezer.getUserData") {
          res.end(
            JSON.stringify({
              results: {
                checkForm: "check-form",
                USER: {
                  USER_ID: 42,
                  BLOG_NAME: "Tester",
                  OPTIONS: { license_token: "license-token", web_hq: true, web_lossless: false, license_country: "FR", offer_name: "premium" },
                },
              },
            }),
          );
          return;
        }
        if (method === "song.getListData") {
          res.end(JSON.stringify({ results: { data: [{ TRACK_TOKEN: "track-token", MD5_ORIGIN: "md5-origin" }] } }));
          return;
        }
        res.end(JSON.stringify({ results: {} }));
        return;
      }
      if (url.pathname === "/media") {
        res.end(JSON.stringify({ data: [{ media: [{ sources: [{ url: `http://127.0.0.1:${port}/encrypted` }] }] }] }));
        return;
      }
      if (url.pathname === "/bad-arl") {
        res.end(JSON.stringify({ results: { USER: { USER_ID: 0 } } }));
        return;
      }
      res.writeHead(404).end("{}");
    });
    port = await listen(server);

    const gateway = new DeezerGateway({ arl: "test-arl", gatewayUrl: `http://127.0.0.1:${port}/gw`, mediaUrl: `http://127.0.0.1:${port}/media` });
    const account = await gateway.login();
    expect(account).toEqual({
      userId: "42",
      userName: "Tester",
      licenseToken: "license-token",
      canStreamHQ: true,
      canStreamLossless: false,
      country: "FR",
      offerName: "premium",
    });
    expect(cookies[0]).toBe("arl=test-arl");

    const token = await gateway.trackToken(3135556);
    expect(token).toEqual({ token: "track-token", md5Origin: "md5-origin", mediaVersion: undefined });
    expect(await gateway.mediaUrl(token.token, "FLAC")).toBe(`http://127.0.0.1:${port}/encrypted`);

    const broken = new DeezerGateway({ arl: "nope", gatewayUrl: `http://127.0.0.1:${port}/bad-arl` });
    await expect(broken.login()).rejects.toThrow(SonariaPluginsError);
  });

  test("requires a non-empty arl", () => {
    expect(() => new DeezerGateway({ arl: " " })).toThrow(RangeError);
  });
});

describe("DeezerPlugin", () => {
  test("validates Deezer URLs only", async () => {
    const plugin = new DeezerPlugin();
    expect(await plugin.validate("https://www.deezer.com/track/3135556")).toBe(true);
    expect(await plugin.validate("https://open.spotify.com/track/1")).toBe(false);
    expect(plugin.source).toBe("deezer");
    await plugin.close();
  });
});
