import { fetchJson, requestOk, SonariaPluginsError } from "../core";

/** Stream qualities supported by the Deezer media endpoint. */
export type DeezerQuality = "MP3_128" | "MP3_320" | "FLAC";

export interface DeezerPublicArtistBrief {
  id?: number;
  name?: string;
  link?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
}

export interface DeezerPublicAlbumBrief {
  id?: number;
  title?: string;
  link?: string;
  cover?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  md5_image?: string;
}

export interface DeezerPublicTrack {
  id: number;
  readable?: boolean;
  title: string;
  title_short?: string;
  title_version?: string;
  link?: string;
  duration: number;
  rank?: number;
  preview?: string;
  md5_image?: string;
  isrc?: string;
  explicit_lyrics?: boolean;
  track_position?: number;
  disk_number?: number;
  release_date?: string;
  artist?: DeezerPublicArtistBrief;
  album?: DeezerPublicAlbumBrief;
  type?: string;
}

export interface DeezerPublicAlbum {
  id: number;
  title: string;
  link?: string;
  cover?: string;
  cover_small?: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  md5_image?: string;
  genre_id?: number;
  nb_tracks?: number;
  duration?: number;
  release_date?: string;
  artist?: DeezerPublicArtistBrief;
  tracks?: { data?: DeezerPublicTrack[]; next?: string };
  type?: string;
}

export interface DeezerPublicPlaylist {
  id: number;
  title: string;
  description?: string;
  duration?: number;
  public?: boolean;
  is_loved_track?: boolean;
  collaborative?: boolean;
  nb_tracks?: number;
  fans?: number;
  link?: string;
  picture?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  md5_image?: string;
  creator?: DeezerPublicArtistBrief;
  tracks?: { data?: DeezerPublicTrack[]; next?: string };
  type?: string;
}

export interface DeezerPublicArtist {
  id: number;
  name: string;
  link?: string;
  picture_small?: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  nb_fan?: number;
  tracklist?: string;
  type?: string;
}

export interface DeezerPublicApiOptions {
  baseUrl?: string;
  timeout?: number;
}

interface DeezerErrorBody {
  error?: { type?: string; message?: string; code?: number } | string;
}

function raiseApiError(body: DeezerErrorBody, context: string): never {
  const error = body.error;
  const message = typeof error === "string" ? error : error?.message ?? "unknown error";
  const code = typeof error === "string" ? undefined : error?.code;
  throw new SonariaPluginsError("DEEZER_API_ERROR", `Deezer API error while ${context}: ${message}${code ? ` (${code})` : ""}`);
}

/**
 * Thin client for the public, unauthenticated Deezer API (`api.deezer.com`).
 * Used for every piece of metadata: titles, artists, covers, durations,
 * playlists and 30 second previews.
 */
export class DeezerPublicApi {
  readonly baseUrl: string;
  readonly timeout: number;

  constructor(options: DeezerPublicApiOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://api.deezer.com";
    this.timeout = options.timeout ?? 15_000;
  }

  async track(id: string | number): Promise<DeezerPublicTrack> {
    return this.#get<DeezerPublicTrack>(`/track/${id}`, `loading track ${id}`);
  }

  async album(id: string | number): Promise<DeezerPublicAlbum> {
    return this.#get<DeezerPublicAlbum>(`/album/${id}`, `loading album ${id}`);
  }

  async playlist(id: string | number): Promise<DeezerPublicPlaylist> {
    return this.#get<DeezerPublicPlaylist>(`/playlist/${id}`, `loading playlist ${id}`);
  }

  async artist(id: string | number): Promise<DeezerPublicArtist> {
    return this.#get<DeezerPublicArtist>(`/artist/${id}`, `loading artist ${id}`);
  }

  async artistTop(id: string | number, limit = 50): Promise<DeezerPublicTrack[]> {
    const body = await this.#get<{ data?: DeezerPublicTrack[] }>(`/artist/${id}/top?limit=${limit}`, `loading top tracks of artist ${id}`);
    return body.data ?? [];
  }

