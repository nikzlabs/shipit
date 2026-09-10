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
    console.warn("[xai-auth] Failed to parse auth.json:", err instanceof Error ? err.message : err);
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
  private pendingEmitted = false;
  private lastPendingEvent: XaiAuthPendingEvent | null = null;
  private spawnFn: SpawnFn;
  private checkAuthFile: () => boolean;
  private timeoutMs: number;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;

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
      this.emit("xai_auth_failed", { reason: "error", message: msg });
      this.emit("failed", { reason: "error", message: msg });
      this.clearActiveScope();
      return;
    }

    this.proc = proc;
    console.log("[xai-auth] Spawned grok login --device-auth (pid %d)", proc.pid);

    // Grok 1.0.1 prints the challenge on stderr.
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

      if (!wasRunning) return;

      if (code === 0 && this.checkCredentials()) {
        console.log("[xai-auth] Authentication successful");
        this.emit("xai_auth_complete");
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

  cancel(): void {
    if (!this.proc) return;
    console.log("[xai-auth] Cancelling device-auth flow");
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
  }

  private clearTimeoutHandle(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
