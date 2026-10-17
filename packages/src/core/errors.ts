/**
 * Error thrown by the sonaria-plugins suite.
 *
 * The `code` is a stable, machine readable identifier such as
 * `"DEEZER_NO_PLAYABLE_SOURCE"` or `"YTDLP_NOT_INSTALLED"`.
 */
export class SonariaPluginsError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "SonariaPluginsError";
    this.code = code;
    this.details = details;
  }
}

/** Turn any thrown value into a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
