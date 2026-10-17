import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Blowfish, BLOWFISH_IV, request, USER_AGENT } from "../core";

/** Deezer media files are obfuscated in 2048 byte stripes. */
const CHUNK_SIZE = 2048;

export interface DeezerStreamProxyOptions {
  /** Interface to bind. Defaults to `127.0.0.1` (loopback only). */
  host?: string;
  /** Port to bind, `0` picks a free one. Defaults to `0`. */
  port?: number;
  /** How long a registered stream stays valid, in ms. Defaults to 6 hours. */
  ttlMs?: number;
  /** Maximum number of registered streams kept in memory. Defaults to 256. */
  maxSessions?: number;
  /** User agent used for the upstream request. */
  userAgent?: string;
}

export interface DeezerStreamSession {
  /** Encrypted upstream media URL. */
  url: string;
  /** 16 byte Blowfish key. */
  key: Uint8Array;
}

interface RegisteredSession extends DeezerStreamSession {
  expires: number;
}

/**
 * Decrypts Deezer's `BF_CBC_STRIPE` media while it is streamed.
 *
 * FFmpeg cannot decrypt the payload itself, so the plugin hands Sonaria a short
 * lived `http://127.0.0.1:<port>/<token>` URL. Every request is forwarded to
 * the encrypted CDN URL, decrypted on the fly and streamed back, including
 * `Range` support so seeking keeps working.
 */
export class DeezerStreamProxy {
  readonly #host: string;
  readonly #port: number;
  readonly #ttlMs: number;
  readonly #maxSessions: number;
  readonly #userAgent: string;
  readonly #sessions = new Map<string, RegisteredSession>();
  #server?: Server;
  #boundPort = 0;
  #starting?: Promise<void>;

  constructor(options: DeezerStreamProxyOptions = {}) {
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 0;
    this.#ttlMs = options.ttlMs ?? 6 * 60 * 60 * 1000;
    this.#maxSessions = options.maxSessions ?? 256;
    this.#userAgent = options.userAgent ?? USER_AGENT;
  }

  /** Whether the local proxy server is currently listening. */
  get running(): boolean {
    return this.#server !== undefined;
  }

  /** The port the proxy is listening on, `0` before it started. */
  get port(): number {
    return this.#boundPort;
  }

  /**
   * Register an encrypted stream and return a local URL that FFmpeg can play.
   * The server is started lazily on first use.
   */
  async create(session: DeezerStreamSession): Promise<string> {
    await this.#start();
    this.#prune();
    const token = randomBytes(16).toString("hex");
    this.#sessions.set(token, { url: session.url, key: session.key, expires: Date.now() + this.#ttlMs });
    return `http://${this.#host}:${this.#boundPort}/${token}`;
  }

