import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import { killChild } from "../../../shared/kill-child.js";
import {
  ensureConfigDir,
  firstEpochMs,
  pickString,
  probeNestedString,
} from "../agent-auth-base.js";
import {
  createCliLineRelay,
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

export type CodexAuthFailureReason = "timeout" | "denied" | "error";

export interface CodexAuthPendingEvent {
  verificationUri: string;
  userCode: string;
  expiresInSec: number;
}

export interface CodexAuthFailedEvent {
  reason: CodexAuthFailureReason;
  message?: string;
}

const CODEX_DEFAULT_HOME = "/root";

export const CODEX_CONFIG_DIR = "/root/.codex";

export const CODEX_AUTH_FILE = `${CODEX_CONFIG_DIR}/auth.json`;

function codexConfigDirFor(credentialDir: string | null): string {
  return credentialDir ? path.join(credentialDir, ".codex") : CODEX_CONFIG_DIR;
}

function codexAuthFileFor(credentialDir: string | null): string {
  return path.join(codexConfigDirFor(credentialDir), "auth.json");
}

export const DEVICE_AUTH_TIMEOUT_MS = 15 * 60 * 1000;

export const VERIFICATION_URL_PATTERN = /https:\/\/auth\.openai\.com\/codex\/device[^\s"']*/;

export const USER_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/;

/**
 * The same shape, every occurrence, for taking the code back OUT of the CLI
 * output the diagnostics panel shows. Matching the pattern rather than the one
 * code this flow detected is deliberate: detection needs the URL *and* the code,
 * so a CLI that prints them the other way round would relay the code's line
 * before there was anything to compare it against.
 */
const USER_CODE_EVERY_OCCURRENCE = new RegExp(USER_CODE_PATTERN.source, "g");

function authFileExistsAt(authFile: string): boolean {
  try {
    if (!existsSync(authFile)) return false;
    const st = statSync(authFile);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

export function extractCodexAccessToken(obj: Record<string, unknown>): string | null {
  return probeNestedString(obj, ["access_token", "accessToken"], "tokens");
}

export function extractCodexExpiresAt(obj: Record<string, unknown>): number | null {
  return firstEpochMs([
    obj.expires_at,
    obj.expiresAt,
    (obj.tokens as Record<string, unknown> | undefined)?.expires_at,
    (obj.tokens as Record<string, unknown> | undefined)?.expiresAt,
  ]);
}

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf-8");
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readAuthClaim(obj: Record<string, unknown>, key: string): unknown {
  const tokens =
    obj.tokens && typeof obj.tokens === "object"
      ? (obj.tokens as Record<string, unknown>)
      : obj;
  for (const tokKey of ["id_token", "access_token", "idToken", "accessToken"]) {
    const jwt = pickString(tokens, tokKey) ?? pickString(obj, tokKey);
    if (!jwt) continue;
    const payload = decodeJwtPayload(jwt);
    const auth = payload?.[OPENAI_AUTH_CLAIM];
    if (auth && typeof auth === "object") {
      const v = (auth as Record<string, unknown>)[key];
      if (v !== undefined && v !== null) return v;
    }
  }
  return null;
}

export function extractCodexPlan(obj: Record<string, unknown>): string | null {
  const raw = readAuthClaim(obj, "chatgpt_plan_type");
  if (typeof raw !== "string" || raw.length === 0) return null;
  const known: Record<string, string> = {
    free: "Free",
    plus: "Plus",
    pro: "Pro",
    business: "Business",
    team: "Team",
    enterprise: "Enterprise",
  };
  const lower = raw.toLowerCase();
  return known[lower] ?? raw.charAt(0).toUpperCase() + raw.slice(1);
}

// Email can change; use chatgpt_account_id for identity.
export function extractCodexIdentity(
  obj: Record<string, unknown>,
): { externalId: string; email?: string } | null {
  const raw = readAuthClaim(obj, "chatgpt_account_id");
  if (typeof raw !== "string" || raw.length === 0) return null;
  const email = readTokenClaim(obj, "email");
  return {
    externalId: raw,
    ...(typeof email === "string" && email.length > 0 ? { email } : {}),
  };
}

function readTokenClaim(obj: Record<string, unknown>, key: string): unknown {
  const tokens =
    obj.tokens && typeof obj.tokens === "object"
      ? (obj.tokens as Record<string, unknown>)
      : obj;
  for (const tokKey of ["id_token", "access_token", "idToken", "accessToken"]) {
    const jwt = pickString(tokens, tokKey) ?? pickString(obj, tokKey);
    if (!jwt) continue;
    const payload = decodeJwtPayload(jwt);
    const v = payload?.[key];
    if (v !== undefined && v !== null) return v;
  }
  return null;
}

function authFileExists(): boolean {
  return authFileExistsAt(CODEX_AUTH_FILE);
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: Parameters<typeof spawn>[2],
) => ChildProcess;

export interface CodexAuthManagerOptions {
  spawn?: SpawnFn;
  checkAuthFile?: () => boolean;
  timeoutMs?: number;
}

export interface CodexAuthManagerEvents extends AgentAuthManagerEvents {
  codex_auth_pending: [ev: CodexAuthPendingEvent];
  codex_auth_complete: [];
  codex_auth_failed: [payload: CodexAuthFailedEvent];
}

export class CodexAuthManager extends EventEmitter<CodexAuthManagerEvents> implements AgentAuthManager {
  readonly loginId: LoginIntegrationId = "openai-chatgpt";

  private proc: ChildProcess | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private outputBuffer = "";
  private pendingEmitted = false;
  private lastPendingEvent: CodexAuthPendingEvent | null = null;
  private spawnFn: SpawnFn;
  private checkAuthFile: () => boolean;
  private timeoutMs: number;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;
  private activeAttemptId: string | null = null;
  private activeAttemptStartedAt = 0;

  constructor(opts: CodexAuthManagerOptions = {}) {
    super();
    this.spawnFn = opts.spawn ?? (spawn);
    this.checkAuthFile = opts.checkAuthFile ?? authFileExists;
    this.timeoutMs = opts.timeoutMs ?? DEVICE_AUTH_TIMEOUT_MS;
  }

  checkCredentials(credentialDir?: string): boolean {
    const scoped = credentialDir ?? this.activeCredentialDir;
    if (scoped) return authFileExistsAt(codexAuthFileFor(scoped));
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
   * **The code is removed AFTER the sanitizer, not before.** `[code redacted]`
   * contains a space, and a URL matches up to the first whitespace — so
   * substituting it inside `?user_code=…&device_code=…` truncates the link the
   * sanitizer then sees, and every later query parameter survives in the clear.
   * Run second, it has nothing left to break: a code inside a URL left with the
   * stripped query string, and one printed on its own line is short enough that
   * no other rule touches it.
   */
  private emitDiagnosticLog(
    level: AgentAuthLogLevel,
    source: AgentAuthLogSource,
    message: string,
  ): void {
    const sanitized = sanitizeAuthDiagnostic(message)
      .replace(USER_CODE_EVERY_OCCURRENCE, "[code redacted]");
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
    return {
      kind: "device-code",
      verificationUri: this.lastPendingEvent.verificationUri,
      userCode: this.lastPendingEvent.userCode,
      expiresInSec: this.lastPendingEvent.expiresInSec,
    };
  }

  async getAccessToken(credentialDir?: string): Promise<
    | {
        token: string;
        source: "file";
        expiresAt: number | null;
        plan: string | null;
      }
    | { token: null; reason: "api-key" | "not-authenticated" }
  > {
    const authFile = credentialDir ? codexAuthFileFor(credentialDir) : CODEX_AUTH_FILE;
    const present = credentialDir ? authFileExistsAt(authFile) : this.checkAuthFile();
    if (present) {
      try {
        const raw = readFileSync(authFile, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const token = extractCodexAccessToken(parsed);
        if (token) {
          return {
            token,
            source: "file",
            expiresAt: extractCodexExpiresAt(parsed),
            plan: extractCodexPlan(parsed),
          };
        }
      } catch (err) {
        console.warn(
          "[codex-auth] Failed to parse auth.json:",
          err instanceof Error ? err.message : err,
        );
      }
    }

    if (process.env.OPENAI_API_KEY?.trim()) {
      return { token: null, reason: "api-key" };
    }
    return { token: null, reason: "not-authenticated" };
  }

  get pending(): boolean {
    return this.proc !== null;
  }

  getPendingEvent(): CodexAuthPendingEvent | null {
    return this.lastPendingEvent;
  }

  startDeviceFlow(opts?: AgentAuthStartOptions): void {
    if (this.proc) {
      console.log("[codex-auth] startDeviceFlow() skipped — process already running (pid %d)", this.proc.pid);
      // Restore the URL and code after a page reload without restarting the flow.
      if (this.lastPendingEvent) {
        this.emit("codex_auth_pending", this.lastPendingEvent);
        this.emit("pending", {
          kind: "device-code",
          verificationUri: this.lastPendingEvent.verificationUri,
          userCode: this.lastPendingEvent.userCode,
          expiresInSec: this.lastPendingEvent.expiresInSec,
        });
      }
      return;
    }

    console.log("[codex-auth] Starting device-auth flow...");
    this.outputBuffer = "";
    this.pendingEmitted = false;
    this.lastPendingEvent = null;
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    this.activeAttemptId = randomUUID();
    this.activeAttemptStartedAt = Date.now();
    this.emitProgress("starting", "Starting the Codex CLI sign-in.");
    const home = this.activeCredentialDir ?? CODEX_DEFAULT_HOME;

    ensureConfigDir(codexConfigDirFor(this.activeCredentialDir), "[codex-auth]");

    let proc: ChildProcess;
    try {
      proc = this.spawnFn(
        "codex",
        // A localhost login callback is unreachable from the user's browser.
        ["login", "--device-auth"],
        {
          env: { ...process.env, HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[codex-auth] Failed to spawn codex login:", msg);
      this.emitDiagnosticLog("error", "shipit", `Could not spawn the Codex CLI: ${msg}`);
      this.emit("codex_auth_failed", { reason: "error", message: msg } satisfies CodexAuthFailedEvent);
      this.emit("failed", { reason: "error", message: msg });
      this.clearActiveScope();
      return;
    }

    this.proc = proc;
    console.log("[codex-auth] Spawned codex login --device-auth (pid %d)", proc.pid);
    this.emitProgress("waiting_for_url", "Waiting for the Codex CLI to print a device code.");

    // Both streams carry ordinary progress, so the level says nothing about a
    // line and the source says which stream it came from.
    const relay = createCliLineRelay((source, line) => {
      if (line.trim()) this.emitDiagnosticLog("info", source, line.trim());
    });

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
    proc.stdout?.on("data", (chunk: Buffer) => consume("cli_stdout", chunk));
    proc.stderr?.on("data", (chunk: Buffer) => consume("cli_stderr", chunk));

    proc.on("error", (err: Error) => {
      if (this.proc !== proc) return;
      console.warn("[codex-auth] Process error:", err.message);
      this.emitDiagnosticLog("error", "shipit", `The Codex CLI could not be run: ${err.message}`);
      this.failOnce("error", err.message);
    });

    proc.on("close", (code) => {
      console.log("[codex-auth] Process exited with code", code);
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
      console.log(`[codex-auth] ${ending}`);
      this.emitDiagnosticLog("info", "shipit", ending);

      if (code === 0 && hasCredentials) {
        console.log("[codex-auth] Authentication successful");
        this.emit("codex_auth_complete");
        this.emit("complete");
        this.clearActiveScope();
        return;
      }

      if (this.outputBuffer.length > 0) {
        const redacted = this.outputBuffer.substring(0, 500);
        console.log("[codex-auth] Buffer (truncated, %d chars total):", this.outputBuffer.length, redacted);
      }

      const failMessage = code === 0 ? "credentials file not written" : `codex login exited with code ${code ?? "null"}`;
      this.emit("codex_auth_failed", {
        reason: "error",
        message: failMessage,
      } satisfies CodexAuthFailedEvent);
      this.emit("failed", { reason: "error", message: failMessage });
      this.clearActiveScope();
    });

    this.timeoutHandle = setTimeout(() => {
      if (this.proc === proc) {
        console.warn("[codex-auth] Device-auth flow timed out");
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
    console.log("[codex-auth] Cancelling device-auth flow");
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
    const authFile = opts?.credentialDir ? codexAuthFileFor(opts.credentialDir) : CODEX_AUTH_FILE;
    try {
      if (existsSync(authFile)) {
        rmSync(authFile, { force: true });
        console.log("[codex-auth] Removed", authFile);
      }
    } catch (err) {
      console.warn("[codex-auth] Failed to remove auth file:", err);
    }
  }

  kill(): void {
    this.cancel();
  }

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
    const ev: CodexAuthPendingEvent = { verificationUri, userCode, expiresInSec };
    this.lastPendingEvent = ev;
    // Neither the link nor the code: the sanitizer strips an OAuth URL down to
    // its origin anyway, and both reach the user unredacted on the challenge
    // card. This says only that they arrived.
    this.emitDiagnosticLog("info", "shipit", "Device code received; waiting for you to approve it in the browser.");
    this.emitProgress("waiting_for_code", "Waiting for the device code to be approved.");
    this.emit("codex_auth_pending", ev);
    this.emit("pending", {
      kind: "device-code",
      verificationUri,
      userCode,
      expiresInSec,
    });
  }

  private failOnce(reason: CodexAuthFailureReason, message?: string): void {
    if (!this.proc) return;
    this.emit("codex_auth_failed", { reason, message } satisfies CodexAuthFailedEvent);
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
