import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readlinkSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import type { AgentAuthManager } from "../../agent-auth-manager.js";
import type { AgentId } from "../../../shared/types.js";
import type { AgentAuthPendingDetails } from "../../../shared/types/ws-server-messages.js";

/**
 * Regex patterns to detect OAuth/verification URLs in Claude CLI output.
 * The CLI prints a URL the user must visit to authenticate.
 * Exported for testing.
 */
export const AUTH_URL_PATTERNS = [
  /https:\/\/console\.anthropic\.com\S+/,
  /https:\/\/claude\.ai\/oauth\S*/,
  /https?:\/\/\S*auth\S*verify\S*/i,
  /https?:\/\/\S*login\S*/i,
];

/**
 * Extract an OAuth/auth URL from arbitrary text output.
 * Returns the cleaned URL or `null` if no auth URL is found.
 * Exported for testing.
 */
export function extractAuthUrl(text: string): string | null {
  const clean = stripAnsi(text);
  for (const pattern of AUTH_URL_PATTERNS) {
    const match = clean.match(pattern);
    if (match) {
      return match[0].replace(/[)\]}>'"]+$/, ""); // strip trailing punctuation
    }
  }
  return null;
}

/**
 * Extract a full URL from buffered output, joining lines that were
 * wrapped by the terminal. Finds the last `https://` and extracts the
 * contiguous URL block (up to the next empty line), then strips all
 * whitespace/control characters to rejoin wrapped lines.
 * Exported for testing.
 */
export function extractUrlFromBuffer(buffer: string): string | null {
  const clean = stripAnsi(buffer);
  const start = clean.lastIndexOf("https://");
  if (start === -1) return null;

  const afterStart = clean.substring(start);

  // Find the URL block boundary: an empty line (\n followed by optional \r then \n).
  // PTY wrapping produces contiguous lines; an empty line signals end of the URL.
  const emptyLine = afterStart.search(/\n\r?\n/);
  const block = emptyLine !== -1 ? afterStart.substring(0, emptyLine) : afterStart;

  // Remove all newlines/carriage returns to join wrapped lines
  const joined = block.replace(/[\r\n]+/g, "");

  // Extract URL-safe characters, stopping at the first non-URL char (e.g. space)
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

/**
 * Extract the OAuth access token from a parsed Claude credentials
 * file. The schema has varied across CLI versions — sometimes the
 * token is at the top level under `accessToken`/`access_token`,
 * sometimes nested inside a `claudeAiOauth` object. We probe both
 * shapes and return the first non-empty string we find.
 *
 * Exported for unit tests.
 */
export function extractAccessToken(obj: Record<string, unknown>): string | null {
  const direct =
    pickString(obj, "accessToken") ?? pickString(obj, "access_token");
  if (direct) return direct;
  const nested = obj.claudeAiOauth;
  if (nested && typeof nested === "object") {
    const candidate =
      pickString(nested as Record<string, unknown>, "accessToken") ??
      pickString(nested as Record<string, unknown>, "access_token");
    if (candidate) return candidate;
  }
  return null;
}

/**
 * Extract the OAuth token's expiry timestamp (epoch ms) from a
 * parsed credentials file. Tolerant of `expiresAt` (epoch ms) and
 * `expires_at` (epoch seconds — what some refresh-token responses
 * return). Returns null when nothing parses.
 *
 * Exported for unit tests.
 */
export function extractExpiresAt(obj: Record<string, unknown>): number | null {
  const candidates: unknown[] = [
    obj.expiresAt,
    obj.expires_at,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expiresAt,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expires_at,
  ];
  for (const raw of candidates) {
    if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
      // Heuristic: epoch seconds rather than ms if the value looks
      // too small to be a millisecond timestamp from the last decade.
      return raw < 10_000_000_000 ? raw * 1000 : raw;
    }
  }
  return null;
}

