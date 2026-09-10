import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import {
  sanitizeClaudeAuthDiagnostic,
  type AgentAuthLogPayload,
  type AgentAuthProgressPayload,
  type ClaudeAuthLogLevel,
  type ClaudeAuthLogSource,
  type ClaudeAuthPhase,
} from "./auth-diagnostics.js";
import {
  firstEpochMs,
  pickString,
  probeNestedString,
  resolveSymlinkTarget,
} from "../agent-auth-base.js";
import { ensureClaudeUserConfigDefaults } from "./user-config.js";
import type {
  AgentAuthManager,
  AgentAuthManagerEvents,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
import type { LoginIntegrationId } from "../../../shared/catalogue/types.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

export const AUTH_URL_PATTERNS = [
  /https:\/\/console\.anthropic\.com\S+/,
  /https:\/\/claude\.ai\/oauth\S*/,
  /https?:\/\/\S*auth\S*verify\S*/i,
  /https?:\/\/\S*login\S*/i,
];

export function extractAuthUrl(text: string): string | null {
  const clean = stripAnsi(text);
  for (const pattern of AUTH_URL_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      return match[0].replace(/[)\]}>'"]+$/, "");
    }
  }
  return null;
}

export function extractUrlFromBuffer(buffer: string): string | null {
  const clean = stripAnsi(buffer);
  const start = clean.lastIndexOf("https://");
  if (start === -1) return null;

  const afterStart = clean.substring(start);

  // PTY wraps URLs across lines; an empty line ends the URL block.
  const emptyLine = afterStart.search(/\n\r?\n/);
  const block = emptyLine !== -1 ? afterStart.substring(0, emptyLine) : afterStart;

  const joined = block.replace(/[\r\n]+/g, "");

  let url = "";
  for (const ch of joined) {
    if (/[a-zA-Z0-9%=&?+\-_./:~!*'()]/.test(ch)) {
      url += ch;
    } else {
      break;
    }
  }
  return url.length > 20 ? url : null;
}

export function extractAccessToken(obj: Record<string, unknown>): string | null {
  return probeNestedString(obj, ["accessToken", "access_token"], "claudeAiOauth");
}

export function extractExpiresAt(obj: Record<string, unknown>): number | null {
  return firstEpochMs([
    obj.expiresAt,
    obj.expires_at,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expiresAt,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expires_at,
  ]);
}

export function extractPlanLabel(obj: Record<string, unknown>): string | null {
  const oauth = obj.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  const subscriptionType = pickString(o, "subscriptionType");
  const rateLimitTier = pickString(o, "rateLimitTier");

  if (rateLimitTier) {
    const maxMatch = /claude_max_(\d+x)/i.exec(rateLimitTier);
    if (maxMatch) return `Max ${maxMatch[1]}`;
    const proMatch = /claude_pro/i.exec(rateLimitTier);
    if (proMatch) return "Pro";
  }

  if (subscriptionType) {
    switch (subscriptionType.toLowerCase()) {
      case "max": return "Max";
      case "pro": return "Pro";
      case "free": return "Free";
      default:
        return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
    }
  }

  return null;
}

const CLAUDE_DEFAULT_HOME = "/root";

const CLAUDE_CONFIG_DIR = "/root/.claude";

const CLAUDE_USER_CONFIG = "/root/.claude.json";

const CLAUDE_CREDENTIAL_FILES = [".credentials.json", "credentials.json", "auth.json"];

// Flattened Ink output can omit spaces at any boundary.
const CODE_PASTE_TRIGGER = /paste\s*code\s*here(?:\s*if\s*prompted)?/i;

function ensureOnboardingComplete(userConfig: string, configDir: string): void {
  try {
    mkdirSync(resolveSymlinkTarget(configDir), { recursive: true });
  } catch (err) {
    console.warn("[auth] Failed to pre-create Claude config dir:", err);
  }
  if (ensureClaudeUserConfigDefaults(userConfig)) {
    console.log("[auth] Updated", userConfig, "— onboarding + trust");
  }
}

export interface ClaudeAuthManagerEvents extends AgentAuthManagerEvents {
  auth_url: [url: string];
  auth_complete: [];
  auth_failed: [];
}

export class AuthManager extends EventEmitter<ClaudeAuthManagerEvents> implements AgentAuthManager {
  readonly loginId: LoginIntegrationId = "anthropic-oauth";

  private proc: IPty | null = null;
  private _authenticated = false;
  private credentialsPollInterval: ReturnType<typeof setInterval> | null = null;
  private outputBuffer = "";
  private authUrlEmitted = false;
  private wizardTimer: ReturnType<typeof setTimeout> | null = null;
  private wizardEnterCount = 0;
  private lastPendingDetails: AgentAuthPendingDetails | null = null;
  private activeCredentialDir: string | null = null;
  private activeFlowAccountId: string | null = null;
  private activeAttemptId: string | null = null;
  private activeAttemptStartedAt = 0;
  // Existing files must not count as a successful new login.
  private credentialBaselineMtime = 0;
  private terminalEmitted = false;
  private flowGeneration = 0;

  private claimTerminalOutcome(): boolean {
    if (this.terminalEmitted) return false;
    this.terminalEmitted = true;
    return true;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  getActiveAccountId(): string | null {
    return this.activeFlowAccountId;
  }

  private homeFor(dir: string | null): string {
    return dir ?? CLAUDE_DEFAULT_HOME;
  }

  private claudeConfigDir(dir: string | null): string {
    return dir ? path.join(dir, ".claude") : CLAUDE_CONFIG_DIR;
  }

  private claudeUserConfig(dir: string | null): string {
    return dir ? path.join(dir, ".claude.json") : CLAUDE_USER_CONFIG;
  }

  start(opts?: AgentAuthStartOptions): void {
    this.startOAuthFlow(opts);
  }

  cancel(): void {
    this.kill();
    this.clearActiveScope();
  }

  submitCode(code: string): void {
    this.sendCode(code);
  }

  isConfigured(opts?: AgentAuthScopeOptions): boolean {
    return this.checkCredentials(opts?.credentialDir);
  }

  getPendingPayload(): AgentAuthPendingDetails | null {
    return this.lastPendingDetails;
  }

  private emitAuthUrl(url: string): void {
    const details: AgentAuthPendingDetails = { kind: "code-paste-url", verificationUri: url };
    this.lastPendingDetails = details;
    this.emit("auth_url", url);
    this.emit("pending", details);
  }

  private authEventBase(): { loginId: "anthropic-oauth"; accountId?: string; attemptId: string } {
    return {
      loginId: "anthropic-oauth",
      ...(this.activeFlowAccountId ? { accountId: this.activeFlowAccountId } : {}),
      attemptId: this.activeAttemptId ?? "unknown",
    };
  }

  private elapsedMs(): number | undefined {
    return this.activeAttemptStartedAt ? Date.now() - this.activeAttemptStartedAt : undefined;
  }

  private emitProgress(phase: ClaudeAuthPhase, message: string): void {
    const payload: AgentAuthProgressPayload = {
      ...this.authEventBase(),
      phase,
      message: sanitizeClaudeAuthDiagnostic(message),
      ...(this.elapsedMs() !== undefined ? { elapsedMs: this.elapsedMs() } : {}),
    };
    this.emit("progress", payload);
  }

  private emitDiagnosticLog(
    level: ClaudeAuthLogLevel,
    source: ClaudeAuthLogSource,
    message: string,
  ): void {
    const sanitized = sanitizeClaudeAuthDiagnostic(message);
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

  async getAccessToken(credentialDir?: string): Promise<
    | { token: string; source: "file" | "env"; expiresAt: number | null; plan: string | null }
    | { token: null; reason: "api-key" | "not-authenticated" }
  > {
    // Environment tokens belong to reserved routes, never account-scoped reads.
    if (!credentialDir) {
      const envToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
      if (envToken) {
        return { token: envToken, source: "env", expiresAt: null, plan: null };
      }
    }

    const configDir = this.claudeConfigDir(credentialDir ?? null);
    for (const fileName of CLAUDE_CREDENTIAL_FILES) {
      const fullPath = path.join(configDir, fileName);
      if (!existsSync(fullPath)) continue;
      try {
        const raw = readFileSync(fullPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const token = extractAccessToken(parsed);
        if (token) {
          return {
            token,
            source: "file",
            expiresAt: extractExpiresAt(parsed),
            plan: extractPlanLabel(parsed),
          };
        }
      } catch (err) {
        console.warn(`[auth] Failed to parse ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { token: null, reason: "api-key" };
    }
    return { token: null, reason: "not-authenticated" };
  }

  checkCredentials(credentialDir?: string): boolean {
    try {
      const scoped = credentialDir ?? this.activeCredentialDir;
      const configDir = this.claudeConfigDir(scoped);
      const hasCredentials = CLAUDE_CREDENTIAL_FILES.some((f) => existsSync(path.join(configDir, f)));
      if (scoped) {
        return hasCredentials;
      }
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY?.trim();
      const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN?.trim();
      this._authenticated = hasCredentials || hasApiKey || hasAuthToken;
      return this._authenticated;
    } catch {
      return false;
    }
  }

  private credentialMtimeMs(): number {
    const configDir = this.claudeConfigDir(this.activeCredentialDir);
    let newest = 0;
    for (const fileName of CLAUDE_CREDENTIAL_FILES) {
      try {
        const { mtimeMs } = statSync(path.join(configDir, fileName));
        if (mtimeMs > newest) newest = mtimeMs;
      } catch {
        // Missing file — skip.
      }
    }
    return newest;
  }

  private hasFreshCredentials(): boolean {
    return this.credentialMtimeMs() > this.credentialBaselineMtime;
  }

  startOAuthFlow(opts?: AgentAuthStartOptions): void {
    if (this.proc) {
      console.log("[auth] startOAuthFlow() — tearing down stale PTY (pid %d) before restart", this.proc.pid);
      this.emitDiagnosticLog("warn", "shipit", "Tearing down a stale Claude login process before starting a new attempt.");
      this.kill();
    }

    console.log("[auth] Starting OAuth flow (node-pty)...");
    // The old PTY exits asynchronously; its callback must not finish this flow.
    const generation = ++this.flowGeneration;
    this.terminalEmitted = false;
    this.outputBuffer = "";
    this.authUrlEmitted = false;
    this.wizardEnterCount = 0;
    this.lastPendingDetails = null;
    this.activeAttemptId = randomUUID();
    this.activeAttemptStartedAt = Date.now();
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    this.emitProgress("starting", "Starting Claude sign-in.");
    this.emitDiagnosticLog("info", "shipit", "Start requested for Claude sign-in.");
    // Existing credentials can make the CLI skip the interactive login flow.
    this.removeCredentialFiles(this.claudeConfigDir(this.activeCredentialDir));
    this.credentialBaselineMtime = this.credentialMtimeMs();
    const home = this.homeFor(this.activeCredentialDir);

    ensureOnboardingComplete(
      this.claudeUserConfig(this.activeCredentialDir),
      this.claudeConfigDir(this.activeCredentialDir),
    );
    this.emitProgress("skipping_setup", "Prepared Claude CLI onboarding and workspace trust state.");
    this.emitDiagnosticLog("info", "shipit", "Prepared Claude CLI config before spawning login.");

    // Environment credentials also bypass interactive login; remove them from this child.
    const loginEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete loginEnv.ANTHROPIC_API_KEY;
    delete loginEnv.ANTHROPIC_AUTH_TOKEN;
    delete loginEnv.CLAUDE_CODE_OAUTH_TOKEN;
    this.emitProgress("waiting_for_cli", "Launching Claude CLI login.");

    this.proc = pty.spawn("claude", ["/login"], {
      name: "xterm-256color",
      cols: 200,
      rows: 24,
      env: loginEnv,
    });
    console.log("[auth] Spawned claude /login (pid %d)", this.proc.pid);
    this.emitDiagnosticLog("info", "shipit", `Spawned claude /login process with pid ${this.proc.pid}.`);
    this.emitProgress("waiting_for_url", "Waiting for Claude CLI to print an authentication link.");

    const watchdog = setTimeout(() => {
      if (!this.authUrlEmitted && this.outputBuffer.length === 0 && this.proc) {
        console.warn("[auth] Watchdog: no output received after 15s. Process pid:", this.proc.pid);
        console.warn("[auth] Watchdog: sending Enter to probe");
        this.emitDiagnosticLog("warn", "shipit", "No Claude CLI output after 15s; sending Enter to probe the prompt.");
        this.emitProgress("waiting_for_cli", "Still waiting for Claude CLI output.");
        this.proc.write("\r");
      }
    }, 15000);
    this.proc.onExit(() => clearTimeout(watchdog));

    this.proc.onData((data: string) => {
      const cleaned = stripAnsi(data);
      this.outputBuffer += cleaned;
      if (cleaned.trim()) {
        console.log("[auth output]", cleaned.trim());
        this.emitDiagnosticLog("info", "claude_stdout", cleaned.trim());
      } else if (data.length > 0) {
        console.log("[auth] Received %d bytes of terminal control data", data.length);
        this.emitDiagnosticLog("debug", "claude_control", `Received ${data.length} bytes of terminal control data.`);
      }

      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        if (triggerPos !== -1) {
          const url = extractUrlFromBuffer(this.outputBuffer.substring(0, triggerPos));
          if (url) {
            console.log("[auth] Detected code-paste auth URL:", url);
            this.authUrlEmitted = true;
            this.emitDiagnosticLog("info", "shipit", "Detected Claude authentication URL.");
            this.emitProgress("waiting_for_code", "Authentication link detected. Waiting for authorization code.");
            this.emitAuthUrl(url);
          }
        } else {
          const url = extractAuthUrl(this.outputBuffer);
          if (url) {
            console.log("[auth] Detected auth URL (fallback):", url);
            this.authUrlEmitted = true;
            this.emitDiagnosticLog("info", "shipit", "Detected Claude authentication URL with fallback parser.");
            this.emitProgress("waiting_for_code", "Authentication link detected. Waiting for authorization code.");
            this.emitAuthUrl(url);
          }
        }
      }

      this.scheduleWizardEnter();
    });

    this.proc.onExit(({ exitCode }) => {
      console.log("[auth] OAuth process exited with code", exitCode);
      if (generation !== this.flowGeneration) {
        console.log("[auth] Ignoring exit of a superseded login process");
        return;
      }
      this.emitDiagnosticLog(exitCode === 0 ? "info" : "warn", "shipit", `Claude login process exited with code ${exitCode}.`);
      this.proc = null;

      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        const buf = triggerPos !== -1 ? this.outputBuffer.substring(0, triggerPos) : this.outputBuffer;
        const url = extractUrlFromBuffer(buf);
        if (url) {
          this.authUrlEmitted = true;
          this.emitDiagnosticLog("info", "shipit", "Detected Claude authentication URL after process exit.");
          this.emitProgress("waiting_for_code", "Authentication link detected. Waiting for authorization code.");
          this.emitAuthUrl(url);
        }
      }

      if (!this.claimTerminalOutcome()) {
        console.log("[auth] Login process exited after the flow already reported its outcome");
        return;
      }

      if (this.hasFreshCredentials()) {
        console.log("[auth] Authentication successful");
        this.emitProgress("complete", "Claude sign-in completed.");
        this.emitDiagnosticLog("info", "shipit", "Fresh Claude credentials were written.");
        if (!this.activeCredentialDir) this._authenticated = true;
        this.lastPendingDetails = null;
        this.emit("auth_complete");
        this.emit("complete");
      } else {
        console.log("[auth] Authentication may have failed (no credentials found)");
        this.emitProgress("failed", "Claude sign-in ended before fresh credentials were written.");
        this.emitDiagnosticLog("error", "shipit", "Claude login process exited without writing fresh credentials.");
        this.lastPendingDetails = null;
        this.emit("auth_failed");
        this.emit("failed", { reason: "error" });
      }
      this.clearActiveScope();
    });
  }

  // Clear after terminal events: their listeners read the account synchronously.
  private clearActiveScope(): void {
    this.activeCredentialDir = null;
    this.activeFlowAccountId = null;
    this.activeAttemptId = null;
    this.activeAttemptStartedAt = 0;
  }

  private scheduleWizardEnter(): void {
    if (this.authUrlEmitted || this.wizardEnterCount >= 10 || this.findTriggerPos() !== -1) {
      if (this.wizardEnterCount >= 10 && !this.authUrlEmitted) {
        console.log("[auth] Exhausted Enter attempts. Buffer (%d chars):", this.outputBuffer.length);
        const redacted = this.outputBuffer.substring(0, 500).replace(/https?:\/\/\S+/g, "[URL REDACTED]");
        console.log("[auth] Buffer contents (URLs redacted):", redacted);
        this.emitDiagnosticLog("warn", "shipit", `Exhausted wizard Enter attempts. Buffered output length: ${this.outputBuffer.length} characters.`);
      }
      return;
    }
    if (this.wizardTimer) clearTimeout(this.wizardTimer);
    const delay = this.wizardEnterCount === 0 ? 2000 : 3000;
    this.wizardTimer = setTimeout(() => {
      if (!this.authUrlEmitted && this.proc && this.findTriggerPos() === -1 && this.wizardEnterCount < 10) {
        this.wizardEnterCount++;
        console.log(`[auth] Wizard: sending Enter (${this.wizardEnterCount}/10)`);
        this.emitDiagnosticLog("debug", "shipit", `Sent Enter to Claude CLI wizard (${this.wizardEnterCount}/10).`);
        this.proc.write("\r");
        this.scheduleWizardEnter();
      }
    }, delay);
  }

  private findTriggerPos(): number {
    return this.outputBuffer.search(CODE_PASTE_TRIGGER);
  }

  sendCode(code: string): void {
    if (this.proc) {
      const trimmed = code.trim();
      console.log("[auth] Sending auth code to PTY (%d chars)", trimmed.length);
      this.emitProgress("checking_credentials", "Authorization code submitted. Checking for credentials.");
      this.emitDiagnosticLog("info", "shipit", `Authorization code submitted (${trimmed.length} characters redacted).`);
      // Let Ink process the text before sending Enter.
      this.proc.write(trimmed);
      setTimeout(() => {
        if (this.proc) {
          console.log("[auth] Sending Enter to confirm code");
          this.emitDiagnosticLog("debug", "shipit", "Sent Enter to confirm the authorization code.");
          this.proc.write("\r");
        }
      }, 200);
      // The CLI can enter its REPL after login, so success cannot depend on exit.
      this.startCredentialsPoll();
    } else {
      console.warn("[auth] Cannot send code — no PTY process");
      this.emitDiagnosticLog("warn", "shipit", "Cannot submit authorization code because no Claude login process is active.");
    }
  }

  private startCredentialsPoll(): void {
    this.clearCredentialsPoll();
    const configDir = this.claudeConfigDir(this.activeCredentialDir);
    console.log("[auth] Starting credentials poll (checking", configDir, "for a fresh write every 500ms)");
    this.emitProgress("checking_credentials", "Checking whether Claude wrote fresh credentials.");
    this.emitDiagnosticLog("info", "shipit", "Started credential polling after code submission.");
    let attempts = 0;
    this.credentialsPollInterval = setInterval(() => {
      attempts++;
      if (this.hasFreshCredentials()) {
        console.log("[auth] Fresh credentials detected on disk after code submission");
        this.clearCredentialsPoll();
        if (!this.claimTerminalOutcome()) return;
        this.emitProgress("complete", "Claude sign-in completed.");
        this.emitDiagnosticLog("info", "shipit", "Fresh Claude credentials detected on disk.");
        if (!this.activeCredentialDir) this._authenticated = true;
        this.lastPendingDetails = null;
        this.kill();
        this.emit("auth_complete");
        this.emit("complete");
        this.clearActiveScope();
      } else if (attempts >= 60) {
        console.log("[auth] Credentials poll timed out — no fresh credentials written to", configDir);
        this.clearCredentialsPoll();
        if (!this.claimTerminalOutcome()) return;
        this.emitProgress("failed", "Timed out waiting for Claude credentials.");
        this.emitDiagnosticLog("error", "shipit", "Credentials poll timed out after 30 seconds.");
        this.lastPendingDetails = null;
        this.emit("auth_failed");
        this.emit("failed", { reason: "timeout", message: "Credentials poll timed out after 30s" });
        this.clearActiveScope();
      }
    }, 500);
  }

  private clearCredentialsPoll(): void {
    if (this.credentialsPollInterval) {
      clearInterval(this.credentialsPollInterval);
      this.credentialsPollInterval = null;
    }
  }

  signOut(opts?: AgentAuthScopeOptions): void {
    this.kill();
    this.removeCredentialFiles(this.claudeConfigDir(opts?.credentialDir ?? null));
    if (!opts?.credentialDir) this.checkCredentials();
  }

  private removeCredentialFiles(configDir: string): void {
    for (const fileName of CLAUDE_CREDENTIAL_FILES) {
      const fullPath = path.join(configDir, fileName);
      try {
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true });
          console.log("[auth] Removed", fullPath);
        }
      } catch (err) {
        console.warn(`[auth] Failed to remove ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // Claim before teardown so its asynchronous exit cannot emit another outcome.
  kill(): void {
    this.claimTerminalOutcome();
    if (this.wizardTimer) {
      clearTimeout(this.wizardTimer);
      this.wizardTimer = null;
    }
    this.clearCredentialsPoll();
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
  }
}