  /** Stop the server and drop all registered streams. */
  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    this.#starting = undefined;
    this.#boundPort = 0;
    this.#sessions.clear();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  async #start(): Promise<void> {
    if (this.#server) return;
    this.#starting ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => {
        void this.#handle(req, res);
      });
      server.once("error", reject);
      server.listen(this.#port, this.#host, () => {
        server.off("error", reject);
        const address = server.address();
        this.#boundPort = typeof address === "object" && address ? address.port : this.#port;
        this.#server = server;
        // The proxy must never keep the bot process alive on its own.
        server.unref();
        resolve();
      });
    });
    try {
      await this.#starting;
    } catch (error) {
      this.#starting = undefined;
      throw error;
    }
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const token = (req.url ?? "/").split("?")[0]!.replace(/^\/+/u, "");
      const session = this.#sessions.get(token);
      if (!session || session.expires <= Date.now()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Unknown or expired stream");
        return;
      }

      const range = parseRange(req.headers.range);
      const requestedStart = range?.start ?? 0;
      const alignedStart = Math.floor(requestedStart / CHUNK_SIZE) * CHUNK_SIZE;

      const upstream = await request(session.url, {
        method: "GET",
        headers: {
          "user-agent": this.#userAgent,
          ...(range ? { range: `bytes=${alignedStart}-${range.end ?? ""}` } : {}),
        },
        timeout: 0,
      });
      if (!upstream.ok && upstream.status !== 206) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end(`Upstream returned ${upstream.status}`);
        return;
      }
      const body = upstream.body;
      if (!body) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" }).end("Upstream returned an empty body");
        return;
      }

      const partial = upstream.status === 206;
      const bodyStart = partial ? alignedStart : 0;
      let total: number | undefined;
      const contentRange = upstream.headers.get("content-range");
      if (contentRange) {
        const match = /bytes\s+\d+-\d+\/(\d+|\*)/iu.exec(contentRange);
        if (match?.[1] && match[1] !== "*") total = Number(match[1]);
      }
      if (total === undefined) {
        const length = upstream.headers.get("content-length");
        if (length && /^\d+$/u.test(length)) total = Number(length) + bodyStart;
      }

      const end =
        range?.end !== undefined
          ? total !== undefined
            ? Math.min(range.end, total - 1)
            : range.end
          : total !== undefined
            ? total - 1
            : undefined;

      const headers: Record<string, string | number> = {
        "content-type": "audio/mpeg",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      };
      if (range && total !== undefined) headers["content-range"] = `bytes ${requestedStart}-${end ?? total - 1}/${total}`;
      if (end !== undefined) headers["content-length"] = Math.max(0, end - requestedStart + 1);

      res.writeHead(range ? 206 : 200, headers);
      if (req.method === "HEAD") {
        res.end();
        await body.cancel().catch(() => undefined);
        return;
      }

      const source = Readable.fromWeb(body as unknown as WebReadableStream<Uint8Array>);
      const decryptor = new StripeDecryptor(session.key, bodyStart / CHUNK_SIZE, requestedStart - bodyStart);
      const abort = () => source.destroy();
      res.once("close", abort);
      await pipeline(source, decryptor, res).catch((error: unknown) => {
        if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
      });
      res.off("close", abort);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Internal proxy error");
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [token, session] of this.#sessions) {
      if (session.expires > now && this.#sessions.size <= this.#maxSessions) break;
      if (session.expires <= now) this.#sessions.delete(token);
    }
    while (this.#sessions.size > this.#maxSessions) {
      const oldest = this.#sessions.keys().next();
      if (oldest.done) break;
      this.#sessions.delete(oldest.value);
    }
  }
}

/**
 * Stream transformer that applies Deezer's stripe scheme:
 * every third 2048 byte chunk (0, 3, 6, …) is Blowfish-CBC encrypted with a
 * fixed IV, all other bytes are plaintext. Partial trailing chunks are plain.
 */
class StripeDecryptor extends Transform {
  readonly #blowfish: Blowfish;
  #chunkIndex: number;
  #skip: number;
  #carry: Buffer = Buffer.alloc(0);

  constructor(key: Uint8Array, startChunk: number, skip: number) {
    super();
    this.#blowfish = new Blowfish(key);
    this.#chunkIndex = startChunk;
    this.#skip = Math.max(0, skip);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const data = this.#carry.length > 0 ? Buffer.concat([this.#carry, chunk]) : chunk;
      const complete = data.length - (data.length % CHUNK_SIZE);
      if (complete <= 0) {
        this.#carry = Buffer.from(data);
        callback();
        return;
      }
      const out = Buffer.allocUnsafe(complete);
      for (let offset = 0; offset < complete; offset += CHUNK_SIZE) {
        if (this.#chunkIndex % 3 === 0) {
          this.#blowfish.decryptCbc(data, offset, CHUNK_SIZE, out, BLOWFISH_IV);
        } else {
          data.copy(out, offset, offset, offset + CHUNK_SIZE);
        }
        this.#chunkIndex++;
      }
      this.#carry = Buffer.from(data.subarray(complete));
      this.#push(out);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      if (this.#carry.length > 0) {
        // Trailing partial chunks are never encrypted.
        this.#push(this.#carry);
      }
      this.#carry = Buffer.alloc(0);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  #push(buffer: Buffer): void {
    if (buffer.length === 0) return;
    let result: Uint8Array = buffer;
    if (this.#skip > 0) {
      const skip = Math.min(this.#skip, result.length);
      this.#skip -= skip;
      result = result.subarray(skip);
    }
    if (result.length > 0) this.push(result);
  }
}

function parseRange(header: string | undefined): { start: number; end?: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/u.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  if (!Number.isFinite(start) || start < 0) return null;
  const end = match[2] ? Number(match[2]) : undefined;
  return end !== undefined && Number.isFinite(end) && end >= start ? { start, end } : { start };
}