function pickString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Derive a human-readable subscription label ("Pro", "Max 20x",
 * "Max 5x") from a parsed Claude credentials file. The `/api/oauth/usage`
 * endpoint doesn't return a plan field, so we fall back to the
 * `claudeAiOauth.subscriptionType` + `rateLimitTier` pair the CLI
 * persists in `.credentials.json`. Verified shape (Phase 0 capture, doc
 * 135):
 *
 *   "claudeAiOauth": {
 *     ...
 *     "subscriptionType": "max",
 *     "rateLimitTier": "default_claude_max_20x"
 *   }
 *
 * Returns null when the file doesn't carry this metadata (older CLI
 * versions, env-only auth, etc.).
 *
 * Exported for unit tests.
 */
export function extractPlanLabel(obj: Record<string, unknown>): string | null {
  const oauth = obj.claudeAiOauth;
  if (!oauth || typeof oauth !== "object") return null;
  const o = oauth as Record<string, unknown>;
  const subscriptionType = pickString(o, "subscriptionType");
  const rateLimitTier = pickString(o, "rateLimitTier");

  // The "Max 20x" / "Max 5x" multiplier lives in the rate-limit tier
  // string ("default_claude_max_20x"). Parse it out so users see the
  // exact tier the CLI advertises in its `/usage` screen.
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
      // Unknown subscription string — surface it verbatim with a
      // capitalized initial so the user has *something* to see, rather
      // than null.
      default:
        return subscriptionType.charAt(0).toUpperCase() + subscriptionType.slice(1);
    }
  }

  return null;
}

/** Path where Claude CLI stores credentials. */
const CLAUDE_CONFIG_DIR = "/root/.claude";

/** Path where Claude CLI stores user preferences (onboarding state, theme, etc.). */
const CLAUDE_USER_CONFIG = "/root/.claude.json";

/**
 * Credential file names the CLI may write inside `CLAUDE_CONFIG_DIR`,
 * depending on version. We probe all of them on read and remove all of
 * them on sign-out.
 */
const CLAUDE_CREDENTIAL_FILES = [".credentials.json", "credentials.json", "auth.json"];

/** Trigger phrases that indicate the code-paste URL has been printed. */
const CODE_PASTE_TRIGGERS = ["Paste code here", "Pastecodehereifprompted"];

/**
 * Ensure the Claude CLI's onboarding wizard and workspace trust prompt
 * are pre-configured so `claude /login` goes straight to the login flow.
 *
 * - `hasCompletedOnboarding` skips the first-run setup wizard.
 * - `projects` entries with `hasTrustDialogAccepted` skip the "trust this folder?" prompt.
 *
 * See: https://github.com/anthropics/claude-code/issues/4714
 */
function ensureOnboardingComplete(): void {
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(CLAUDE_USER_CONFIG)) {
      const raw = readFileSync(CLAUDE_USER_CONFIG, "utf-8");
      config = JSON.parse(raw) as Record<string, unknown>;
    }

    let changed = false;

    if (!config.hasCompletedOnboarding) {
      config.hasCompletedOnboarding = true;
      changed = true;
    }

    // Pre-trust known directories so the CLI doesn't show the workspace trust prompt.
    // /app is the container WORKDIR (where the server runs), /workspace is the data volume.
    const projects = (config.projects ?? {}) as Record<string, Record<string, unknown>>;
    for (const dir of ["/app", "/workspace"]) {
      if (!projects[dir]?.hasTrustDialogAccepted) {
        projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
        changed = true;
      }
    }
    if (changed) config.projects = projects;

    // Ensure the CLI's config directory exists. In Docker, /root/.claude is a
    // symlink to /credentials/.claude — mkdirSync fails on a broken symlink, so
    // resolve the target and create that instead.
    let configDirToCreate = CLAUDE_CONFIG_DIR;
    try {
      configDirToCreate = readlinkSync(CLAUDE_CONFIG_DIR);
    } catch {
      // Not a symlink or doesn't exist — use the path directly
    }
    mkdirSync(configDirToCreate, { recursive: true });

    if (changed) {
      writeFileSync(CLAUDE_USER_CONFIG, JSON.stringify(config, null, 2));
      console.log("[auth] Updated", CLAUDE_USER_CONFIG, "— onboarding + trust");
    }
  } catch (err) {
    console.warn("[auth] Failed to pre-create Claude config:", err);
  }
}

