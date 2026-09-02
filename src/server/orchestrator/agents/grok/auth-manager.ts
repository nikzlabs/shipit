/**
 * XaiAuthManager — drives `grok login --device-auth` so a user can connect a
 * SuperGrok / X Premium+ **subscription** instead of paying per token through
 * `XAI_API_KEY` (planning#435, docs/274 reqs 11–13).
 *
 * Named for the vendor, not the CLI. `xai-oauth` is a login to xAI's account
 * system; `grok` is merely the harness that can present the result. The
 * distinction is the whole point of keying auth managers by
 * `LoginIntegrationId` (see `agent-auth-manager.ts`).
 *
 * ## Why this is the Codex shape and not the Claude one
 *
 * `grok login` alone opens a localhost callback the user's browser cannot reach
 * from inside a container, exactly as `codex login` does. `--device-auth`
 * (alias `--device-code`) is xAI's RFC-8628 fallback: it prints a verification
 * URL and a short user code, then polls until the user approves in a browser.
 * No PTY, no readline, no code to paste back — so this manager spawns, scrapes
 * the challenge, and waits for the exit.
 *
 * ## Two things it does NOT share with Codex, both verified against CLI 1.0.1
 *
 *  - **The challenge is printed on STDERR, not stdout.** Captured live: stdout
 *    was empty for the whole flow while stderr carried "To sign in, open this
 *    URL in your browser", the URL, and the code. Both streams are read anyway
 *    (a future version could move it), but a manager that watched only stdout
 *    would emit no challenge at all and time out silently after 15 minutes.
 *  - **The user code is `XXXX-XXXX`** (4-4), where Codex's is 4-5. A regex
 *    copied from the Codex manager matches nothing here.
 *
 * ## Where the credentials land
 *
 * `$GROK_HOME/auth.json`, and `GROK_HOME` is the `.grok` DIRECTORY rather than
 * the home above it (`shared/agent-home.ts` records the live verification).
 * Both `HOME` and `GROK_HOME` are set so the CLI cannot reach a different
 * account's root through either name.
 *
 * The token is short-lived — ~6 hours, with a refresh token beside it — so
 * connecting once is only half of req 12/13. The other half is
 * `token-sync-manager.ts`'s `AGENT_TOKEN_FILES.grok`, which syncs the file into
 * each turn and publishes a rotation back to this source; without that a
 * session outliving one token would 401 mid-work and a fresh container would
 * inherit a dead refresh token.
 */

