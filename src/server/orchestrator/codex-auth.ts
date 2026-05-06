/**
 * CodexAuthManager — drives the OpenAI Codex CLI's `codex login --device-auth`
 * flow so a user can sign in with their ChatGPT subscription instead of an
 * `OPENAI_API_KEY`.
 *
 * Why a separate manager from `AuthManager` (Claude OAuth):
 *
 *   - The Codex CLI's plain `codex login` opens a localhost callback server,
 *     which is unreachable from the user's browser when ShipIt is running
 *     inside a container. `--device-auth` is OpenAI's RFC-8628 fallback for
 *     headless / remote environments — it prints a verification URL and a
 *     short user code on stdout, then polls in the background until the user
 *     approves the request in their browser.
 *   - That makes the surface much simpler than Claude's: no PTY, no readline
 *     prompts, no code-paste back into the CLI. We just spawn the process,
 *     parse the URL + user code from stdout, and wait for it to exit.
 *
 * Lifecycle and events:
 *
 *   - `codex_auth_pending` { verificationUri, userCode, expiresInSec }
 *     emitted as soon as the CLI prints the URL + code.
 *   - `codex_auth_complete` emitted after the CLI exits successfully *and*
 *     the credentials file appears on disk.
 *   - `codex_auth_failed` { reason, message } emitted on non-zero exit, the
 *     15-minute device-code timeout, or any spawn error.
 *
 * The credentials file lives at `/root/.codex/auth.json`, which in production
 * is a symlink into the shared `/credentials` volume so the login persists
 * across container rebuilds and idle cleanup. See
 * docs/119-codex-subscription-auth/plan.md for the full design.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { stripAnsi } from "../shared/strip-ansi.js";

// ---- Public types ----

export type CodexAuthFailureReason = "timeout" | "denied" | "error";

export interface CodexAuthPendingEvent {
  verificationUri: string;
  userCode: string;
  /** Device code TTL in seconds — 15 min per the OpenAI device-auth spec. */
  expiresInSec: number;
}

export interface CodexAuthFailedEvent {
  reason: CodexAuthFailureReason;
  message?: string;
}

// ---- Constants ----

/** Path the Codex CLI uses for persisted ChatGPT credentials. */
export const CODEX_CONFIG_DIR = "/root/.codex";

/** File written by `codex login --device-auth` once the user approves. */
export const CODEX_AUTH_FILE = `${CODEX_CONFIG_DIR}/auth.json`;

/**
 * OAuth 2.0 Device Authorization Grant codes are TTL-bounded by the auth
 * server. OpenAI's device flow expires after 15 minutes — match that as our
 * ceiling so we don't leave a zombie `codex login` polling forever.
 */
export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Verification URL printed by `codex login --device-auth`. Match by host so
 * we tolerate the CLI dressing the URL with query params or trailing
 * whitespace across versions.
 */