export class AuthManager extends EventEmitter implements AgentAuthManager {
  readonly agentId: AgentId = "claude";

  private proc: IPty | null = null;
  private _authenticated = false;
  private credentialsPollInterval: ReturnType<typeof setInterval> | null = null;
  private outputBuffer = "";
  private authUrlEmitted = false;
  private wizardTimer: ReturnType<typeof setTimeout> | null = null;
  private wizardEnterCount = 0;
  /**
   * The pending-flow payload last emitted to the `pending` event, retained
   * until the flow ends so a fresh SSE client can re-render the sign-in card
   * on a mid-flow page reload. Mirrors `CodexAuthManager.lastPendingEvent`.
   */
  private lastPendingDetails: AgentAuthPendingDetails | null = null;

  get authenticated(): boolean {
    return this._authenticated;
  }

  /**
   * {@link AgentAuthManager} surface. Aliases the Claude-specific entry points
   * so orchestrator code can drive every backend through one shape — see
   * docs/155 Phase 2.
   *
   *   - `start()` → {@link startOAuthFlow}
   *   - `cancel()` → {@link kill} (Claude has no separate cancel; killing the
   *     PTY before completion is the abort path)
   *   - `isConfigured()` → {@link checkCredentials}
   */
  start(): void {
    this.startOAuthFlow();
  }

  cancel(): void {
    this.kill();
  }

  isConfigured(): boolean {
    return this.checkCredentials();
  }

  getPendingPayload(): AgentAuthPendingDetails | null {
    return this.lastPendingDetails;
  }

  /**
   * Emit both the legacy `auth_url` event (still consumed by older
   * listeners + unit tests) and the normalized {@link AgentAuthManager}
   * `pending` event with a typed `code-paste-url` payload. Caches the
   * payload for SSE replay on reconnect.
   */
  private emitAuthUrl(url: string): void {
    const details: AgentAuthPendingDetails = { kind: "code-paste-url", verificationUri: url };
    this.lastPendingDetails = details;
    this.emit("auth_url", url);
    this.emit("pending", details);
  }

