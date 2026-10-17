/** Browser-like user agent used for every outbound request. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Default timeout for a single HTTP request, in milliseconds. */
export const DEFAULT_TIMEOUT = 15_000;

/** Error raised when an HTTP request answers with a non-2xx status. */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body?: string;

  constructor(status: number, url: string, body?: string) {
    super(`Request to ${url} failed with status ${status}${body ? `: ${truncate(body)}` : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function truncate(value: string, length = 200): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

export interface FetchOptions extends RequestInit {
  /** Request timeout in milliseconds. Defaults to {@link DEFAULT_TIMEOUT}. */
  timeout?: number;
}

/** `fetch` with a user agent and a timeout applied. */
export async function request(url: string, options: FetchOptions = {}): Promise<Response> {
  const { timeout = DEFAULT_TIMEOUT, headers, ...rest } = options;
  const merged = new Headers(headers);
  if (!merged.has("user-agent")) merged.set("user-agent", USER_AGENT);
  const init: RequestInit = { ...rest, headers: merged, redirect: rest.redirect ?? "follow" };
  if (timeout > 0) init.signal = AbortSignal.timeout(timeout);
  return fetch(url, init);
}

/** `fetch` that throws {@link HttpError} on non-2xx responses. */
export async function requestOk(url: string, options: FetchOptions = {}): Promise<Response> {
  const response = await request(url, options);
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new HttpError(response.status, url, body);
  }
  return response;
}

/** Fetch a URL and parse the response body as JSON, throwing on failure. */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const response = await requestOk(url, options);
  return (await response.json()) as T;
}

/** Fetch a URL and return the response body as text, throwing on failure. */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
  const response = await requestOk(url, options);
  return response.text();
}