  async searchTracks(query: string, limit = 1): Promise<DeezerPublicTrack[]> {
    const body = await this.#get<{ data?: DeezerPublicTrack[] }>(`/search?q=${encodeURIComponent(query)}&limit=${limit}`, `searching "${query}"`);
    return body.data ?? [];
  }

  /** All tracks of an album, following `tracks.next` pagination. */
  async albumTracks(album: DeezerPublicAlbum): Promise<DeezerPublicTrack[]> {
    return this.#paginate(album.tracks?.data ?? [], album.tracks?.next);
  }

  /** All tracks of a playlist, following `tracks.next` pagination. */
  async playlistTracks(playlist: DeezerPublicPlaylist): Promise<DeezerPublicTrack[]> {
    return this.#paginate(playlist.tracks?.data ?? [], playlist.tracks?.next);
  }

  async #get<T>(path: string, context: string): Promise<T> {
    const body = await fetchJson<T & DeezerErrorBody>(`${this.baseUrl}${path}`, { timeout: this.timeout });
    if (body && typeof body === "object" && "error" in body && body.error) raiseApiError(body, context);
    return body;
  }

  async #paginate(initial: DeezerPublicTrack[], next: string | undefined): Promise<DeezerPublicTrack[]> {
    const tracks = [...initial];
    let url = next;
    let pages = 0;
    while (url && pages < 50) {
      const body = await fetchJson<{ data?: DeezerPublicTrack[]; next?: string } & DeezerErrorBody>(url, { timeout: this.timeout });
      if (body.error) raiseApiError(body, "paginating tracks");
      tracks.push(...(body.data ?? []));
      url = body.next;
      pages++;
    }
    return tracks;
  }
}

export interface DeezerGatewayOptions {
  /** Deezer `arl` cookie. */
  arl: string;
  timeout?: number;
  /** Override the gateway endpoint (tests). */
  gatewayUrl?: string;
  /** Override the media endpoint (tests). */
  mediaUrl?: string;
}

export interface DeezerAccount {
  userId: string;
  userName?: string;
  licenseToken: string;
  canStreamHQ: boolean;
  canStreamLossless: boolean;
  country?: string;
  offerName?: string;
}

export interface DeezerTrackToken {
  token: string;
  md5Origin?: string;
  mediaVersion?: string;
}

const GATEWAY_URL = "https://www.deezer.com/ajax/gw-light.php";
const MEDIA_URL = "https://media.deezer.com/v1/get_url";

function hasGwError(error: unknown): boolean {
  if (!error) return false;
  if (Array.isArray(error)) return error.length > 0;
  return typeof error === "object" && Object.keys(error).length > 0;
}

/**
 * Authenticated Deezer access through the website gateway (`gw-light.php`)
 * plus the media endpoint. This is what unlocks **full length** streams when an
 * ARL cookie is available.
 */
export class DeezerGateway {
  readonly arl: string;
  readonly timeout: number;
  readonly #gatewayUrl: string;
  readonly #mediaUrl: string;
  #checkForm?: string;
  #account?: DeezerAccount;
  #loginPromise?: Promise<DeezerAccount>;

  constructor(options: DeezerGatewayOptions) {
    if (!options.arl?.trim()) throw new RangeError("DeezerGateway requires a non-empty arl");
    this.arl = options.arl.trim();
    this.timeout = options.timeout ?? 15_000;
    this.#gatewayUrl = options.gatewayUrl ?? GATEWAY_URL;
    this.#mediaUrl = options.mediaUrl ?? MEDIA_URL;
  }

