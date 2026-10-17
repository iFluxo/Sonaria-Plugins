import { spawn } from "node:child_process";
import { chmod, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { errorMessage, SonariaPluginsError } from "./errors";
import { request, USER_AGENT } from "./fetch";
import { sanitizeFileName } from "./files";

/** Just enough of yt-dlp's JSON output for a music bot. */
export interface YtDlpInfo {
  id?: string;
  title?: string;
  fulltitle?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  webpage_url?: string;
  original_url?: string;
  thumbnail?: string;
  thumbnails?: Array<{ url?: string; width?: number; height?: number; preference?: number }>;
  uploader?: string;
  channel?: string;
  uploader_url?: string;
  channel_url?: string;
  view_count?: number;
  like_count?: number;
  dislike_count?: number;
  repost_count?: number;
  age_limit?: number;
  extractor?: string;
  extractor_key?: string;
  /** Direct media URL when `-f` was used with `--dump-single-json`. */
  url?: string;
  format?: string;
  /** Formats merged into the selected one (when the selector matched several). */
  requested_formats?: YtDlpInfo[];
  acodec?: string;
  vcodec?: string;
  ext?: string;
  entries?: YtDlpInfo[];
}

export interface YtDlpOptions {
  /**
   * Path of the `yt-dlp` binary. Defaults to `$YTDLP_PATH`, then the managed
   * binary inside {@link cacheDir}, then `yt-dlp` from `PATH`.
   */
  path?: string;
  /** Extra global arguments added to every invocation. */
  args?: string[];
  /** Download format selector. Defaults to `"bestaudio/best"`. */
  format?: string;
  /** Passed as `--cookies-from-browser <value>`. */
  cookiesFromBrowser?: string;
  /** Directory used for the managed binary (and other state). */
  cacheDir?: string;
  /** Download the latest standalone binary when it is missing. */
  autoInstall?: boolean;
  /** Timeout for `--version`/JSON calls, in ms. `0` disables the timeout. */
  timeout?: number;
  /** Timeout for downloads, in ms. Defaults to 10 minutes. `0` disables it. */
  downloadTimeout?: number;
}

export interface YtDlpRunOptions {
  timeout?: number;
  /** Called for every chunk written to stdout. */
  onStdout?: (chunk: string) => void;
}

export interface YtDlpJsonOptions {
  /** Allow playlists (`--yes-playlist`). Defaults to `false`. */
  playlist?: boolean;
  /** Format selector, e.g. `"bestaudio/best"`. */
  format?: string;
  extraArgs?: string[];
  timeout?: number;
}

export interface YtDlpDownloadOptions {
  format?: string;
  /** Target directory. Defaults to the managed cache directory. */
  dir?: string;
  /** Base file name without extension. Defaults to the video id/title. */
  filename?: string;
  extraArgs?: string[];
  timeout?: number;
}

const ENV_CACHE_DIR = "SONARIA_YTDLP_DIR";
const ENV_PATH = "YTDLP_PATH";

function defaultCacheDir(): string {
  const fromEnv = process.env[ENV_CACHE_DIR];
  if (fromEnv) return fromEnv;
  return path.join(homedir(), ".sonaria-plugins", "ytdlp");
}

function standaloneAsset(): string {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
  if (process.arch === "arm") return "yt-dlp_linux_armv7l";
  return "yt-dlp_linux";
}

/**
 * Small wrapper around the `yt-dlp` binary.
 *
 * The whole suite is designed to run without yt-dlp: only the video extractor
 * plugin needs it for playback, and even there it can be replaced with a
 * manual download callback. `YtDlp.install()` downloads the standalone binary
 * from the official GitHub releases so bots can bootstrap themselves.
 */
export class YtDlp {
  readonly options: YtDlpOptions;
  #managedBinary: string;
  #version?: Promise<string | null>;

  constructor(options: YtDlpOptions = {}) {
    this.options = options;
    const cacheDir = options.cacheDir ?? defaultCacheDir();
    this.#managedBinary = path.join(cacheDir, "bin", process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  }

  /** Directory used for the managed binary and temporary downloads. */
  get cacheDir(): string {
    return path.dirname(path.dirname(this.#managedBinary));
  }

  /** The binary path configured for this instance. */
  get binary(): string {
    return this.options.path ?? process.env[ENV_PATH] ?? this.#managedBinary;
  }

  /** Last version reported by the binary, or `null` when it is not installed. */
  version(): Promise<string | null> {
    this.#version ??= this.#probe();
    return this.#version;
  }

  async #probe(): Promise<string | null> {
    try {
      const candidates = [this.binary];
      if (this.options.path === undefined && process.env[ENV_PATH] === undefined) {
        candidates.push("yt-dlp", "yt-dlp.exe");
      }
      for (const candidate of candidates) {
        try {
          const result = await this.run(["--version"], { timeout: this.options.timeout ?? 10_000 }, candidate);
          if (result.code === 0) {
            const version = result.stdout.trim().split("\n").pop()?.trim();
            if (version) return version;
          }
        } catch {
          continue;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Whether a working binary is available. */
  async available(): Promise<boolean> {
    if (await this.version()) return true;
    if (this.options.autoInstall) {
      await this.install().catch(() => undefined);
      return Boolean(await this.#probe());
    }
    return false;
  }

  /** Forget the cached `--version` probe result. */
  refresh(): void {
    this.#version = undefined;
  }

  /**
   * Download the latest standalone yt-dlp binary from the official GitHub
   * release into the managed cache directory.
   *
   * @returns The path of the downloaded binary.
   */
  async install(): Promise<string> {
    const asset = standaloneAsset();
    const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
    const response = await request(url, { timeout: 0, headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      throw new SonariaPluginsError("YTDLP_INSTALL_FAILED", `Cannot download yt-dlp from ${url} (status ${response.status}).`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(this.#managedBinary), { recursive: true });
    await writeFile(this.#managedBinary, buffer, { mode: 0o755 });
    await chmod(this.#managedBinary, 0o755).catch(() => undefined);
    this.refresh();
    return this.#managedBinary;
  }

  /**
   * Run the binary and collect stdout/stderr.
   *
   * @throws {SonariaPluginsError} when the binary cannot be spawned.
   */
  run(args: string[], options: YtDlpRunOptions = {}, binary = this.binary): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const { timeout = this.options.timeout ?? 60_000, onStdout } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeout > 0) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new SonariaPluginsError("YTDLP_TIMEOUT", `yt-dlp did not finish within ${timeout}ms.`));
        }, timeout);
        timer.unref?.();
      }
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        onStdout?.(chunk);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(
            new SonariaPluginsError(
              "YTDLP_NOT_FOUND",
              `yt-dlp binary not found (tried "${binary}"). Install it with \`ytDlp.install()\` or set the path explicitly.`,
            ),
          );
          return;
        }
        reject(error);
      });
      child.on("close", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  /** Global arguments shared by every call. */
  #baseArgs(): string[] {
    const args = ["--no-warnings", "--no-progress", "--no-call-home"];
    if (this.options.cookiesFromBrowser) args.push("--cookies-from-browser", this.options.cookiesFromBrowser);
    if (this.options.args?.length) args.push(...this.options.args);
    return args;
  }

  /** Parse the JSON metadata of a URL (single video) or playlist. */
  async json(url: string, options: YtDlpJsonOptions = {}): Promise<YtDlpInfo> {
    const args = [...this.#baseArgs(), "--dump-single-json"];
    args.push(options.playlist ? "--yes-playlist" : "--no-playlist");
    if (options.format ?? this.options.format) args.push("-f", options.format ?? this.options.format ?? "bestaudio/best");
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    args.push(url);
    const result = await this.run(args, { timeout: options.timeout ?? this.options.timeout ?? 90_000 }).catch((error: unknown) => {
      throw new SonariaPluginsError("YTDLP_ERROR", errorMessage(error));
    });
    if (result.code !== 0) {
      throw new SonariaPluginsError("YTDLP_ERROR", `yt-dlp exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    try {
      return JSON.parse(result.stdout) as YtDlpInfo;
    } catch (error) {
      throw new SonariaPluginsError("YTDLP_ERROR", `Cannot parse yt-dlp JSON output: ${errorMessage(error)}`);
    }
  }

  /** Search YouTube through `ytsearch<n>:` and return the entries. */
  async search(query: string, limit = 1): Promise<YtDlpInfo[]> {
    const info = await this.json(`ytsearch${Math.max(1, limit)}:${query}`, { playlist: true });
    return info.entries ?? [];
  }

  /**
   * Download the audio of `url` to a file and return its absolute path.
   *
   * The output name is `<id>.<ext>` inside {@link YtDlpDownloadOptions.dir}
   * (defaults to the managed `cacheDir`).
   */
  async download(url: string, options: YtDlpDownloadOptions = {}): Promise<string> {
    const dir = options.dir ?? path.join(this.cacheDir, "downloads");
    await mkdir(dir, { recursive: true });
    const base = sanitizeFileName(options.filename ?? "audio");
    const template = path.join(dir, `${base}.%(ext)s`);
    const format = options.format ?? this.options.format ?? "bestaudio/best";
    const args = [...this.#baseArgs(), "-f", format, "-o", template, "--no-playlist", "--print", "after_move:filepath"];
    if (options.extraArgs?.length) args.push(...options.extraArgs);
    args.push(url);
    const result = await this.run(args, { timeout: options.timeout ?? this.options.downloadTimeout ?? 10 * 60_000 });
    if (result.code !== 0) {
      throw new SonariaPluginsError("YTDLP_DOWNLOAD_FAILED", `yt-dlp exited with code ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`);
    }
    const printed = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .pop();
    if (printed && path.isAbsolute(printed)) {
      const exists = await stat(printed).then(() => true, () => false);
      if (exists) return printed;
    }
    // Fallback: newest file created by this download.
    const files = await readdir(dir).catch(() => [] as string[]);
    const match = files
      .filter((file) => file.startsWith(base + "."))
      .sort()
      .pop();
    if (!match) throw new SonariaPluginsError("YTDLP_DOWNLOAD_FAILED", "yt-dlp finished but no output file was found.");
    return path.join(dir, match);
  }

  /** Remove a downloaded file (best effort). */
  async remove(file: string): Promise<void> {
    await unlink(file).catch(() => undefined);
  }
}

/** Create a {@link YtDlp} instance. */
export function createYtDlp(options: YtDlpOptions = {}): YtDlp {
  return new YtDlp(options);
}
