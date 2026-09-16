import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import { killChild } from "../../../shared/kill-child.js";
import { scrubHarnessEnvCredentials } from "../../../shared/spawn-routing.js";
import { ensureConfigDir, firstEpochMs, probeNestedString } from "../agent-auth-base.js";
import {
  createCliLineRelay,
  type CliLineRelay,
  credentialParseFailure,
  sanitizeAuthDiagnostic,
  type AgentAuthLogLevel,
  type AgentAuthLogPayload,
  type AgentAuthLogSource,
  type AgentAuthProgressPayload,
} from "../auth-diagnostics.js";
import type {
  AgentAuthManager,
  AgentAuthManagerEvents,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
import type { LoginIntegrationId } from "../../../shared/catalogue/types.js";
import type {
  AgentAuthPendingDetails,
  AgentAuthPhase,
} from "../../../shared/types/ws-server-messages.js";

export type XaiAuthFailureReason = "timeout" | "denied" | "error";

export interface XaiAuthPendingEvent {
  verificationUri: string;
  userCode: string;
  expiresInSec: number;
}

const XAI_DEFAULT_HOME = "/root";

export function grokConfigDirFor(credentialDir: string | null): string {
  return path.join(credentialDir ?? XAI_DEFAULT_HOME, ".grok");
}

export function grokAuthFileFor(credentialDir: string | null): string {
  return path.join(grokConfigDirFor(credentialDir), "auth.json");
}

export const GROK_AUTH_FILE = grokAuthFileFor(null);

// ShipIt's wait limit; the CLI does not report the device code's lifetime.
export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export const VERIFICATION_URL_PATTERN = /https:\/\/accounts\.x\.ai\/oauth2\/device[^\s"']*/;

export const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/**
 * The same shape, every occurrence, for taking the code back OUT of the CLI
 * output the diagnostics panel shows. Matching the pattern rather than the one
 * code this flow detected is deliberate: detection needs the URL *and* the code,
 * so a CLI that prints them the other way round would relay the code's line
 * before there was anything to compare it against.
 */
const USER_CODE_EVERY_OCCURRENCE = new RegExp(USER_CODE_PATTERN.source, "g");

/** No whitespace, ever: a URL matches up to the first space, so a spaced marker
 * substituted inside a link truncates what the sanitizer then sees and publishes
 * every query parameter after it. */
const CODE_MARKER = "[code-redacted]";

function authFileExistsAt(authFile: string): boolean {
  try {
    if (!existsSync(authFile)) return false;
    const st = statSync(authFile);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

// The CLI nests records under dynamic keys such as https://auth.x.ai::<client-uuid>.
function tokenRecords(obj: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [obj];
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>);
    }
  }
  return out;
}

export function extractXaiAccessToken(obj: Record<string, unknown>): string | null {
  for (const record of tokenRecords(obj)) {
    const token = probeNestedString(record, ["key", "access_token", "accessToken"], "tokens");
    if (token) return token;
  }
  return null;
}

function isoToEpochMs(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

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

function jwtExpiryMs(jwt: string | null): number | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    return typeof payload.exp === "number" && Number.isFinite(payload.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

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

export function readXaiTokenFreshnessFile(file: string): number | null {
  const parsed = readXaiAuthFile(file);
  return parsed ? readXaiTokenFreshness(parsed) : null;
}

export function readXaiAuthFile(authFile: string): Record<string, unknown> | null {
  try {
    if (!authFileExistsAt(authFile)) return null;
    const parsed = JSON.parse(readFileSync(authFile, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    console.warn("[xai-auth] Failed to parse auth.json:", credentialParseFailure(err));
    return null;
  }
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface XaiAuthManagerOptions {
  spawn?: SpawnFn;
  checkAuthFile?: () => boolean;
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
  private relay: CliLineRelay | null = null;
  private pendingEmitted = false;
  private lastPendingEvent: XaiAuthPendingEvent | null = null;
  private spawnFn: SpawnFn;
  private checkAuthFile: () => boolean;
  private timeoutMs: number;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;
  private activeAttemptId: string | null = null;
  private activeAttemptStartedAt = 0;

  constructor(opts: XaiAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? spawn;
    this.checkAuthFile = opts.checkAuthFile ?? (() => authFileExistsAt(GROK_AUTH_FILE));
    this.timeoutMs = opts.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
  }

  checkCredentials(credentialDir?: string): boolean {
    const scoped = credentialDir ?? this.activeCredentialDir;
    if (scoped) return authFileExistsAt(grokAuthFileFor(scoped));
    return this.checkAuthFile();
  }

  getActiveAccountId(): string | null {
    return this.activeFlowAccountId;
  }

  private authEventBase(): { loginId: LoginIntegrationId; accountId?: string; attemptId: string } {
    return {
      loginId: this.loginId,
      ...(this.activeFlowAccountId ? { accountId: this.activeFlowAccountId } : {}),
      attemptId: this.activeAttemptId ?? "unknown",
    };
  }

  private emitProgress(phase: AgentAuthPhase, message: string): void {
    const elapsedMs = this.activeAttemptStartedAt ? Date.now() - this.activeAttemptStartedAt : undefined;
    const payload: AgentAuthProgressPayload = {
      ...this.authEventBase(),
      phase,
      message: sanitizeAuthDiagnostic(message),
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    };
    this.emit("progress", payload);
  }

  /**
   * What the panel in Settings shows, and the only record a failed sign-in
   * leaves the user: the CLI's own words.
   *
   * **The three steps are a composition ORDER, not three passes.** Terminal
   * escapes come off first, so an escape sitting inside the code cannot hide its
   * shape; the known secret is removed next, while it is still intact; the
   * generic rules run last, over text that no longer contains it. Every other
   * order has a hole — redacting before the strip loses the `\b` the pattern
   * needs, and redacting after the generic rules asks an exact match to
   * recognise a string those rules may already have rewritten (measured on the
   * Antigravity manager, whose long submitted code came out as
   * `4/[redacted].private-tail`).
   */
  /**
   * Everything this manager prints about the CLI goes through here, not only
   * what the panel shows: a credential kept off the screen and written to the
   * orchestrator's log is still a credential in a log.
   */
  private redacted(text: string): string {
    return sanitizeAuthDiagnostic(
      stripAnsi(text).replace(USER_CODE_EVERY_OCCURRENCE, CODE_MARKER),
    );
  }

  private emitDiagnosticLog(
    level: AgentAuthLogLevel,
    source: AgentAuthLogSource,
    message: string,
  ): void {
    const sanitized = this.redacted(message);
    if (!sanitized) return;
    const payload: AgentAuthLogPayload = {
      ...this.authEventBase(),
      timestamp: new Date().toISOString(),
      level,
      source,
      message: sanitized,
    };
    this.emit("log", payload);
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

  get pending(): boolean {
    return this.proc !== null;
  }

  getPendingEvent(): XaiAuthPendingEvent | null {
    return this.lastPendingEvent;
  }

  // The credential's numeric tier has no known mapping to a plan name.
  readIdentity(credentialDir?: string): { externalId: string; email?: string } | null {
    const parsed = readXaiAuthFile(grokAuthFileFor(credentialDir ?? this.activeCredentialDir));
    return parsed ? extractXaiIdentity(parsed) : null;
  }

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
    this.activeAttemptId = randomUUID();
    this.activeAttemptStartedAt = Date.now();
    this.emitProgress("starting", "Starting the Grok CLI sign-in.");
    const home = this.activeCredentialDir ?? XAI_DEFAULT_HOME;
    const configDir = grokConfigDirFor(this.activeCredentialDir);

    ensureConfigDir(configDir, "[xai-auth]");

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      HOME: home,
      // GROK_HOME is the .grok directory; override inherited account paths.
      GROK_HOME: configDir,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      GROK_OAUTH2_REFERRER: "shipit",
    };
    // Inherited GROK_AUTH or GROK_AUTH_PATH can override the scoped credential store.
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
      this.emitDiagnosticLog("error", "shipit", `Could not spawn the Grok CLI: ${msg}`);
      this.emit("xai_auth_failed", { reason: "error", message: msg });
      this.emit("failed", { reason: "error", message: msg });
      this.clearActiveScope();
      return;
    }

    this.proc = proc;
    console.log("[xai-auth] Spawned grok login --device-auth (pid %d)", proc.pid);
    this.emitProgress("waiting_for_url", "Waiting for the Grok CLI to print a device code.");

    // Grok 1.0.1 prints the CHALLENGE on stderr, so stderr is an ordinary
    // channel here: levelling it `error` would paint a healthy sign-in red.
    const relay = createCliLineRelay((source, line) => {
      if (line.trim()) this.emitDiagnosticLog("info", source, line.trim());
    });
    this.relay = relay;

    /**
     * The liveness guard is taken ONCE here rather than inside each consumer. A
     * cancelled run keeps draining — `cancel()` detaches `close` and `error`,
     * never `data` — and by then `this.proc` may be the NEXT account's process,
     * so unguarded output lands on that account's panel and its expired
     * challenge is replayed as that account's code.
     */
    const consume = (source: AgentAuthLogSource, chunk: Buffer): void => {
      if (this.proc !== proc) return;
      const text = chunk.toString("utf-8");
      // Detection first, so the challenge still reaches the user as early as it did.
      this.handleOutput(text);
      relay.push(source, text);
    };
    // Grok 1.0.1 prints the challenge on stderr.
    proc.stdout?.on("data", (chunk: Buffer) => consume("cli_stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => consume("cli_stderr", chunk));

    proc.on("error", (err: Error) => {
      if (this.proc !== proc) return;
      console.warn("[xai-auth] Process error:", err.message);
      this.emitDiagnosticLog("error", "shipit", `The Grok CLI could not be run: ${err.message}`);
      this.failOnce("error", err.message);
    });

    proc.on("close", (code) => {
      console.log("[xai-auth] Process exited with code", code);
      // Guard first: the old handler nulled `this.proc`, `lastPendingEvent` and
      // the timeout before asking whether this process was still the live one,
      // so a late close tore down whatever flow had replaced it.
      if (this.proc !== proc) return;
      this.proc = null;
      relay.flush();
      this.lastPendingEvent = null;
      this.clearTimeoutHandle();

      const hasCredentials = this.checkCredentials();
      const ending = `sign-in ended exit=${String(code)} credentials=${hasCredentials ? "written" : "absent"}`;
      console.log(`[xai-auth] ${ending}`);
      this.emitDiagnosticLog("info", "shipit", ending);

      if (code === 0 && hasCredentials) {
        console.log("[xai-auth] Authentication successful");
        this.emit("xai_auth_complete");
        this.emit("complete");
        this.clearActiveScope();
        return;
      }

      if (this.outputBuffer.length > 0) {
        // Redact the WHOLE buffer, then truncate: truncating first can cut a
        // secret below a rule's threshold, or cut an exact code match in half.
        console.log(
          "[xai-auth] Buffer (truncated, %d chars total):",
          this.outputBuffer.length,
          this.redacted(this.outputBuffer).slice(0, 500),
        );
      }

      const message = code === 0
        ? "credentials file not written"
        : `grok login exited with code ${code ?? "null"}`;
      this.emit("xai_auth_failed", { reason: "error", message });
      this.emit("failed", { reason: "error", message });
      this.clearActiveScope();
    });

    this.timeoutHandle = setTimeout(() => {
      if (this.proc === proc) {
        console.warn("[xai-auth] Device-auth flow timed out");
        // `killProc` detaches `close`, so this is the only chance to drain the
        // tail — and a CLI that hung part-way through its last sentence is
        // exactly the failure whose explanation has no newline after it.
        relay.flush();
        this.emitDiagnosticLog("warn", "shipit", "The device code expired before the sign-in finished.");
        this.failOnce("timeout", "Device code expired");
        this.killProc();
      }
    }, this.timeoutMs);
  }

  cancel(): void {
    if (!this.proc) return;
    console.log("[xai-auth] Cancelling device-auth flow");
    // Before the scope is cleared, or the flushed line arrives with no account
    // and no attempt on it, and the client drops what it cannot place.
    this.relay?.flush();
    this.relay = null;
    // Remove listeners before kill so cancellation does not emit a failure.
    const proc = this.proc;
    this.proc = null;
    this.lastPendingEvent = null;
    this.clearTimeoutHandle();
    proc.removeAllListeners("close");
    proc.removeAllListeners("error");
    killChild(proc, "SIGTERM");
    this.clearActiveScope();
  }

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

  kill(): void {
    this.cancel();
  }

  private handleOutput(raw: string): void {
    const cleaned = stripAnsi(raw);
    this.outputBuffer += cleaned;
    // A chunk, not a line: this is the detection path, which cannot wait for
    // the relay — so it is redacted here rather than printed as it arrived.
    if (cleaned.trim()) console.log("[xai-auth output]", this.redacted(cleaned.trim()));
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
    // Neither the link nor the code: the sanitizer strips an OAuth URL down to
    // its origin anyway, and both reach the user unredacted on the challenge
    // card. This says only that they arrived.
    this.emitDiagnosticLog("info", "shipit", "Device code received; waiting for you to approve it in the browser.");
    this.emitProgress("waiting_for_code", "Waiting for the device code to be approved.");
    this.emit("xai_auth_pending", ev);
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

  // Clear after terminal events: their handlers read the account ID synchronously.
  private clearActiveScope(): void {
    this.activeCredentialDir = null;
    this.activeFlowAccountId = null;
    this.activeAttemptId = null;
    this.activeAttemptStartedAt = 0;
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