  /**
   * Resolve the OAuth access token Claude Code uses to call
   * `api.anthropic.com`, for use by the subscription-limits provider
   * (see docs/135-subscription-limits-badge/plan.md). Returns the
   * token with its source so callers can decide policy:
   *
   *   - `source: "env"` — `ANTHROPIC_AUTH_TOKEN` was set. Used in
   *     ShipIt-in-ShipIt dogfooding and any setup where the outer
   *     orchestrator forwards an OAuth bearer to the inner.
   *   - `source: "file"` — read from one of the credential files the
   *     CLI persists (`.credentials.json` / `credentials.json` /
   *     `auth.json` in `/root/.claude`). The CLI refreshes that file
   *     in place on each turn, so as long as the agent has run
   *     within the OAuth token's TTL (~1 hour) the value is fresh.
   *
   *   Returns `{ token: null, reason: "api-key" }` when only
   *   `ANTHROPIC_API_KEY` is set (pay-as-you-go path — no
   *   subscription quota to surface), and
   *   `{ token: null, reason: "not-authenticated" }` when nothing
   *   resembling an OAuth bearer is present.
   *
   *   `expiresAt` is best-effort: the credentials file usually
   *   contains an `expiresAt` field but the schema has varied
   *   across CLI versions. The provider doesn't trust it
   *   strictly — a stale token is detected at fetch time via 401.
   */
  async getAccessToken(): Promise<
    | { token: string; source: "file" | "env"; expiresAt: number | null; plan: string | null }
    | { token: null; reason: "api-key" | "not-authenticated" }
  > {
    const envToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (envToken) {
      // Env-token path (dogfooding) doesn't carry plan metadata; the
      // outer orchestrator's token is the canonical source.
      return { token: envToken, source: "env", expiresAt: null, plan: null };
    }

    for (const fileName of CLAUDE_CREDENTIAL_FILES) {
      const fullPath = path.join(CLAUDE_CONFIG_DIR, fileName);
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
        // Malformed JSON or unexpected shape — try the next candidate
        // file; if none have a token, fall through to the "API key
        // or not authenticated" branch below.
        console.warn(`[auth] Failed to parse ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }

    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { token: null, reason: "api-key" };
    }
    return { token: null, reason: "not-authenticated" };
  }

  /**
   * Quick check: does the Claude config directory contain credentials,
   * or is one of the recognized auth env vars set?
   *
   * Recognized env vars:
   *   - `ANTHROPIC_API_KEY` — standard API key. Sent as `x-api-key`.
   *   - `ANTHROPIC_AUTH_TOKEN` — OAuth-style bearer token. Sent as
   *     `Authorization: Bearer ...`. Used in dogfooding (ShipIt-in-ShipIt
   *     local mode), where the outer orchestrator forwards its Claude
   *     OAuth access token to the inner orch via `x-shipit-secrets` —
   *     `platform:claude_oauth`. The inner container has no
   *     `/root/.claude/.credentials.json` on disk, so env is the only path.
   */
  checkCredentials(): boolean {
    try {
      // The CLI may store credentials in different files depending on version
      const hasCredentials = CLAUDE_CREDENTIAL_FILES.some((f) => existsSync(path.join(CLAUDE_CONFIG_DIR, f)));
      const hasApiKey = !!process.env.ANTHROPIC_API_KEY?.trim();
      const hasAuthToken = !!process.env.ANTHROPIC_AUTH_TOKEN?.trim();
      this._authenticated = hasCredentials || hasApiKey || hasAuthToken;
      return this._authenticated;
    } catch {
      return false;
    }
  }

  /**
   * Start the OAuth flow by spawning `claude /login` in a pseudo-terminal.
   *
   * Uses node-pty to allocate a real PTY, so the CLI sees a terminal and
   * shows its interactive login flow (setup wizard, OAuth URL, code prompt).
   * Writing to the PTY goes directly to the terminal master fd — the same
   * as a real user typing — so readline prompts work correctly.
   *
   * Emits "auth_url" when the URL is detected, "auth_complete" when
   * credentials appear on disk, or "auth_failed" on timeout.
   */
  startOAuthFlow(): void {
    if (this.proc) {
      console.log("[auth] startOAuthFlow() skipped — PTY process already running (pid %d)", this.proc.pid);
      return;
    }

    console.log("[auth] Starting OAuth flow (node-pty)...");
    this.outputBuffer = "";
    this.authUrlEmitted = false;
    this.wizardEnterCount = 0;
    this.lastPendingDetails = null;

    // Skip the first-run onboarding wizard by marking it complete
    ensureOnboardingComplete();

    // Use a wide terminal to minimize URL wrapping
    this.proc = pty.spawn("claude", ["/login"], {
      name: "xterm-256color",
      cols: 200,
      rows: 24,
      env: { ...process.env, HOME: "/root" } as Record<string, string>,
    });
    console.log("[auth] Spawned claude /login (pid %d)", this.proc.pid);

    // Watchdog: if no output after 15s, log diagnostic info
    const watchdog = setTimeout(() => {
      if (!this.authUrlEmitted && this.outputBuffer.length === 0 && this.proc) {
        console.warn("[auth] Watchdog: no output received after 15s. Process pid:", this.proc.pid);
        console.warn("[auth] Watchdog: sending Enter to probe");
        this.proc.write("\r");
      }
    }, 15000);
    this.proc.onExit(() => clearTimeout(watchdog));

    this.proc.onData((data: string) => {
      const cleaned = stripAnsi(data);
      this.outputBuffer += cleaned;
      if (cleaned.trim()) {
        console.log("[auth output]", cleaned.trim());
      } else if (data.length > 0) {
        console.log("[auth] Received %d bytes of terminal control data", data.length);
      }

      // Try to detect the auth URL in the accumulated output.
      // Primary: look for "Paste code here" trigger and extract URL before it.
      // Fallback: try extracting any auth URL from the full buffer (the trigger
      // text may not be visible after ANSI stripping in some CLI versions).
      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        if (triggerPos !== -1) {
          const url = extractUrlFromBuffer(this.outputBuffer.substring(0, triggerPos));
          if (url) {
            console.log("[auth] Detected code-paste auth URL:", url);
            this.authUrlEmitted = true;
            this.emitAuthUrl(url);
          }
        } else {
          // Fallback: check for auth URL patterns directly in the buffer
          const url = extractAuthUrl(this.outputBuffer);
          if (url) {
            console.log("[auth] Detected auth URL (fallback):", url);
            this.authUrlEmitted = true;
            this.emitAuthUrl(url);
          }
        }
      }

      // Send Enter to navigate past interactive prompts (trust, login method).
      // Debounce: wait for output to settle before pressing Enter.
      this.scheduleWizardEnter();
    });

    this.proc.onExit(({ exitCode }) => {
      console.log("[auth] OAuth process exited with code", exitCode);
      this.proc = null;

      // Last chance: try to extract URL from buffer if not yet emitted
      if (!this.authUrlEmitted) {
        const triggerPos = this.findTriggerPos();
        const buf = triggerPos !== -1 ? this.outputBuffer.substring(0, triggerPos) : this.outputBuffer;
        const url = extractUrlFromBuffer(buf);
        if (url) {
          this.authUrlEmitted = true;
          this.emitAuthUrl(url);
        }
      }

      // Check if credentials were written
      if (this.checkCredentials()) {
        console.log("[auth] Authentication successful");
        this._authenticated = true;
        this.lastPendingDetails = null;
        this.emit("auth_complete");
        // Normalized AgentAuthManager event — listeners that key off the
        // agent-id map (limits-registry rearm, SSE rebroadcast as
        // `agent_auth_complete`, etc.) subscribe here so they don't have to
        // know which backend's CLI just finished.
        this.emit("complete");
      } else {
        console.log("[auth] Authentication may have failed (no credentials found)");
        this.lastPendingDetails = null;
        this.emit("auth_failed");
        // `error` is the catch-all reason for "we tried, it didn't work" —
        // distinguishes this from `timeout`/`denied`/`revoked` so the UI can
        // tailor the next-step copy. Mirrors `CodexAuthFailedEvent`.
        this.emit("failed", { reason: "error" });
      }
    });
  }

  /**
   * Schedule (or reschedule) the next wizard Enter keypress.
   * Each incoming data chunk resets the debounce. After sending Enter,
   * self-schedules the next one so we don't stall if the CLI produces
   * no further output (common with cursor-based Ink menus).
   */
  private scheduleWizardEnter(): void {
    if (this.authUrlEmitted || this.wizardEnterCount >= 10 || this.findTriggerPos() !== -1) {
      if (this.wizardEnterCount >= 10 && !this.authUrlEmitted) {
        console.log("[auth] Exhausted Enter attempts. Buffer (%d chars):", this.outputBuffer.length);
        const redacted = this.outputBuffer.substring(0, 500).replace(/https?:\/\/\S+/g, "[URL REDACTED]");
        console.log("[auth] Buffer contents (URLs redacted):", redacted);
      }
      return;
    }
    if (this.wizardTimer) clearTimeout(this.wizardTimer);
    // First Enter waits 2s for output to settle. Subsequent self-scheduled
    // Enters use 3s to give the CLI time to render the next screen.
    const delay = this.wizardEnterCount === 0 ? 2000 : 3000;
    this.wizardTimer = setTimeout(() => {
      if (!this.authUrlEmitted && this.proc && this.findTriggerPos() === -1 && this.wizardEnterCount < 10) {
        this.wizardEnterCount++;
        console.log(`[auth] Wizard: sending Enter (${this.wizardEnterCount}/10)`);
        this.proc.write("\r");
        // Self-schedule: if the CLI doesn't produce output after this
        // Enter, we'll still send the next one after a longer delay.
        this.scheduleWizardEnter();
      }
    }, delay);
  }

  /** Find the position of the first trigger phrase in the output buffer. */
  private findTriggerPos(): number {
    for (const trigger of CODE_PASTE_TRIGGERS) {
      const pos = this.outputBuffer.indexOf(trigger);
      if (pos !== -1) return pos;
    }
    return -1;
  }

  /** Write an authorization code to the PTY (for the "Paste code here" prompt). */
  sendCode(code: string): void {
    if (this.proc) {
      const trimmed = code.trim();
      console.log("[auth] Sending auth code to PTY (%d chars)", trimmed.length);
      // Write code characters first, then Enter (\r) after a short delay.
      // Sending them separately ensures the CLI's Ink input handler processes
      // the code text before receiving the Enter keypress.
      this.proc.write(trimmed);
      setTimeout(() => {
        if (this.proc) {
          console.log("[auth] Sending Enter to confirm code");
          this.proc.write("\r");
        }
      }, 200);
      // The CLI may stay running in interactive mode after authentication
      // succeeds (it enters the REPL rather than exiting). Poll for
      // credentials on disk so we can detect success without waiting for exit.
      this.startCredentialsPoll();
    } else {
      console.warn("[auth] Cannot send code — no PTY process");
    }
  }

  /** Poll for credentials appearing on disk after code submission. */
  private startCredentialsPoll(): void {
    this.clearCredentialsPoll();
    console.log("[auth] Starting credentials poll (checking", CLAUDE_CONFIG_DIR, "every 500ms)");
    let attempts = 0;
    this.credentialsPollInterval = setInterval(() => {
      attempts++;
      if (this.checkCredentials()) {
        console.log("[auth] Credentials detected on disk after code submission");
        this._authenticated = true;
        this.lastPendingDetails = null;
        this.clearCredentialsPoll();
        this.kill();
        this.emit("auth_complete");
        this.emit("complete");
      } else if (attempts >= 60) {
        // Give up after 30 seconds (60 × 500ms)
        console.log("[auth] Credentials poll timed out — no credentials found in", CLAUDE_CONFIG_DIR);
        this.lastPendingDetails = null;
        this.clearCredentialsPoll();
        this.emit("auth_failed");
        this.emit("failed", { reason: "timeout", message: "Credentials poll timed out after 30s" });
      }
    }, 500);
  }

  /** Stop polling for credentials. */
  private clearCredentialsPoll(): void {
    if (this.credentialsPollInterval) {
      clearInterval(this.credentialsPollInterval);
      this.credentialsPollInterval = null;
    }
  }

  /**
   * Sign out of the Claude subscription: kill any in-flight login PTY and
   * remove the OAuth credential files the CLI persisted in
   * `CLAUDE_CONFIG_DIR`. Idempotent — safe to call when nothing is signed in.
   *
   * Does NOT touch `ANTHROPIC_API_KEY` (the route clears that separately) or
   * `ANTHROPIC_AUTH_TOKEN` (forwarded by the outer orchestrator in dogfooding;
   * we don't own it). After this returns, `checkCredentials()` re-derives the
   * authenticated flag from what's left on disk and in the environment.
   */
  signOut(): void {
    this.kill();
    for (const fileName of CLAUDE_CREDENTIAL_FILES) {
      const fullPath = path.join(CLAUDE_CONFIG_DIR, fileName);
      try {
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true });
          console.log("[auth] Removed", fullPath);
        }
      } catch (err) {
        console.warn(`[auth] Failed to remove ${fullPath}:`, err instanceof Error ? err.message : err);
      }
    }
    this.checkCredentials();
  }

  /** Kill the auth process if running. */
  kill(): void {
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