export const VERIFICATION_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device[^\s"']*/;

/**
 * User code printed by `codex login --device-auth`, format `XXXX-XXXXX`.
 * Tight regex on purpose — false positives would be surfaced as a code in
 * the UI, and the "looks like an OAuth code" shape is unmistakable.
 */
export const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/;

// ---- Helpers ----

/**
 * Ensure the directory the Codex CLI writes to actually exists. In Docker
 * `/root/.codex` is a symlink to `/credentials/.codex`; `mkdirSync` on a
 * broken symlink errors, so resolve the target first. Mirrors the
 * `ensureOnboardingComplete` dance in `auth.ts`.
 */
function ensureCodexDir(): void {
  let dir = CODEX_CONFIG_DIR;
  try {
    dir = readlinkSync(CODEX_CONFIG_DIR);
  } catch {
    // Not a symlink or doesn't exist — use the path directly.
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn("[codex-auth] Failed to create config dir:", err);
  }
}

/** True iff `auth.json` exists and has non-zero size. */
function authFileExists(): boolean {
  try {
    if (!existsSync(CODEX_AUTH_FILE)) return false;
    const st = statSync(CODEX_AUTH_FILE);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// ---- Manager ----

/**
 * Subset of `child_process.spawn` we need. Pulled out as an interface so
 * unit tests can inject a fake spawner without monkey-patching `node:child_process`.
 */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface CodexAuthManagerOptions {
  /** Inject for tests. Defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Inject for tests. Defaults to `existsSync(CODEX_AUTH_FILE) && size > 0`. */
  checkAuthFile?: () => boolean;
  /** Override the device-flow timeout. Tests use a small value. */
  timeoutMs?: number;
}

export class CodexAuthManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private outputBuffer = "";
  private pendingEmitted = false;
  private spawnFn: SpawnFn;
  private checkAuthFile: () => boolean;
  private timeoutMs: number;

  constructor(opts: CodexAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? (spawn as unknown as SpawnFn);
    this.checkAuthFile = opts.checkAuthFile ?? authFileExists;
    this.timeoutMs = opts.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
  }

  /**
   * Quick check: does `auth.json` exist on disk?
   *
   * Wired into `AgentRegistry.checkCodexAuth` so a Codex agent reports
   * `authConfigured: true` whenever a ChatGPT login is on disk, regardless
   * of whether `OPENAI_API_KEY` is also set.
   */
  checkCredentials(): boolean {
    return this.checkAuthFile();
  }

  /**
   * Whether a device flow is currently in flight. Used by HTTP handlers to
   * make `start` idempotent and by the UI to gate the Sign-in button.
   */
  get pending(): boolean {
    return this.proc !== null;
  }

  /**
   * Spawn `codex login --device-auth` and emit auth events as the flow
   * progresses. No-op if a device flow is already in flight (mirrors the
   * `if (this.proc) return` guard in `AuthManager.startOAuthFlow`).
   */
  startDeviceFlow(): void {
    if (this.proc) {
      console.log("[codex-auth] startDeviceFlow() skipped — process already running (pid %d)", this.proc.pid);
      return;
    }

    console.log("[codex-auth] Starting device-auth flow...");
    this.outputBuffer = "";
    this.pendingEmitted = false;

    // Make sure the dir exists; the CLI creates the file but expects the
    // parent dir to be writable. In Docker this also dereferences the
    // /root/.codex → /credentials/.codex symlink.
    ensureCodexDir();

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(
        "codex",
        ["login", "--device-auth"],
        {
          env: { ...process.env, HOME: "/root" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[codex-auth] Failed to spawn codex login:", msg);
      this.emit("codex_auth_failed", { reason: "error", message: msg } satisfies CodexAuthFailedEvent);
      return;
    }

    this.proc = proc;
    console.log("[codex-auth] Spawned codex login --device-auth (pid %d)", proc.pid);

    proc.stdout?.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString("utf-8")));
    proc.stderr?.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString("utf-8")));

    proc.on("error", (err: Error) => {
      console.warn("[codex-auth] Process error:", err.message);
      this.failOnce("error", err.message);
    });

    proc.on("close", (code) => {
      console.log("[codex-auth] Process exited with code", code);
      const wasRunning = this.proc === proc;
      this.proc = null;
      this.clearTimeoutHandle();

      if (!wasRunning) {
        // Already cancelled or failed — don't double-emit.
        return;
      }

      if (code === 0 && this.checkCredentials()) {
        console.log("[codex-auth] Authentication successful");
        this.emit("codex_auth_complete");
        return;
      }

      // Last-chance: dump truncated output so a future regex regression is
      // visible in orchestrator logs.
      if (this.outputBuffer.length > 0) {
        const redacted = this.outputBuffer.substring(0, 500);
        console.log("[codex-auth] Buffer (truncated, %d chars total):", this.outputBuffer.length, redacted);
      }

      this.emit("codex_auth_failed", {
        reason: "error",
        message: code === 0 ? "credentials file not written" : `codex login exited with code ${code ?? "null"}`,
      } satisfies CodexAuthFailedEvent);
    });

    // Hard ceiling — the device code itself expires after 15 minutes.
    this.timeoutHandle = setTimeout(() => {
      if (this.proc) {
        console.warn("[codex-auth] Device-auth flow timed out");
        this.failOnce("timeout", "Device code expired");
        // Kill the underlying CLI so it stops polling.
        this.killProc();
      }
    }, this.timeoutMs);
  }

  /**
   * Cancel an in-flight device flow. Idempotent — no-op when nothing is
   * running. Used by the cancel HTTP endpoint and the shutdown hook.
   */
  cancel(): void {
    if (!this.proc) return;
    console.log("[codex-auth] Cancelling device-auth flow");
    // Tear down listeners first so the `close` handler doesn't emit a
    // failure event for a cancellation the caller already observed.
    const proc = this.proc;
    this.proc = null;
    this.clearTimeoutHandle();
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    try {
      proc.kill("SIGTERM");
    } catch {
      // Process already dead — nothing to do.
    }
  }

  /**
   * Drop the on-disk credentials so the next agent turn falls back to the
   * API key path (or to no auth at all). Idempotent.
   */
  signOut(): void {
    try {
      if (existsSync(CODEX_AUTH_FILE)) {
        rmSync(CODEX_AUTH_FILE, { force: true });
        console.log("[codex-auth] Removed", CODEX_AUTH_FILE);
      }
    } catch (err) {
      console.warn("[codex-auth] Failed to remove auth file:", err);
    }
  }

  /** Kill the auth process if running (called from shutdown hook). */
  kill(): void {
    this.cancel();
  }

  // ---- Internals ----

  private handleOutput(raw: string): void {
    const cleaned = stripAnsi(raw);
    this.outputBuffer += cleaned;
    if (cleaned.trim()) {
      console.log("[codex-auth output]", cleaned.trim());
    }
    this.maybeEmitPending();
  }

  private maybeEmitPending(): void {
    if (this.pendingEmitted) return;

    const urlMatch = VERIFICATION_URL_PATTERN.exec(this.outputBuffer);
    const codeMatch = USER_CODE_PATTERN.exec(this.outputBuffer);
    if (!urlMatch || !codeMatch) return;

    const verificationUri = urlMatch[0].replace(/[)\]}>'".,]+$/, "");
    const userCode = codeMatch[1];
    const expiresInSec = Math.round(this.timeoutMs / 1000);

    console.log("[codex-auth] Detected verification URL + user code");
    this.pendingEmitted = true;
    this.emit("codex_auth_pending", {
      verificationUri,
      userCode,
      expiresInSec,
    } satisfies CodexAuthPendingEvent);
  }

  private failOnce(reason: CodexAuthFailureReason, message?: string): void {
    if (!this.proc) return;
    this.emit("codex_auth_failed", { reason, message } satisfies CodexAuthFailedEvent);
  }

  private killProc(): void {
    const proc = this.proc;
    this.proc = null;
    this.clearTimeoutHandle();
    if (!proc) return;
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