import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import { killChild } from "../../../shared/kill-child.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { ensureConfigDir, firstEpochMs, probeNestedString } from "../agent-auth-base.js";
import type {
  AgentAuthManager,
  AgentAuthManagerEvents,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
import type { LoginIntegrationId } from "../../../shared/catalogue/types.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

// ---- Public types ----

export type XaiAuthFailureReason = "timeout" | "denied" | "error";

export interface XaiAuthPendingEvent {
  verificationUri: string;
  userCode: string;
  /** Device-code TTL in seconds, as ShipIt bounds it — see {@link DEVICE_AUTH_TIMEOUT_MS}. */
  expiresInSec: number;
}

// ---- Constants ----

/** Legacy singleton HOME, for a flow started with no account scope. */
const XAI_DEFAULT_HOME = "/root";

/**
 * Grok's config root under an account root (docs/150) or the singleton HOME.
 *
 * This is `GROK_HOME` itself, NOT the directory above it. Getting that backwards
 * points the CLI one level off its own credentials and fails as "not
 * authenticated" rather than as an error naming a path.
 */
export function grokConfigDirFor(credentialDir: string | null): string {
  return path.join(credentialDir ?? XAI_DEFAULT_HOME, ".grok");
}

/** `auth.json` path for an account root or the singleton path. */
export function grokAuthFileFor(credentialDir: string | null): string {
  return path.join(grokConfigDirFor(credentialDir), "auth.json");
}

/** The singleton path, for a build with no provider accounts. */
export const GROK_AUTH_FILE = grokAuthFileFor(null);

/**
 * Hard ceiling on a device flow, so a cancelled browser tab cannot leave a
 * `grok login` polling forever.
 *
 * **ShipIt's bound, not a reading of xAI's TTL.** The CLI prints no expiry and
 * the authorization server's own lifetime is not exposed anywhere this manager
 * can see, so this matches the Codex ceiling rather than claiming to know. It is
 * also what `expiresInSec` reports, which is honest as an upper bound on how
 * long ShipIt will wait and is not a promise that the code lives that long.
 */
export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * The verification URL, matched by HOST so query params and trailing
 * punctuation across CLI versions do not break it. Observed live:
 * `https://accounts.x.ai/oauth2/device?user_code=XXXX-XXXX`.
 */
export const VERIFICATION_URL_PATTERN = /https:\/\/accounts\.x\.ai\/oauth2\/device[^\s"']*/;

/**
 * The user code, format `XXXX-XXXX`. Anchored on both sides so the copy of the
 * code embedded in the URL's own query string is matched identically to the one
 * printed on its own line — either is the same string, so whichever the buffer
 * yields first is correct.
 *
 * Four-and-four, deliberately not Codex's four-and-five: the shapes differ and a
 * borrowed regex silently matches nothing.
 */
export const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

// ---- Helpers ----

/** True iff `authFile` exists and is a non-empty regular file. */
function authFileExistsAt(authFile: string): boolean {
  try {
    if (!existsSync(authFile)) return false;
    const st = statSync(authFile);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * The stored token records, in probe order.
 *
 * The CLI writes `auth.json` **scope-keyed**, and the key is not a name anyone
 * would guess: the live file's single top-level key is
 * `https://auth.x.ai::<client-uuid>`. So a reader keyed on a fixed string is not
 * merely brittle, it could never have been written — which is why this walks the
 * top-level objects and takes the first that carries what is being asked for.
 * The bare object is probed too, so a future flat layout degrades to the same
 * answer rather than to null.
 */
function tokenRecords(obj: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [obj];
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * The access token from a parsed `auth.json`, or null.
 *
 * **`key` first, and that is the real field name** (verified against a live
 * `grok login --device-auth` on 2026-08-19: the record holds `key`, a JWT, with
 * `refresh_token` beside it). `access_token` is probed after it only as
 * tolerance for a rename; a reader that assumed the conventional OAuth spelling
 * — as this one first did — returns null on every real file and reports a
 * connected account as unauthenticated.
 *
 * Exported for unit tests.
 */
export function extractXaiAccessToken(obj: Record<string, unknown>): string | null {
  for (const record of tokenRecords(obj)) {
    const token = probeNestedString(record, ["key", "access_token", "accessToken"], "tokens");
    if (token) return token;
  }
  return null;
}

/** Epoch ms from an ISO-8601 instant, or null. */
function isoToEpochMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Token freshness (epoch ms) — a strictly larger value means a
 * more-recently-refreshed token.
 *
 * `token-sync-manager.ts` compares source against session with this, so it
 * decides whether a rotation propagates and whether a session's own refresh is
 * safe from being clobbered. **A reader that always returns null does not fail
 * safe here**: it makes the sync-in guard read "the session has no provable
 * token" and copy unconditionally, so a session that had just refreshed would
 * lose its live token to a stale source. That is exactly what the first cut of
 * this function did, by accepting only NUMERIC expiries.
 *
 * The live file's `expires_at` is an ISO-8601 **string**
 * (`2026-08-19T19:37:53.982150334Z`, six hours after `create_time` — which is
 * where req 13's "~6h" is measured rather than assumed). So ISO is probed first,
 * then a numeric expiry, and finally the access token's own JWT `exp` claim —
 * which advances on every refresh and so is a true freshness signal in its own
 * right, and covers a file whose expiry field is renamed.
 *
 * Exported for unit tests and for the sync manager's freshness table.
 */
export function readXaiTokenFreshness(obj: Record<string, unknown>): number | null {
  for (const record of tokenRecords(obj)) {
    const tokens = record.tokens && typeof record.tokens === "object"
      ? (record.tokens as Record<string, unknown>)
      : record;
    const iso = isoToEpochMs(record.expires_at)
      ?? isoToEpochMs(record.expiresAt)
      ?? isoToEpochMs(tokens.expires_at)
      ?? isoToEpochMs(tokens.expiresAt);
    if (iso !== null) return iso;
    const numeric = firstEpochMs([
      record.expires_at, record.expiresAt, tokens.expires_at, tokens.expiresAt,
    ]);
    if (numeric !== null) return numeric;
    const exp = jwtExpiryMs(probeNestedString(record, ["key", "access_token", "accessToken"], "tokens"));
    if (exp !== null) return exp;
  }
  return null;
}

/** The `exp` claim of a JWT, in epoch ms. Null for anything unparseable. */
function jwtExpiryMs(jwt: string | null): number | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    // JWT `exp` is seconds by spec.
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

/**
 * docs/274 req 15 — the xAI account this `auth.json` belongs to.
 *
 * `user_id` is the stable key: an account's own id, so it survives an email
 * change and tells two accounts apart that a plan label could not. `email` is a
 * label default only, never the key.
 *
 * Null when there is no usable id, which is what an older file, a
 * key-only install, or a half-written file all look like — and which
 * `refuseIfAlreadyConnected` degrades to "connect anyway, no duplicate
 * detection" rather than failing the connect over.
 */
export function extractXaiIdentity(
  obj: Record<string, unknown>,
): { externalId: string; email?: string } | null {
  for (const record of tokenRecords(obj)) {
    const externalId = probeNestedString(record, ["user_id", "userId"], "user", ["id", "user_id"]);
    if (!externalId) continue;
    const email = probeNestedString(record, ["email"], "user");
    return { externalId, ...(email ? { email } : {}) };
  }
  return null;
}

/**
 * There is deliberately **no plan reader**, and this is a finding rather than an
 * omission (docs/274 req 15).
 *
 * Codex has one because OpenAI stamps `chatgpt_plan_type` — "Plus", "Pro" — onto
 * the token, and Claude reads its tier off the credentials file. xAI publishes
 * neither. The live `auth.json` carries `user_id`, `email`, `first_name`,
 * `last_name`, `team_id`, `principal_type: "User"` and `auth_mode: "oidc"`, and
 * the access token's own claims add only `tier: 1` — an opaque integer whose
 * mapping to a product name ("SuperGrok"? "X Premium+"?) is nowhere stated.
 *
 * Rendering "Tier 1" tells the user nothing, and mapping 1 to a plan name would
 * be an invention on a row people use to tell two subscriptions apart. So the
 * row shows the identity xAI does report — the email, keyed on `user_id` — and
 * says nothing about the plan. That is the same rule req 16 applies to the
 * missing usage API, for the same reason: an honest absence beats a plausible
 * fabrication. It gains a reader if xAI ever reports a plan name.
 */

/**
 * {@link readXaiTokenFreshness} over a PATH — the shape `token-sync-manager.ts`'s
 * per-agent freshness table takes. Source and session files are always compared
 * with the same reader, so the two forms must not diverge; this one exists
 * purely so the sync manager does not re-implement the parse.
 */
export function readXaiTokenFreshnessFile(file: string): number | null {
  const parsed = readXaiAuthFile(file);
  return parsed ? readXaiTokenFreshness(parsed) : null;
}

/** Parse an `auth.json` off disk, or null when it is missing or unreadable. */
export function readXaiAuthFile(authFile: string): Record<string, unknown> | null {
  try {
    if (!authFileExistsAt(authFile)) return null;
    const parsed = JSON.parse(readFileSync(authFile, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    console.warn("[xai-auth] Failed to parse auth.json:", err instanceof Error ? err.message : err);
    return null;
  }
}

// ---- Manager ----

/** The `child_process.spawn` slice this manager needs, so tests can inject one. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface XaiAuthManagerOptions {
  /** Inject for tests. Defaults to `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Inject for tests. Defaults to the singleton `auth.json` existence check. */
  checkAuthFile?: () => boolean;
  /** Override the device-flow ceiling. Tests use a small value. */
  timeoutMs?: number;
}

export interface XaiAuthManagerEvents extends AgentAuthManagerEvents {
  xai_auth_pending: [ev: XaiAuthPendingEvent];
  xai_auth_complete: [];
  xai_auth_failed: [payload: { reason: XaiAuthFailureReason; message?: string }];
}

export class XaiAuthManager extends EventEmitter<XaiAuthManagerEvents> implements AgentAuthManager {
  readonly loginId: LoginIntegrationId = "xai-oauth";

  private proc: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private outputBuffer = "";
  private pendingEmitted = false;
  /**
   * The last challenge emitted, retained until the flow ends. Replayed to fresh
   * SSE clients and re-broadcast when `start()` is called against a flow already
   * in flight — without it a page reload mid-flow strands the user on a dead
   * "Sign in" button while the CLI is still polling.
   */
  private lastPendingEvent: XaiAuthPendingEvent | null = null;
  private spawnFn: SpawnFn;
  private checkAuthFile: () => boolean;
  private timeoutMs: number;
  /** Credential root the in-flight flow is scoped to, or null for the singleton. */
  private activeCredentialDir: string | null = null;
  /** Provider-account id for the in-flight flow, or null when singleton. */
  private activeFlowAccountId: string | null = null;

  constructor(opts: XaiAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? spawn;
    this.checkAuthFile = opts.checkAuthFile ?? (() => authFileExistsAt(GROK_AUTH_FILE));
    this.timeoutMs = opts.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
  }

  /** Does a login exist on disk for this scope? */
  checkCredentials(credentialDir?: string): boolean {
    const scoped = credentialDir ?? this.activeCredentialDir;
    if (scoped) return authFileExistsAt(grokAuthFileFor(scoped));
    return this.checkAuthFile();
  }

  getActiveAccountId(): string | null {
    return this.activeFlowAccountId;
  }

  start(opts?: AgentAuthStartOptions): void {
    this.startDeviceFlow(opts);
  }

  isConfigured(opts?: AgentAuthScopeOptions): boolean {
    return this.checkCredentials(opts?.credentialDir);
  }

  getPendingPayload(): AgentAuthPendingDetails | null {
    if (!this.lastPendingEvent) return null;
    return { kind: "device-code", ...this.lastPendingEvent };
  }

  /** Whether a device flow is in flight — makes `start` idempotent. */
  get pending(): boolean {
    return this.proc !== null;
  }

  /** The last challenge emitted, or null. Replayed into the SSE snapshot. */
  getPendingEvent(): XaiAuthPendingEvent | null {
    return this.lastPendingEvent;
  }

  /**
   * The account identity this scope's `auth.json` reports, for the account row
   * (req 15). Null when there is no readable login.
   *
   * Identity only — no plan, because xAI reports none. See the note above
   * {@link extractXaiIdentity}'s neighbour.
   */
  readIdentity(credentialDir?: string): { externalId: string; email?: string } | null {
    const parsed = readXaiAuthFile(grokAuthFileFor(credentialDir ?? this.activeCredentialDir));
    return parsed ? extractXaiIdentity(parsed) : null;
  }

  /**
   * Spawn `grok login --device-auth` and emit the flow's lifecycle. No-op while
   * one is already in flight, beyond re-broadcasting the cached challenge.
   */
  startDeviceFlow(opts?: AgentAuthStartOptions): void {
    if (this.proc) {
      console.log("[xai-auth] startDeviceFlow() skipped — process already running (pid %d)", this.proc.pid);
      if (this.lastPendingEvent) {
        this.emit("xai_auth_pending", this.lastPendingEvent);
        this.emit("pending", { kind: "device-code", ...this.lastPendingEvent });
      }
      return;
    }

    console.log("[xai-auth] Starting device-auth flow...");
    this.outputBuffer = "";
    this.pendingEmitted = false;
    this.lastPendingEvent = null;
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    const home = this.activeCredentialDir ?? XAI_DEFAULT_HOME;
    const configDir = grokConfigDirFor(this.activeCredentialDir);

    // The CLI writes the file but expects its parent to exist; in Docker this
    // also dereferences the `~/.grok` → `/credentials/.grok` symlink.
    ensureConfigDir(configDir, "[xai-auth]");

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // The `.grok` dir itself — see `grokConfigDirFor`. Set explicitly rather
      // than left to the CLI's `$HOME/.grok` default, because an ambient
      // `GROK_HOME` inherited from the orchestrator's own environment would send
      // every account's login to one root.
      GROK_HOME: configDir,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      // Tags the OAuth flow with the integrating product, matching the adapter's
      // spawn env so a subscription connected here is attributed to ShipIt.
      GROK_OAUTH2_REFERRER: "shipit",
    };
    // `GROK_AUTH` / `GROK_AUTH_PATH` point the CLI at a DIFFERENT token store,
    // so an inherited one would write this account's login somewhere no session
    // reads — the scoped home defeated by an environment variable. `XAI_API_KEY`
    // goes with them for consistency; it is verified not to block the flow (a
    // challenge was captured with one set), and a login is about the file.
    scrubHarnessEnvCredentials(env, "grok");

    let proc: ChildProcess;
    try {
      proc = this.spawnFn("grok", ["login", "--device-auth"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[xai-auth] Failed to spawn grok login:", msg);
      this.emit("xai_auth_failed", { reason: "error", message: msg });
      this.emit("failed", { reason: "error", message: msg });
      this.clearActiveScope();
      return;
    }

    this.proc = proc;
    console.log("[xai-auth] Spawned grok login --device-auth (pid %d)", proc.pid);

    // BOTH streams. The challenge was observed on stderr (see the header);
    // stdout is read so a version that moves it still works.
    proc.stdout?.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString("utf-8")));
    proc.stderr?.on("data", (chunk: Buffer) => this.handleOutput(chunk.toString("utf-8")));

    proc.on("error", (err: Error) => {
      console.warn("[xai-auth] Process error:", err.message);
      this.failOnce("error", err.message);
    });

    proc.on("close", (code) => {
      console.log("[xai-auth] Process exited with code", code);
      const wasRunning = this.proc === proc;
      this.proc = null;
      this.lastPendingEvent = null;
      this.clearTimeoutHandle();

      if (!wasRunning) return; // already cancelled or failed — don't double-emit

      if (code === 0 && this.checkCredentials()) {
        console.log("[xai-auth] Authentication successful");
        this.emit("xai_auth_complete");
        // The SSE wiring reads `getActiveAccountId()` synchronously inside this
        // handler, so the scope is cleared only after the emit returns.
        this.emit("complete");
        this.clearActiveScope();
        return;
      }

      if (this.outputBuffer.length > 0) {
        console.log("[xai-auth] Buffer (truncated, %d chars total):", this.outputBuffer.length, this.outputBuffer.slice(0, 500));
      }

      const message = code === 0
        ? "credentials file not written"
        : `grok login exited with code ${code ?? "null"}`;
      this.emit("xai_auth_failed", { reason: "error", message });
      this.emit("failed", { reason: "error", message });
      this.clearActiveScope();
    });

    this.timeoutHandle = setTimeout(() => {
      if (this.proc) {
        console.warn("[xai-auth] Device-auth flow timed out");
        this.failOnce("timeout", "Device code expired");
        this.killProc();
      }
    }, this.timeoutMs);
  }

  /** Cancel an in-flight flow. Idempotent. */
  cancel(): void {
    if (!this.proc) return;
    console.log("[xai-auth] Cancelling device-auth flow");
    // Listeners go first, so the close handler does not report a failure for a
    // cancellation the caller already observed.
    const proc = this.proc;
    this.proc = null;
    this.lastPendingEvent = null;
    this.clearTimeoutHandle();
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    killChild(proc, "SIGTERM");
    this.clearActiveScope();
  }

  /**
   * Drop this scope's login so the next turn falls back to the metered key (or
   * to no auth at all). Idempotent.
   */
  signOut(opts?: AgentAuthScopeOptions): void {
    const authFile = grokAuthFileFor(opts?.credentialDir ?? null);
    try {
      if (existsSync(authFile)) {
        rmSync(authFile, { force: true });
        console.log("[xai-auth] Removed", authFile);
      }
    } catch (err) {
      console.warn("[xai-auth] Failed to remove auth file:", err);
    }
  }

  /** Shutdown-hook tear-down. */
  kill(): void {
    this.cancel();
  }

  // ---- Internals ----

  private handleOutput(raw: string): void {
    const cleaned = stripAnsi(raw);
    this.outputBuffer += cleaned;
    if (cleaned.trim()) console.log("[xai-auth output]", cleaned.trim());
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

    console.log("[xai-auth] Detected verification URL + user code");
    this.pendingEmitted = true;
    const ev: XaiAuthPendingEvent = { verificationUri, userCode, expiresInSec };
    this.lastPendingEvent = ev;
    this.emit("xai_auth_pending", ev);
    // The normalized event the orchestrator's SSE wiring rebroadcasts as
    // `agent_auth_pending` with `loginId: "xai-oauth"`.
    this.emit("pending", { kind: "device-code", verificationUri, userCode, expiresInSec });
  }

  private failOnce(reason: XaiAuthFailureReason, message?: string): void {
    if (!this.proc) return;
    this.emit("xai_auth_failed", { reason, message });
    this.emit("failed", { reason, message });
  }

  private killProc(): void {
    const proc = this.proc;
    this.proc = null;
    this.lastPendingEvent = null;
    this.clearTimeoutHandle();
    this.clearActiveScope();
    if (!proc) return;
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    killChild(proc, "SIGTERM");
  }

  /**
   * Forget the in-flight flow's scope, after the terminal events have fired —
   * the SSE wiring reads {@link getActiveAccountId} synchronously inside those
   * handlers, so clearing earlier strands the broadcast with a null account.
   */
  private clearActiveScope(): void {
    this.activeCredentialDir = null;
    this.activeFlowAccountId = null;
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
