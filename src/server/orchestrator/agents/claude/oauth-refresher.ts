import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killChild } from "../../../shared/kill-child.js";
import type { AgentId } from "../../../shared/types.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { RuntimeMode } from "../../app-di.js";
import {
  perSessionCredentialsDir,
  readSessionAccountMarker,
  sessionCredentialsRoot,
} from "../../session-credentials-scaffold.js";
import {
  isBlankedClaudeCredential,
  sessionTokenIsAheadOfSource,
  syncProviderAccountTokenBack,
} from "../../token-sync-manager.js";

const SAFETY_MARGIN_MS = 45 * 60 * 1000;

const STARTUP_OVERDUE_DELAY_MS = 1_000;

const RATE_LIMIT_BACKOFF_MS: readonly number[] = [
  60_000,
  120_000,
  300_000,
  600_000,
  1_800_000,
];

const GENERIC_BACKOFF_MS: readonly number[] = [
  30_000,
  60_000,
  300_000,
  900_000,
];

const TIER1_TIMEOUT_MS = 30_000;
const TIER2_TIMEOUT_MS = 60_000;

const CLAUDE_CREDENTIALS_RELATIVE = path.join(".claude", ".credentials.json");

// A generic 401 can mean an expired access token, not a revoked refresh grant.
const TERMINAL_AUTH_FAILURE_PATTERNS = [
  "invalid_grant",
  "invalid_refresh_token",
  "invalid refresh token",
];

const NO_EXPIRY = null;

const REASON_MAX_CHARS = 300;

const FAILURE_SIGNAL_PATTERN =
  /(error|invalid|denied|forbidden|unauthor|rate[ _-]?limit|429|401|403|timeout|refus|fail|expired)/i;

const CREDENTIAL_HEADER_PATTERN =
  /^([ \t>|-]*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|anthropic-api-key)(\s*[:=]\s*).*$/gim;