  /** Log in with the ARL cookie. The result is cached. */
  login(): Promise<DeezerAccount> {
    this.#loginPromise ??= this.#login().catch((error: unknown) => {
      this.#loginPromise = undefined;
      throw error;
    });
    return this.#loginPromise;
  }

  /** The account returned by the last successful login, if any. */
  get account(): DeezerAccount | undefined {
    return this.#account;
  }

  async #login(): Promise<DeezerAccount> {
    const results = await this.#call("deezer.getUserData", {}, "null");
    const user = (results.USER ?? {}) as Record<string, unknown>;
    const userId = Number(user.USER_ID ?? 0);
    if (!userId) {
      throw new SonariaPluginsError(
        "DEEZER_INVALID_ARL",
        "Deezer rejected the ARL cookie (no user in `deezer.getUserData`). Grab a fresh `arl` value from your browser.",
      );
    }
    this.#checkForm = typeof results.checkForm === "string" ? results.checkForm : undefined;
    const options = (user.OPTIONS ?? {}) as Record<string, unknown>;
    const licenseToken = typeof options.license_token === "string" ? options.license_token : undefined;
    if (!licenseToken) {
      throw new SonariaPluginsError("DEEZER_INVALID_ARL", "Deezer did not return a license token for this ARL.");
    }
    const account: DeezerAccount = {
      userId: String(userId),
      userName: typeof user.BLOG_NAME === "string" ? user.BLOG_NAME : undefined,
      licenseToken,
      canStreamHQ: Boolean(options.web_hq || options.mobile_hq),
      canStreamLossless: Boolean(options.web_lossless || options.mobile_lossless),
      country: typeof options.license_country === "string" ? options.license_country : undefined,
      offerName: typeof options.offer_name === "string" ? options.offer_name : undefined,
    };
    this.#account = account;
    return account;
  }

  async #call(method: string, body: unknown, apiToken?: string): Promise<Record<string, unknown>> {
    const token = apiToken ?? this.#checkForm ?? "null";
    const url = `${this.#gatewayUrl}?api_version=1.0&api_token=${encodeURIComponent(token)}&input=3&method=${encodeURIComponent(method)}`;
    const response = await requestOk(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `arl=${this.arl}` },
      body: JSON.stringify(body ?? {}),
      timeout: this.timeout,
    });
    const payload = (await response.json()) as { results?: Record<string, unknown>; error?: unknown };
    if (hasGwError(payload.error)) {
      const message = JSON.stringify(payload.error);
      throw new SonariaPluginsError("DEEZER_GATEWAY_ERROR", `Deezer gateway error for ${method}: ${message}`);
    }
    return payload.results ?? {};
  }

  /** Track token required to ask for a media URL. */
  async trackToken(trackId: string | number): Promise<DeezerTrackToken> {
    const results = await this.#call("song.getListData", { SNG_IDS: [String(trackId)] });
    const data = Array.isArray(results.data) ? (results.data[0] as Record<string, unknown> | undefined) : undefined;
    const token = data?.TRACK_TOKEN;
    if (!token) {
      throw new SonariaPluginsError("DEEZER_TRACK_TOKEN", `Deezer did not return a track token for track ${trackId}.`);
    }
    return {
      token: String(token),
      md5Origin: data?.MD5_ORIGIN ? String(data.MD5_ORIGIN) : undefined,
      mediaVersion: data?.MEDIA_VERSION ? String(data.MEDIA_VERSION) : undefined,
    };
  }

  /** Ask Deezer for the (encrypted) media URL of a track token. */
  async mediaUrl(trackToken: string, quality: DeezerQuality = "MP3_128"): Promise<string> {
    const account = await this.login();
    const payload = await fetchJson<{
      data?: Array<{
        errors?: Array<{ code?: number; message?: string }>;
        media?: Array<{ sources?: Array<{ url?: string }> }>;
      }>;
    }>(this.#mediaUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        license_token: account.licenseToken,
        media: [{ type: "FULL", formats: [{ cipher: "BF_CBC_STRIPE", format: quality }] }],
        track_tokens: [trackToken],
      }),
      timeout: this.timeout,
    });
    const entry = payload.data?.[0];
    const error = entry?.errors?.[0];
    if (error) {
      throw new SonariaPluginsError("DEEZER_MEDIA_ERROR", `Deezer refused the media URL: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`);
    }
    const url = entry?.media?.[0]?.sources?.[0]?.url;
    if (!url) {
      throw new SonariaPluginsError("DEEZER_MEDIA_ERROR", `Deezer did not return a media URL for quality ${quality}.`);
    }
    return url;
  }
}
