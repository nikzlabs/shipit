import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
import type {
  AgentAuthManager,
  AgentAuthStartOptions,
  AgentAuthScopeOptions,
} from "../../agent-auth-manager.js";
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
  return probeNestedString(obj, ["accessToken", "access_token"], "claudeAiOauth");
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
  return firstEpochMs([
    obj.expiresAt,
    obj.expires_at,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expiresAt,
    (obj.claudeAiOauth as Record<string, unknown> | undefined)?.expires_at,
  ]);
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

/** Legacy singleton HOME the CLI reads/writes when no account scope is set. */
const CLAUDE_DEFAULT_HOME = "/root";

/** Path where Claude CLI stores credentials (singleton path). */
const CLAUDE_CONFIG_DIR = "/root/.claude";

/** Path where Claude CLI stores user preferences (onboarding state, theme, etc.). */
const CLAUDE_USER_CONFIG = "/root/.claude.json";

/**
 * Credential file names the CLI may write inside `CLAUDE_CONFIG_DIR`,
 * depending on version. We probe all of them on read and remove all of
 * them on sign-out.
 */
const CLAUDE_CREDENTIAL_FILES = [".credentials.json", "credentials.json", "auth.json"];

/**
 * Prompt that indicates the code-paste URL has been printed. Ink can omit an
 * arbitrary subset of spaces when its terminal output is flattened, so match
 * each boundary independently instead of enumerating observed renderings.
 */
const CODE_PASTE_TRIGGER = /paste\s*code\s*here(?:\s*if\s*prompted)?/i;

/**
 * Ensure the Claude CLI's onboarding wizard and workspace trust prompt
 * are pre-configured so `claude /login` goes straight to the login flow.
 *
 * - `hasCompletedOnboarding` skips the first-run setup wizard.
 * - `projects` entries with `hasTrustDialogAccepted` skip the "trust this folder?" prompt.
 *
 * See: https://github.com/anthropics/claude-code/issues/4714
 *
 * `userConfig` / `configDir` are passed in so the same routine works for the
 * singleton path (`/root/.claude.json`, `/root/.claude`) and for an
 * account-scoped flow whose HOME is a provider-account root (docs/150).
 */
