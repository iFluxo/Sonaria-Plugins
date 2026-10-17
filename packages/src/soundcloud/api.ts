import { errorMessage, fetchText, HttpError, requestOk, SonariaPluginsError } from "../core";

export interface SoundCloudUser {
  id?: number;
  kind?: string;
  username?: string;
  permalink_url?: string;
  avatar_url?: string;
}

export interface SoundCloudTranscoding {
  url: string;
  preset?: string;
  duration?: number;
  snipped?: boolean;
  format?: {
    protocol?: string;
    mime_type?: string;
  };
}

export interface SoundCloudTrack {
  id?: number;
  kind?: string;
  title?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  duration?: number;
  full_duration?: number;
  playback_count?: number;
  likes_count?: number | null;
  reposts_count?: number | null;
  comment_count?: number | null;
  created_at?: string;
  genre?: string;
  policy?: string;
  monetization_model?: string;
  track_authorization?: string;
  user?: SoundCloudUser;
  media?: {
    transcodings?: SoundCloudTranscoding[];
  };
}

export interface SoundCloudPlaylist {
  id?: number;
  kind?: string;
  title?: string;
  permalink_url?: string;
  artwork_url?: string | null;
  duration?: number;
  track_count?: number;
  user?: SoundCloudUser;
  tracks?: SoundCloudTrack[];
}

export type SoundCloudProtocol = "progressive" | "hls";

export interface SoundCloudApiOptions {
  /** Explicit API client id. Discovered from SoundCloud's assets when omitted. */
  clientId?: string;
  /** OAuth token, enables full length streams for tracks that require it. */
  oauthToken?: string;
  /** Request timeout in ms. Defaults to `15_000`. */
  timeout?: number;
  /** API base, defaults to `https://api-v2.soundcloud.com`. */
  baseUrl?: string;
  /** Page scanned for the client id, defaults to `https://soundcloud.com/`. */
  pageUrl?: string;
}

type QueryParams = Record<string, string | number | undefined>;

const CLIENT_ID_PATTERN = /client_id:"([a-zA-Z0-9]{32})"/u;
const SCRIPT_PATTERN = /src="([^"]+\.js)"/gu;

/**
 * Minimal, dependency free client for SoundCloud's private `api-v2`.
 *
 * SoundCloud does not hand out API keys anymore, so the client id is
 * discovered exactly like the website does: scan the `a-v2.sndcdn.com` bundle
 * for the `client_id:"…"` literal. An OAuth token can be supplied for accounts
 * that need it (full length streams of `SNIP` protected tracks).
 */
export class SoundCloudApi {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly #pageUrl: string;
  readonly #oauthToken?: string;
  #clientId?: string;
  #clientIdPromise?: Promise<string>;

  constructor(options: SoundCloudApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api-v2.soundcloud.com";
    this.timeout = options.timeout ?? 15_000;
    this.#pageUrl = options.pageUrl ?? "https://soundcloud.com/";
    this.#oauthToken = options.oauthToken;
    this.#clientId = options.clientId;
  }

  /** The client id in use, if it was discovered or configured already. */
  get clientId(): string | undefined {
    return this.#clientId;
  }

  /** Whether an OAuth token was configured. */
  get authenticated(): boolean {
    return this.#oauthToken !== undefined;
  }