// Short, unprefixed secrets in unknown fields can escape this filter.
function redactSecrets(text: string): string {
  return text
    .replace(CREDENTIAL_HEADER_PATTERN, "$1$2$3[redacted]")
    .replace(/("[A-Za-z_]*(?:token|secret|key|password|passwd|auth)[A-Za-z_]*"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\b(bearer|basic)(\s+)\S+/gi, "$1$2[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-+/]{24,}={0,2}/g, "[redacted]");
}

export function summarizeRefreshFailure(combinedOutput: string): string {
  const lines = redactSecrets(combinedOutput)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const signal = lines.filter((line) => FAILURE_SIGNAL_PATTERN.test(line));
  const joined = (signal.length > 0 ? signal : lines).slice(-3).join(" | ").replace(/\s+/g, " ");
  if (!joined) return "no CLI output";
  return joined.length > REASON_MAX_CHARS ? `${joined.slice(0, REASON_MAX_CHARS - 1)}…` : joined;
}

// Diagnosis only: changing a blanked source could race with a new sign-in.
interface UnusableSource {
  kind: "missing" | "blanked" | "unreadable";
  detail: string;
}

interface HarvestResult {
  sessionId: string;
  before: number | null;
  after: number;
}

export type RefreshOutcome =
  | "rotated_tier1"
  | "rotated_tier2"
  | "harvested_session"
  | "noop"
  | "rate_limited"
  | "revoked"
  | "unknown_failure"
  | "missing_credentials";

export interface RefreshResult {
  outcome: RefreshOutcome;
  accountId: string;
  beforeExpiresAt: number | null;
  afterExpiresAt: number | null;
  reason?: string;
}

export interface ClaudeOAuthRefresherEvents {
  refreshed: [accountId: string, expiresAt: number];
  account_unauthenticated: [accountId: string];
  account_reauthenticated: [accountId: string];
}

interface AccountState {
  accountId: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<RefreshResult> | null;
  failureCount: number;
  emittedUnauthenticated: boolean;
}

export interface ClaudeOAuthRefresherDeps {
  credentialsDir: string;
  providerAccountManager: ProviderAccountManager;
  repushAccountToken: (agentId: AgentId, accountId: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  runtimeMode: RuntimeMode;
  now?: () => number;
  spawn?: typeof nodeSpawn;
  safetyMarginMs?: number;
}

export class ClaudeOAuthRefresher extends EventEmitter<ClaudeOAuthRefresherEvents> {
  private readonly deps: Required<Omit<ClaudeOAuthRefresherDeps, "safetyMarginMs">> & { safetyMarginMs: number };
  private readonly accounts = new Map<string, AccountState>();
  private started = false;
  private stopped = false;

  constructor(deps: ClaudeOAuthRefresherDeps) {
    super();
    this.deps = {
      credentialsDir: deps.credentialsDir,
      providerAccountManager: deps.providerAccountManager,
      repushAccountToken: deps.repushAccountToken,
      sseBroadcast: deps.sseBroadcast,
      runtimeMode: deps.runtimeMode,
      now: deps.now ?? (() => Date.now()),
      spawn: deps.spawn ?? nodeSpawn,
      safetyMarginMs: deps.safetyMarginMs ?? SAFETY_MARGIN_MS,
    };
  }

  start(): void {
    if (this.stopped) return;
    this.started = true;
    if (this.deps.runtimeMode !== "containerized") {
      console.log("[claude-oauth-refresh] skipping start: runtimeMode != containerized");
      return;
    }
    for (const account of this.deps.providerAccountManager.list("anthropic")) {
      this.scheduleAccount(account.id);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const state of this.accounts.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
  }

  async refreshNow(accountId?: string): Promise<RefreshResult[]> {
    if (this.deps.runtimeMode !== "containerized") {
      return [];
    }
    if (accountId) {
      return [await this.runTickForAccount(accountId)];
    }
    const accounts = this.deps.providerAccountManager.list("anthropic");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id)));
  }

  // Pass the turn's account ID; an omitted ID includes failures from other accounts.
  async ensureFresh(accountId?: string, opts?: { force?: boolean }): Promise<boolean> {
    if (this.deps.runtimeMode !== "containerized") return true;
    const force = opts?.force ?? false;
    if (accountId) return this.ensureFreshOne(accountId, force);
    const accounts = this.deps.providerAccountManager.list("anthropic");
    if (accounts.length === 0) return true;
    const results = await Promise.all(accounts.map((a) => this.ensureFreshOne(a.id, force)));
    return results.every(Boolean);
  }

  private async ensureFreshOne(accountId: string, force = false): Promise<boolean> {
    const before = this.readSourceExpiresAt(accountId);
    if (before === NO_EXPIRY) return false;
    const now = this.deps.now();
    if (!force && before - now > this.deps.safetyMarginMs) return true;
    let outcome: RefreshOutcome | null = null;
    try {
      outcome = (await this.runTickForAccount(accountId, force)).outcome;
    } catch (err) {
      console.error(`[claude-oauth-refresh] ensureFresh tick for ${accountId} threw:`, err);
    }
    const after = this.readSourceExpiresAt(accountId);
    if (after === NO_EXPIRY) return false;
    if (force && (outcome === "revoked" || outcome === "missing_credentials")) {
      console.log(
        `[claude-oauth-refresh] account=${accountId} forced heal probe reported ${outcome} — not healed`,
      );
      return false;
    }
    return after > this.deps.now();
  }

  private scheduleAccount(accountId: string): void {
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const expiresAt = this.readSourceExpiresAt(accountId);
    if (expiresAt === NO_EXPIRY) {
      return;
    }
    const now = this.deps.now();
    const fireAt = expiresAt - this.deps.safetyMarginMs;
    const delay = Math.max(STARTUP_OVERDUE_DELAY_MS, fireAt - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[claude-oauth-refresh] unexpected error in tick for ${accountId}:`, err);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private scheduleBackoff(accountId: string, schedule: readonly number[]): void {
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const idx = Math.min(state.failureCount, schedule.length - 1);
    const delay = schedule[idx];
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[claude-oauth-refresh] unexpected error in backoff tick for ${accountId}:`, err);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private runTickForAccount(accountId: string, force = false): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId, force).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = promise;
    return promise;
  }

  private async executeTick(accountId: string, force = false): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("claude", accountId);
    const sourceFile = this.sourceFileFor(accountId);

    // Harvest first: a resident CLI can spend the source's single-use refresh grant.
    // This skips forced probing, so a grant revoked since the session's refresh can pass.
    const harvest = this.harvestSessionRotations(accountId);
    if (harvest) {
      return this.handleSuccess(accountId, harvest.before, harvest.after, "harvested_session");
    }

    const before = this.readSourceExpiresAt(accountId);
    if (before === NO_EXPIRY) {
      const unusable = this.describeUnusableSource(sourceFile);
      const result: RefreshResult = {
        outcome: "missing_credentials",
        accountId,
        beforeExpiresAt: null,
        afterExpiresAt: null,
        reason: unusable.detail,
      };
      console.log(
        `[claude-oauth-refresh] account=${accountId} missing_credentials — waiting for auth_complete`
          + ` source=${unusable.kind} detail=${unusable.detail}`,
      );
      this.emitUnauthenticated(accountId, "missing_credentials");
      return result;
    }

    const tier1Log = await this.spawnCliInRoot(
      ["auth", "status", "--json"],
      accountRoot,
      TIER1_TIMEOUT_MS,
    );
    const afterTier1 = this.readSourceExpiresAt(accountId);

    if (afterTier1 !== NO_EXPIRY && afterTier1 > before) {
      return this.handleSuccess(accountId, before, afterTier1, "rotated_tier1");
    }

    const now = this.deps.now();
    const isNearExpiry = before <= now + this.deps.safetyMarginMs;
    // A session's 401 needs a probe even when the source has time left.
    const runTier2 = force || isNearExpiry;

    if (!runTier2) {
      state.failureCount = 0;
      this.handleHealthySource(accountId);
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: afterTier1,
      };
    }

    // This billable call triggers the CLI's refresh-on-use path.
    const tier2Log = await this.spawnCliInRoot(
      [
        "--print", "ok",
        "--model", "claude-haiku-4-5-20251001",
        "--tools", "",
        "--no-session-persistence",
      ],
      accountRoot,
      TIER2_TIMEOUT_MS,
    );
    const afterTier2 = this.readSourceExpiresAt(accountId);

    if (afterTier2 !== NO_EXPIRY && afterTier2 > before) {
      return this.handleSuccess(accountId, before, afterTier2, "rotated_tier2");
    }

    const combinedOutput = `${tier1Log}\n${tier2Log}`;
    // No rotation before expiry is not a scheduling failure; retain the expiry schedule.
    if (force && !isNearExpiry && !this.outputIndicatesRevoked(combinedOutput)) {
      state.failureCount = 0;
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: afterTier2,
        reason: "forced validity probe found a live token that needed no rotation",
      };
    }
    return this.handleFailure(accountId, before, afterTier2, combinedOutput);
  }

  private outputIndicatesRevoked(combinedOutput: string): boolean {
    const lc = combinedOutput.toLowerCase();
    return TERMINAL_AUTH_FAILURE_PATTERNS.some((phrase) => lc.includes(phrase));
  }

  private handleSuccess(
    accountId: string,
    before: number | null,
    after: number,
    outcome: "rotated_tier1" | "rotated_tier2" | "harvested_session",
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    const wasUnauthenticated = state.emittedUnauthenticated;
    state.emittedUnauthenticated = false;
    console.log(
      `[claude-oauth-refresh] account=${accountId} ${outcome} new_expires_at=${new Date(after).toISOString()}`,
    );
    try {
      this.deps.repushAccountToken("claude", accountId);
    } catch (err) {
      console.error(`[claude-oauth-refresh] account=${accountId} repush failed:`, err);
    }
    this.emit("refreshed", accountId, after);
    if (wasUnauthenticated) {
      this.deps.sseBroadcast("claude_account_authenticated", { accountId });
      this.emit("account_reauthenticated", accountId);
    }
    this.scheduleAccount(accountId);
    return {
      outcome,
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
    };
  }

  private handleFailure(
    accountId: string,
    before: number,
    after: number | null,
    combinedOutput: string,
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount += 1;
    const lc = combinedOutput.toLowerCase();
    const reason = summarizeRefreshFailure(combinedOutput);
    const isRateLimited =
      lc.includes("429") || lc.includes("rate_limit") || lc.includes("rate limited");
    const isRevoked = this.outputIndicatesRevoked(combinedOutput);

    if (isRevoked) {
      console.log(`[claude-oauth-refresh] account=${accountId} revoked (${this.authFailureReason(lc)}) — emitting auth_required`);
      this.emitUnauthenticated(accountId, "revoked");
      return {
        outcome: "revoked",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason: this.authFailureReason(lc),
      };
    }

    if (isRateLimited) {
      console.log(
        `[claude-oauth-refresh] account=${accountId} rate_limited failure_count=${state.failureCount} — backoff scheduled`
          + ` reason="${reason}"`,
      );
      this.scheduleBackoff(accountId, RATE_LIMIT_BACKOFF_MS);
      return {
        outcome: "rate_limited",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason,
      };
    }

    console.log(
      `[claude-oauth-refresh] account=${accountId} unknown_failure failure_count=${state.failureCount} — short backoff`
        + ` reason="${reason}"`,
    );
    this.scheduleBackoff(accountId, GENERIC_BACKOFF_MS);
    return {
      outcome: "unknown_failure",
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
      reason,
    };
  }

  private authFailureReason(lcOutput: string): string {
    return TERMINAL_AUTH_FAILURE_PATTERNS.find((phrase) => lcOutput.includes(phrase)) ?? "auth_failure";
  }

  private emitUnauthenticated(accountId: string, reason: "revoked" | "missing_credentials"): void {
    const state = this.ensureAccountState(accountId);
    if (state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("claude_account_unauthenticated", { accountId });
    this.deps.sseBroadcast("agent_auth_failed", { loginId: "anthropic-oauth", accountId, reason });
  }

  private handleHealthySource(accountId: string): void {
    const state = this.ensureAccountState(accountId);
    if (!state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = false;
    try {
      this.deps.repushAccountToken("claude", accountId);
    } catch (err) {
      console.error(`[claude-oauth-refresh] account=${accountId} recovery repush failed:`, err);
    }
    this.deps.sseBroadcast("claude_account_authenticated", { accountId });
    this.emit("account_reauthenticated", accountId);
  }

  private spawnCliInRoot(
    args: string[],
    accountRoot: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      let debugFile: string | null = null;
      try {
        debugFile = path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-refresh-")),
          "debug.log",
        );
      } catch (err) {
        console.warn("[claude-oauth-refresh] failed to create debug log file:", err);
      }
      const fullArgs = [...args];
      if (debugFile) {
        fullArgs.push("--debug", "api", "--debug-file", debugFile);
      }
      const opts: SpawnOptions = {
        env: { ...process.env, HOME: accountRoot },
        stdio: ["ignore", "pipe", "pipe"],
      };
      let child: ChildProcess;
      try {
        child = this.deps.spawn("claude", fullArgs, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (debugFile) this.cleanupDebugDir(debugFile);
        resolve(`[spawn-failed] ${msg}`);
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killChild(child, "SIGKILL");
        finish("[timeout] claude CLI did not exit in time");
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      const finish = (extra: string): void => {
        let debugContent = "";
        if (debugFile) {
          try {
            if (fs.existsSync(debugFile)) {
              debugContent = fs.readFileSync(debugFile, "utf8");
            }
          } catch { /* */ }
          this.cleanupDebugDir(debugFile);
        }
        resolve(`${stdout}\n${stderr}\n${debugContent}\n${extra}`.trim());
      };

      child.on("exit", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish("");
      });
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        finish(`[error] ${err.message}`);
      });
    });
  }

  private cleanupDebugDir(debugFile: string): void {
    try {
      fs.rmSync(path.dirname(debugFile), { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // Require both the account marker and physical containment. The writable marker
  // records intended ownership; it cannot prove which account owns the token bytes.
  // Write-back guards also reject recorded sub-agent borrows.
  private harvestSessionRotations(accountId: string): HarvestResult | null {
    const credentialsDir = this.deps.credentialsDir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(sessionCredentialsRoot(credentialsDir), { withFileTypes: true });
    } catch {
      return null;
    }
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((sessionId) => readSessionAccountMarker(credentialsDir, sessionId).claude === accountId)
      .filter((sessionId) => this.tokenFileIsOwnedBySubtree(sessionId));
    if (candidates.length === 0) return null;

    const before = this.readSourceExpiresAt(accountId);
    let best = before;
    let adoptedFrom: string | null = null;
    for (const sessionId of candidates) {
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, "claude", accountId)) continue;
      try {
        syncProviderAccountTokenBack(credentialsDir, sessionId, "claude", accountId, { sessionOwnRoute: true });
      } catch (err) {
        console.warn(`[claude-oauth-refresh] account=${accountId} harvest from session ${sessionId} failed:`, err);
        continue;
      }
      const after = this.readSourceExpiresAt(accountId);
      if (after === NO_EXPIRY) continue;
      if (best !== NO_EXPIRY && after <= best) continue;
      best = after;
      adoptedFrom = sessionId;
    }
    if (adoptedFrom === null || best === NO_EXPIRY) return null;
    console.log(
      `[claude-oauth-refresh] account=${accountId} harvested a session-side rotation from ${adoptedFrom}`
        + ` was=${before === NO_EXPIRY ? "none" : new Date(before).toISOString()}`
        + ` now=${new Date(best).toISOString()}`,
    );
    return { sessionId: adoptedFrom, before, after: best };
  }

  // Resolve parent symlinks too: .claude can point into another account's root.
  private tokenFileIsOwnedBySubtree(sessionId: string): boolean {
    const sessionDir = perSessionCredentialsDir(this.deps.credentialsDir, sessionId);
    try {
      const resolvedFile = fs.realpathSync(this.sessionTokenFileFor(sessionId));
      const resolvedDir = fs.realpathSync(sessionDir);
      return resolvedFile.startsWith(resolvedDir + path.sep);
    } catch {
      return false;
    }
  }

  private sourceFileFor(accountId: string): string {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("claude", accountId);
    return path.join(accountRoot, CLAUDE_CREDENTIALS_RELATIVE);
  }

  private sessionTokenFileFor(sessionId: string): string {
    return path.join(
      perSessionCredentialsDir(this.deps.credentialsDir, sessionId),
      CLAUDE_CREDENTIALS_RELATIVE,
    );
  }

  private readSourceExpiresAt(accountId: string): number | null {
    return this.readClaudeExpiresAt(this.sourceFileFor(accountId));
  }

  private readClaudeExpiresAt(file: string): number | null {
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
      const expiresAtRaw = oauth?.expiresAt;
      if (typeof expiresAtRaw === "number" && Number.isFinite(expiresAtRaw) && expiresAtRaw > 0) {
        // Heuristic: < 10^10 means seconds, otherwise ms.
        return expiresAtRaw < 10_000_000_000 ? expiresAtRaw * 1000 : expiresAtRaw;
      }
    } catch { /* missing/invalid */ }
    return null;
  }

  private describeUnusableSource(file: string): UnusableSource {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return { kind: "missing", detail: `source file missing at ${file}` };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { kind: "unreadable", detail: `source file at ${file} is not parseable JSON` };
    }
    if (isBlankedClaudeCredential(parsed)) {
      return {
        kind: "blanked",
        detail: `the CLI blanked the source at ${file} (empty accessToken/refreshToken, expiresAt=0)`,
      };
    }
    return { kind: "unreadable", detail: `source file at ${file} carries no usable expiry` };
  }

  private ensureAccountState(accountId: string): AccountState {
    let state = this.accounts.get(accountId);
    if (!state) {
      state = {
        accountId,
        timer: null,
        inFlight: null,
        failureCount: 0,
        emittedUnauthenticated: false,
      };
      this.accounts.set(accountId, state);
    }
    return state;
  }

  _inspectForTest(accountId: string): Readonly<Pick<AccountState, "failureCount" | "emittedUnauthenticated">> & {
    hasTimer: boolean;
    hasInFlight: boolean;
  } {
    const state = this.ensureAccountState(accountId);
    return {
      failureCount: state.failureCount,
      emittedUnauthenticated: state.emittedUnauthenticated,
      hasTimer: state.timer !== null,
      hasInFlight: state.inFlight !== null,
    };
  }

  _knownAccountsForTest(): string[] {
    return Array.from(this.accounts.keys());
  }
}