function ensureOnboardingComplete(userConfig: string, configDir: string): void {
  try {
    let config: Record<string, unknown> = {};
    if (existsSync(userConfig)) {
      const raw = readFileSync(userConfig, "utf-8");
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
    // resolve the target and create that instead (see resolveSymlinkTarget).
    mkdirSync(resolveSymlinkTarget(configDir), { recursive: true });

    if (changed) {
      writeFileSync(userConfig, JSON.stringify(config, null, 2));
      console.log("[auth] Updated", userConfig, "— onboarding + trust");
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
  /**
   * Credential root (provider-account directory) the in-flight flow is
   * scoped to, or `null` for the legacy singleton flow. Set at flow start,
   * cleared after the terminal `complete`/`failed` events fire (docs/150).
   * The CLI is spawned with `HOME` pointed here; the credentials poll + exit
   * checks resolve their config dir off it.
   */
  private activeCredentialDir: string | null = null;
  /** Provider-account id for the in-flight flow, or `null` when singleton. */
  private activeFlowAccountId: string | null = null;
  /** Per-start id used to correlate progress/log diagnostics for one login attempt. */
  private activeAttemptId: string | null = null;
  private activeAttemptStartedAt = 0;
  /**
   * Newest credential-file mtime (epoch ms) observed in the active flow's
   * config dir at the moment the flow *started*, or `0` when no credential
   * file was present. The completion checks (poll + exit) treat the flow as
   * successful only once a credential file is newer than this baseline —
   * i.e. the CLI actually wrote *fresh* credentials for the code just pasted.
   *
   * Without this, `checkCredentials()` (pure `existsSync`) reports success on
   * the very first poll tick whenever *any* credential file is already on disk
   * — which is always true when re-authenticating an account that has a stale
   * or expired file. That short-circuit fires within 500ms, `kill()`s the
   * `claude /login` PTY mid-exchange (SIGHUP, exit 129), and the pasted code is
   * never exchanged into a new token: the login is a silent no-op and the
   * account never legitimately reaches `ready`.
   */
  private credentialBaselineMtime = 0;

  get authenticated(): boolean {
    return this._authenticated;
  }

  getActiveAccountId(): string | null {
    return this.activeFlowAccountId;
  }

  /** HOME the CLI should run under for `dir` (account root) or the singleton. */
  private homeFor(dir: string | null): string {
    return dir ?? CLAUDE_DEFAULT_HOME;
  }

  /** `.claude` config dir for `dir` (account root) or the singleton path. */
  private claudeConfigDir(dir: string | null): string {
    return dir ? path.join(dir, ".claude") : CLAUDE_CONFIG_DIR;
  }

  /** `.claude.json` user-config path for `dir` or the singleton path. */
  private claudeUserConfig(dir: string | null): string {
    return dir ? path.join(dir, ".claude.json") : CLAUDE_USER_CONFIG;
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
  start(opts?: AgentAuthStartOptions): void {
    this.startOAuthFlow(opts);
  }

  cancel(): void {
    this.kill();
  }

  /** {@link AgentAuthManager.submitCode} — alias for {@link sendCode}. */
  submitCode(code: string): void {
    this.sendCode(code);
  }

  isConfigured(opts?: AgentAuthScopeOptions): boolean {
    return this.checkCredentials(opts?.credentialDir);
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

  private authEventBase(): { agentId: "claude"; accountId?: string; attemptId: string } {
    return {
      agentId: "claude",
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
  async getAccessToken(credentialDir?: string): Promise<
    | { token: string; source: "file" | "env"; expiresAt: number | null; plan: string | null }
    | { token: null; reason: "api-key" | "not-authenticated" }
  > {
    // Account-scoped reads (docs/150) source the token only from the
    // account's own credential files — env-var auth belongs to reserved
    // routes, not a stored account row.
    if (!credentialDir) {
      const envToken = process.env.ANTHROPIC_AUTH_TOKEN?.trim();
      if (envToken) {
        // Env-token path (dogfooding) doesn't carry plan metadata; the
        // outer orchestrator's token is the canonical source.
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
  checkCredentials(credentialDir?: string): boolean {
    try {
      // During a scoped flow, a no-arg call (from the exit/poll handlers)
      // resolves to the active account's dir; an explicit `credentialDir`
      // always wins. `null` means the legacy singleton path.
      const scoped = credentialDir ?? this.activeCredentialDir;
      const configDir = this.claudeConfigDir(scoped);
      // The CLI may store credentials in different files depending on version
      const hasCredentials = CLAUDE_CREDENTIAL_FILES.some((f) => existsSync(path.join(configDir, f)));
      if (scoped) {
        // Account-scoped check (docs/150): only on-disk OAuth credentials
        // count. Env-var auth (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`)
        // is a reserved route, not a stored account, and must not make a
        // half-finished or cancelled scoped login look complete. Also leaves
        // the singleton `_authenticated` flag untouched.
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

  /**
   * Newest mtime (epoch ms) across the candidate credential files in the
   * active flow's config dir, or `0` when none exist. Used to baseline the
   * flow at start and to detect a genuinely-new write afterwards.
   */
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

  /**
   * Did the CLI write *fresh* credentials since the active flow started?
   * True only when a credential file is now newer than the baseline captured
   * in {@link startOAuthFlow}. This is the flow-completion gate — distinct
   * from {@link checkCredentials}, which answers the broader "is auth
   * configured at all?" (and so honors a pre-existing file + env vars).
   */
  private hasFreshCredentials(): boolean {
    return this.credentialMtimeMs() > this.credentialBaselineMtime;
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
  startOAuthFlow(opts?: AgentAuthStartOptions): void {
    if (this.proc) {
      // A prior flow left a PTY alive (a hung/incomplete attempt, or a stale
      // `claude /login` that never exited). Don't silently no-op — that's the
      // deadlock that forced users to click "Clear saved credentials" first:
      // the only path that called kill() was signOut(), so a stale proc made
      // every "Sign in" retry a no-op while the UI sat on "Starting…". Tear it
      // down here so re-clicking "Sign in" always restarts from a clean slate,
      // mirroring signOut()'s teardown.
      console.log("[auth] startOAuthFlow() — tearing down stale PTY (pid %d) before restart", this.proc.pid);
      this.emitDiagnosticLog("warn", "shipit", "Tearing down a stale Claude login process before starting a new attempt.");
      this.kill();
    }

    console.log("[auth] Starting OAuth flow (node-pty)...");
    this.outputBuffer = "";
    this.authUrlEmitted = false;
    this.wizardEnterCount = 0;
    this.lastPendingDetails = null;
    this.activeAttemptId = randomUUID();
    this.activeAttemptStartedAt = Date.now();
    // Scope this flow to a provider account (docs/150) — or `null` for the
    // legacy singleton flow. The CLI runs with HOME pointed at the account
    // root, so it reads/writes `<root>/.claude` + `<root>/.claude.json`.
    this.activeCredentialDir = opts?.credentialDir ?? null;
    this.activeFlowAccountId = opts?.accountId ?? null;
    this.emitProgress("starting", "Starting Claude sign-in.");
    this.emitDiagnosticLog("info", "shipit", "Start requested for Claude sign-in.");
    // Remove any stale/expired credential files for this scope *before*
    // spawning the CLI. `claude /login` only presents the full OAuth code-paste
    // flow when it starts from a clean slate; with an expired
    // `.credentials.json` still on disk it short-circuits (treats the account
    // as already logged in / refreshes in place) and never writes a fresh
    // token, so the flow silently fails. This is exactly what the user had to
    // do by hand — click "Clear saved credentials" before re-authenticating —
    // now done automatically. The mtime baseline below (#1406) guards against a
    // *premature success*; this wipe is what makes a fresh login actually
    // start. After the wipe the baseline is 0, so any write the flow produces
    // counts as fresh.
    this.removeCredentialFiles(this.claudeConfigDir(this.activeCredentialDir));
    // Baseline the credential file's mtime *before* spawning the CLI, so the
    // completion checks below only fire on a genuinely-new write.
    this.credentialBaselineMtime = this.credentialMtimeMs();
    const home = this.homeFor(this.activeCredentialDir);

    // Skip the first-run onboarding wizard by marking it complete
    ensureOnboardingComplete(
      this.claudeUserConfig(this.activeCredentialDir),
      this.claudeConfigDir(this.activeCredentialDir),
    );
    this.emitProgress("skipping_setup", "Prepared Claude CLI onboarding and workspace trust state.");
    this.emitDiagnosticLog("info", "shipit", "Prepared Claude CLI config before spawning login.");

    // Strip env-var auth from the login subprocess. `claude /login` honors
    // `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` *over* the interactive OAuth
    // flow: with either present it treats the CLI as already authenticated and
    // never emits the code-paste URL, so the flow silently hangs on
    // "Starting…". The on-disk wipe above can't fix this because the blocker
    // lives in the environment, not on disk — which is exactly why the only
    // workaround that worked was "Clear saved credentials" (DELETE
    // /api/auth/api-key → `clearApiKey()` *deletes* `process.env.ANTHROPIC_API_KEY`).
    // We sanitize only this child's env, never the orchestrator's own, so
    // env-var auth keeps working everywhere else (dogfooding, agent turns).
    const loginEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete loginEnv.ANTHROPIC_API_KEY;
    delete loginEnv.ANTHROPIC_AUTH_TOKEN;
    // `CLAUDE_CODE_OAUTH_TOKEN` (set by `claude setup-token`) is a third
    // subscription bearer the CLI honors over the interactive flow — strip it
    // too so a forwarded token (e.g. dogfood secrets) can't short-circuit the
    // code-paste flow into the same "Starting…" hang.
    delete loginEnv.CLAUDE_CODE_OAUTH_TOKEN;
    this.emitProgress("waiting_for_cli", "Launching Claude CLI login.");

    // Use a wide terminal to minimize URL wrapping
    this.proc = pty.spawn("claude", ["/login"], {
      name: "xterm-256color",
      cols: 200,
      rows: 24,
      env: loginEnv,
    });
    console.log("[auth] Spawned claude /login (pid %d)", this.proc.pid);
    this.emitDiagnosticLog("info", "shipit", `Spawned claude /login process with pid ${this.proc.pid}.`);
    this.emitProgress("waiting_for_url", "Waiting for Claude CLI to print an authentication link.");

    // Watchdog: if no output after 15s, log diagnostic info
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
            this.emitDiagnosticLog("info", "shipit", "Detected Claude authentication URL.");
            this.emitProgress("waiting_for_code", "Authentication link detected. Waiting for authorization code.");
            this.emitAuthUrl(url);
          }
        } else {
          // Fallback: check for auth URL patterns directly in the buffer
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

      // Send Enter to navigate past interactive prompts (trust, login method).
      // Debounce: wait for output to settle before pressing Enter.
      this.scheduleWizardEnter();
    });

    this.proc.onExit(({ exitCode }) => {
      console.log("[auth] OAuth process exited with code", exitCode);
      this.emitDiagnosticLog(exitCode === 0 ? "info" : "warn", "shipit", `Claude login process exited with code ${exitCode}.`);
      this.proc = null;

      // Last chance: try to extract URL from buffer if not yet emitted
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

      // Check if *fresh* credentials were written by this flow. A pre-existing
      // stale file must not count — see `credentialBaselineMtime`.
      if (this.hasFreshCredentials()) {
        console.log("[auth] Authentication successful");
        this.emitProgress("complete", "Claude sign-in completed.");
        this.emitDiagnosticLog("info", "shipit", "Fresh Claude credentials were written.");
        // Only the singleton flow owns the global `_authenticated` flag; a
        // scoped flow's success is reflected on its account row instead.
        if (!this.activeCredentialDir) this._authenticated = true;
        this.lastPendingDetails = null;
        this.emit("auth_complete");
        // Normalized AgentAuthManager event — listeners that key off the
        // agent-id map (limits-registry rearm, SSE rebroadcast as
        // `agent_auth_complete`, etc.) subscribe here so they don't have to
        // know which backend's CLI just finished. The SSE wiring reads
        // `getActiveAccountId()` synchronously here, so clear the scope
        // *after* the emit returns.
        this.emit("complete");
      } else {
        console.log("[auth] Authentication may have failed (no credentials found)");
        this.emitProgress("failed", "Claude sign-in ended before fresh credentials were written.");
        this.emitDiagnosticLog("error", "shipit", "Claude login process exited without writing fresh credentials.");
        this.lastPendingDetails = null;
        this.emit("auth_failed");
        // `error` is the catch-all reason for "we tried, it didn't work" —
        // distinguishes this from `timeout`/`denied`/`revoked` so the UI can
        // tailor the next-step copy. Mirrors `CodexAuthFailedEvent`.
        this.emit("failed", { reason: "error" });
      }
      this.clearActiveScope();
    });
  }

  /**
   * Forget the in-flight flow's account scope. Called after the terminal
   * `complete`/`failed` events have fired (the SSE wiring reads
   * {@link getActiveAccountId} synchronously inside those handlers, so
   * clearing earlier would strand the broadcast with a `null` account).
   */
  private clearActiveScope(): void {
    this.activeCredentialDir = null;
    this.activeFlowAccountId = null;
    this.activeAttemptId = null;
    this.activeAttemptStartedAt = 0;
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
        this.emitDiagnosticLog("warn", "shipit", `Exhausted wizard Enter attempts. Buffered output length: ${this.outputBuffer.length} characters.`);
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
        this.emitDiagnosticLog("debug", "shipit", `Sent Enter to Claude CLI wizard (${this.wizardEnterCount}/10).`);
        this.proc.write("\r");
        // Self-schedule: if the CLI doesn't produce output after this
        // Enter, we'll still send the next one after a longer delay.
        this.scheduleWizardEnter();
      }
    }, delay);
  }

  /** Find the position of the first trigger phrase in the output buffer. */
  private findTriggerPos(): number {
    return this.outputBuffer.search(CODE_PASTE_TRIGGER);
  }

  /** Write an authorization code to the PTY (for the "Paste code here" prompt). */
  sendCode(code: string): void {
    if (this.proc) {
      const trimmed = code.trim();
      console.log("[auth] Sending auth code to PTY (%d chars)", trimmed.length);
      this.emitProgress("checking_credentials", "Authorization code submitted. Checking for credentials.");
      this.emitDiagnosticLog("info", "shipit", `Authorization code submitted (${trimmed.length} characters redacted).`);
      // Write code characters first, then Enter (\r) after a short delay.
      // Sending them separately ensures the CLI's Ink input handler processes
      // the code text before receiving the Enter keypress.
      this.proc.write(trimmed);
      setTimeout(() => {
        if (this.proc) {
          console.log("[auth] Sending Enter to confirm code");
          this.emitDiagnosticLog("debug", "shipit", "Sent Enter to confirm the authorization code.");
          this.proc.write("\r");
        }
      }, 200);
      // The CLI may stay running in interactive mode after authentication
      // succeeds (it enters the REPL rather than exiting). Poll for
      // credentials on disk so we can detect success without waiting for exit.
      this.startCredentialsPoll();
    } else {
      console.warn("[auth] Cannot send code — no PTY process");
      this.emitDiagnosticLog("warn", "shipit", "Cannot submit authorization code because no Claude login process is active.");
    }
  }

  /** Poll for credentials appearing on disk after code submission. */
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
        this.emitProgress("complete", "Claude sign-in completed.");
        this.emitDiagnosticLog("info", "shipit", "Fresh Claude credentials detected on disk.");
        if (!this.activeCredentialDir) this._authenticated = true;
        this.lastPendingDetails = null;
        this.clearCredentialsPoll();
        // kill() tears down the PTY/timers but deliberately leaves the active
        // scope intact so the emit below still reports the right account.
        this.kill();
        this.emit("auth_complete");
        this.emit("complete");
        this.clearActiveScope();
      } else if (attempts >= 60) {
        // Give up after 30 seconds (60 × 500ms)
        console.log("[auth] Credentials poll timed out — no fresh credentials written to", configDir);
        this.emitProgress("failed", "Timed out waiting for Claude credentials.");
        this.emitDiagnosticLog("error", "shipit", "Credentials poll timed out after 30 seconds.");
        this.lastPendingDetails = null;
        this.clearCredentialsPoll();
        this.emit("auth_failed");
        this.emit("failed", { reason: "timeout", message: "Credentials poll timed out after 30s" });
        this.clearActiveScope();
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
  signOut(opts?: AgentAuthScopeOptions): void {
    this.kill();
    this.removeCredentialFiles(this.claudeConfigDir(opts?.credentialDir ?? null));
    // Re-derive the singleton flag only for a singleton sign-out; a scoped
    // sign-out leaves the global state alone.
    if (!opts?.credentialDir) this.checkCredentials();
  }

  /**
   * Delete every candidate credential file in `configDir`. Shared by
   * {@link signOut} and {@link startOAuthFlow}: a fresh interactive login must
   * start from a clean slate (see the call site in `startOAuthFlow` for why).
   * Idempotent — missing files are skipped.
   */
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