  /** Resolve a usable client id, discovering one from SoundCloud when needed. */
  async getClientId(): Promise<string> {
    if (this.#clientId) return this.#clientId;
    this.#clientIdPromise ??= this.#discoverClientId()
      .then((clientId) => {
        this.#clientId = clientId;
        return clientId;
      })
      .catch((error: unknown) => {
        this.#clientIdPromise = undefined;
        throw error;
      });
    return this.#clientIdPromise;
  }

  /** Search tracks (`/search/tracks`). */
  async searchTracks(query: string, limit = 1): Promise<SoundCloudTrack[]> {
    const body = await this.#json<{ collection?: SoundCloudTrack[] }>("search/tracks", { q: query, limit });
    return body.collection ?? [];
  }

  /** Search sets/playlists (`/search/playlists`). */
  async searchPlaylists(query: string, limit = 1): Promise<SoundCloudPlaylist[]> {
    const body = await this.#json<{ collection?: SoundCloudPlaylist[] }>("search/playlists", { q: query, limit });
    return body.collection ?? [];
  }

  /** Resolve a public `soundcloud.com` URL to a track or playlist. */
  async resolve(url: string): Promise<SoundCloudTrack | SoundCloudPlaylist> {
    const body = await this.#json<SoundCloudTrack | SoundCloudPlaylist>("resolve", { url });
    const kind = body.kind;
    if (kind !== "track" && kind !== "playlist") {
      throw new SonariaPluginsError("SOUNDCLOUD_UNSUPPORTED_RESOURCE", `Only public SoundCloud tracks and sets are supported (got "${kind ?? "unknown"}").`);
    }
    return body;
  }

  /** Fetch a track by numeric id or by URL. */
  async track(idOrUrl: string | number): Promise<SoundCloudTrack> {
    if (typeof idOrUrl === "number" || /^\d+$/u.test(String(idOrUrl))) {
      return this.#json<SoundCloudTrack>(`tracks/${idOrUrl}`, {});
    }
    const resolved = await this.resolve(String(idOrUrl));
    if (resolved.kind !== "track") {
      throw new SonariaPluginsError("SOUNDCLOUD_UNSUPPORTED_RESOURCE", `${idOrUrl} is a set, not a track.`);
    }
    return resolved;
  }

  /** Fetch a set/playlist by numeric id or by URL. */
  async playlist(idOrUrl: string | number): Promise<SoundCloudPlaylist> {
    if (typeof idOrUrl === "number" || /^\d+$/u.test(String(idOrUrl))) {
      return this.#json<SoundCloudPlaylist>(`playlists/${idOrUrl}`, {});
    }
    const resolved = await this.resolve(String(idOrUrl));
    if (resolved.kind !== "playlist") {
      throw new SonariaPluginsError("SOUNDCLOUD_UNSUPPORTED_RESOURCE", `${idOrUrl} is a track, not a set.`);
    }
    return resolved;
  }

  /** Related tracks of a track (`/tracks/:id/related`). */
  async related(trackId: string | number, limit = 10): Promise<SoundCloudTrack[]> {
    const body = await this.#json<{ collection?: SoundCloudTrack[] }>(`tracks/${trackId}/related`, { limit });
    return body.collection ?? [];
  }

  /**
   * Turn a track's `media.transcodings` into a playable URL.
   *
   * Prefers a progressive (plain MP3) transcoding and falls back to HLS, which
   * FFmpeg can consume directly. Tracks protected by the `SNIP` policy only
   * yield their 30 second preview unless `oauthToken` was configured.
   */
  async streamUrl(track: SoundCloudTrack, preferred: SoundCloudProtocol = "progressive"): Promise<string> {
    const transcodings = track.media?.transcodings ?? [];
    if (!transcodings.length) {
      throw new SonariaPluginsError("SOUNDCLOUD_NO_STREAM", `SoundCloud returned no transcodings for "${track.title ?? track.id ?? "track"}".`);
    }
    const ordered = [...transcodings].sort((a, b) => rank(a, preferred) - rank(b, preferred));
    let lastError: unknown;
    for (const transcoding of ordered) {
      try {
        const body = await this.#json<{ url?: string }>(transcoding.url, { track_authorization: track.track_authorization });
        if (body.url) return body.url;
      } catch (error) {
        lastError = error;
      }
    }
    throw new SonariaPluginsError("SOUNDCLOUD_NO_STREAM", `SoundCloud did not return a playable stream for track ${track.id ?? "?"}: ${errorMessage(lastError)}`);
  }

  async #discoverClientId(): Promise<string> {
    const page = await fetchText(this.#pageUrl, { headers: this.#headers(), timeout: this.timeout });
    const scripts: string[] = [];
    for (const match of page.matchAll(SCRIPT_PATTERN)) {
      const src = match[1];
      if (!src) continue;
      try {
        scripts.push(new URL(src, this.#pageUrl).toString());
      } catch {
        // Ignore unparsable script sources.
      }
    }
    // SoundCloud ships its client id in the `a-v2.sndcdn.com` bundles: try
    // those first, then any other script on the page.
    const ordered = [...new Set(scripts)].sort((a, b) => Number(b.includes("a-v2.sndcdn.com")) - Number(a.includes("a-v2.sndcdn.com")));
    for (const asset of ordered.slice(0, 16)) {
      const script = await fetchText(asset, { headers: this.#headers(), timeout: this.timeout }).catch(() => "");
      const clientId = CLIENT_ID_PATTERN.exec(script)?.[1];
      if (clientId) return clientId;
    }
    throw new SonariaPluginsError("SOUNDCLOUD_NO_CLIENT_ID", "Could not discover a SoundCloud client id. Pass `clientId` explicitly.");
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = {
      origin: "https://soundcloud.com",
      referer: "https://soundcloud.com/",
    };
    if (this.#oauthToken) headers.authorization = `OAuth ${this.#oauthToken}`;
    return headers;
  }

  async #json<T>(pathOrUrl: string, params: QueryParams): Promise<T> {
    return this.#attempt<T>(pathOrUrl, params, false);
  }

  async #attempt<T>(pathOrUrl: string, params: QueryParams, retried: boolean): Promise<T> {
    const url = new URL(/\w+:\/\//u.test(pathOrUrl) ? pathOrUrl : `${this.baseUrl}/${pathOrUrl}`);
    if (!this.#oauthToken) url.searchParams.set("client_id", await this.getClientId());
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    try {
      const response = await requestOk(url.toString(), { headers: this.#headers(), timeout: this.timeout });
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof HttpError) {
        if ((error.status === 401 || error.status === 403) && !this.#oauthToken && !retried) {
          // The cached client id went stale: force a rediscovery and retry once.
          this.#clientId = undefined;
          this.#clientIdPromise = undefined;
          return this.#attempt<T>(pathOrUrl, params, true);
        }
        if (error.status === 401 || error.status === 403) {
          throw new SonariaPluginsError("SOUNDCLOUD_FORBIDDEN", "SoundCloud rejected the request (401/403). The client id or OAuth token is invalid or expired.");
        }
        if (error.status === 404) {
          throw new SonariaPluginsError("SOUNDCLOUD_NOT_FOUND", `SoundCloud has nothing at ${pathOrUrl}.`);
        }
      }
      throw error;
    }
  }
}

function rank(transcoding: SoundCloudTranscoding, preferred: SoundCloudProtocol): number {
  const protocol = transcoding.format?.protocol;
  if (protocol === preferred) return 0;
  if (protocol === "progressive" || protocol === "hls") return 1;
  return 2;
}
