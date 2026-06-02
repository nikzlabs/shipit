/**
 * Orchestrator-owned Codex OAuth refresh readiness (docs/154).
 *
 * Codex has the same structural risk Claude had before docs/153: every
 * session container holds a copied OAuth token and, if OpenAI ever makes
 * refresh tokens single-use or shortens access-token TTLs, N sessions behind
 * one outbound NAT could stampede the token endpoint. This refresher keeps
 * the source Codex token fresh from the orchestrator so session CLIs remain
 * consumers rather than independent refreshers.
 *
 * The refresh is delegated to the `codex` CLI. We do not implement OpenAI's
 * OAuth wire protocol in ShipIt; we spawn the pinned CLI against the account
 * credential root and use the auth file's freshness advancing as the success
 * signal.
 */

import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { AgentId, ProviderAccount } from "../../../shared/types.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { RuntimeMode } from "../../app-di.js";
import { readCodexTokenFreshness } from "../../session-credentials.js";

const SAFETY_MARGIN_MS = 45 * 60 * 1000;
const STARTUP_OVERDUE_DELAY_MS = 1_000;
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000, 1_800_000];
const GENERIC_BACKOFF_MS: readonly number[] = [30_000, 60_000, 300_000, 900_000];
const TIER1_TIMEOUT_MS = 30_000;
const TIER2_TIMEOUT_MS = 60_000;
const CODEX_AUTH_RELATIVE = path.join(".codex", "auth.json");
const NO_FRESHNESS = null;

export type CodexRefreshOutcome =
  | "rotated_tier1"
  | "rotated_tier2"
  | "noop"
  | "rate_limited"
  | "revoked"
  | "unknown_failure"
  | "missing_credentials";

export interface CodexRefreshResult {
  outcome: CodexRefreshOutcome;
  accountId: string;
  beforeFreshness: number | null;
  afterFreshness: number | null;
  reason?: string;
}

export interface CodexOAuthRefresherEvents {
  refreshed: [accountId: string, freshness: number];
  account_unauthenticated: [accountId: string];
}

interface AccountState {
  accountId: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<CodexRefreshResult> | null;
  failureCount: number;
  emittedUnauthenticated: boolean;
}

export interface CodexOAuthRefresherDeps {
  credentialsDir: string;
  providerAccountManager: ProviderAccountManager;
  repushAccountToken: (agentId: AgentId, accountId: string) => void;
  sseBroadcast: (event: string, data: unknown) => void;
  runtimeMode: RuntimeMode;
  now?: () => number;
  spawn?: typeof nodeSpawn;
  safetyMarginMs?: number;
}

export class CodexOAuthRefresher extends EventEmitter {
  private readonly deps: Required<Omit<CodexOAuthRefresherDeps, "safetyMarginMs">> & { safetyMarginMs: number };
  private readonly accounts = new Map<string, AccountState>();
  private stopped = false;

  constructor(deps: CodexOAuthRefresherDeps) {
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
    if (this.deps.runtimeMode !== "containerized") {
      console.log("[codex-oauth-refresh] skipping start: runtimeMode != containerized");
      return;
    }
    for (const account of this.deps.providerAccountManager.list("codex")) {
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

  async refreshNow(accountId?: string): Promise<CodexRefreshResult[]> {
    if (this.deps.runtimeMode !== "containerized") return [];
    if (accountId) return [await this.runTickForAccount(accountId)];
    const accounts = this.deps.providerAccountManager.list("codex");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id)));
  }

  private scheduleAccount(accountId: string): void {
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const freshness = this.readSourceFreshness(accountId);
    if (freshness === NO_FRESHNESS) return;
    const now = this.deps.now();
    const fireAt = freshness - this.deps.safetyMarginMs;
    const delay = Math.max(STARTUP_OVERDUE_DELAY_MS, fireAt - now);
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[codex-oauth-refresh] unexpected error in tick for ${accountId}:`, err);
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
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[codex-oauth-refresh] unexpected error in backoff tick for ${accountId}:`, err);
      });
    }, schedule[idx]);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private runTickForAccount(accountId: string): Promise<CodexRefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = promise;
    return promise;
  }

  private async executeTick(accountId: string): Promise<CodexRefreshResult> {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("codex", accountId);
    const sourceFile = path.join(accountRoot, CODEX_AUTH_RELATIVE);
    const before = this.readSourceFreshness(accountId);
    if (before === NO_FRESHNESS) {
      const result: CodexRefreshResult = {
        outcome: "missing_credentials",
        accountId,
        beforeFreshness: null,
        afterFreshness: null,
        reason: `source file missing or unparseable at ${sourceFile}`,
      };
      console.log(`[codex-oauth-refresh] account=${accountId} missing_credentials — waiting for auth_complete`);
      return result;
    }

    const tier1Log = await this.spawnCliInRoot(["login", "status"], accountRoot, TIER1_TIMEOUT_MS);
    const afterTier1 = this.readSourceFreshness(accountId);
    if (afterTier1 !== NO_FRESHNESS && afterTier1 > before) {
      return this.handleSuccess(accountId, before, afterTier1, "rotated_tier1");
    }

    const now = this.deps.now();
    const nearExpiry = before <= now + this.deps.safetyMarginMs;
    if (!nearExpiry) {
      const state = this.ensureAccountState(accountId);
      state.failureCount = 0;
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeFreshness: before,
        afterFreshness: afterTier1,
      };
    }

    const tier2Log = await this.spawnCliInRoot(
      ["exec", "--skip-git-repo-check", "ok"],
      accountRoot,
      TIER2_TIMEOUT_MS,
    );
    const afterTier2 = this.readSourceFreshness(accountId);
    if (afterTier2 !== NO_FRESHNESS && afterTier2 > before) {
      return this.handleSuccess(accountId, before, afterTier2, "rotated_tier2");
    }

    return this.handleFailure(accountId, before, afterTier2, `${tier1Log}\n${tier2Log}`);
  }

  private handleSuccess(
    accountId: string,
    before: number,
    after: number,
    outcome: "rotated_tier1" | "rotated_tier2",
  ): CodexRefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    const wasUnauthenticated = state.emittedUnauthenticated;
    state.emittedUnauthenticated = false;
    console.log(
      `[codex-oauth-refresh] account=${accountId} ${outcome} new_freshness=${new Date(after).toISOString()}`,
    );
    try {
      this.deps.repushAccountToken("codex", accountId);
    } catch (err) {
      console.error(`[codex-oauth-refresh] account=${accountId} repush failed:`, err);
    }
    this.emit("refreshed", accountId, after);
    if (wasUnauthenticated) {
      this.deps.sseBroadcast("codex_account_authenticated", { accountId });
    }
    this.scheduleAccount(accountId);
    return {
      outcome,
      accountId,
      beforeFreshness: before,
      afterFreshness: after,
    };
  }

  private handleFailure(
    accountId: string,
    before: number,
    after: number | null,
    combinedOutput: string,
  ): CodexRefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount += 1;
    const lc = combinedOutput.toLowerCase();
    const isRateLimited =
      lc.includes("429") || lc.includes("rate_limit") || lc.includes("rate limited");
    const isRevoked =
      lc.includes("invalid_grant") || lc.includes("invalid_refresh_token") || lc.includes("invalid refresh token");

    if (isRevoked) {
      console.log(`[codex-oauth-refresh] account=${accountId} revoked (invalid_grant) — emitting auth_required`);
      this.emitUnauthenticated(accountId);
      return {
        outcome: "revoked",
        accountId,
        beforeFreshness: before,
        afterFreshness: after,
        reason: "invalid_grant",
      };
    }

    if (isRateLimited) {
      console.log(
        `[codex-oauth-refresh] account=${accountId} rate_limited failure_count=${state.failureCount} — backoff scheduled`,
      );
      this.scheduleBackoff(accountId, RATE_LIMIT_BACKOFF_MS);
      return {
        outcome: "rate_limited",
        accountId,
        beforeFreshness: before,
        afterFreshness: after,
        reason: "rate_limit",
      };
    }

    console.log(
      `[codex-oauth-refresh] account=${accountId} unknown_failure failure_count=${state.failureCount} — short backoff`,
    );
    this.scheduleBackoff(accountId, GENERIC_BACKOFF_MS);
    return {
      outcome: "unknown_failure",
      accountId,
      beforeFreshness: before,
      afterFreshness: after,
      reason: combinedOutput.slice(0, 200) || "no CLI output",
    };
  }

  private emitUnauthenticated(accountId: string): void {
    const state = this.ensureAccountState(accountId);
    if (state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("codex_account_unauthenticated", { accountId });
    this.deps.sseBroadcast("agent_auth_failed", { agentId: "codex", reason: "revoked" });
  }

  private spawnCliInRoot(args: string[], accountRoot: string, timeoutMs: number): Promise<string> {
    return new Promise<string>((resolve) => {
      const opts: SpawnOptions = {
        env: { ...process.env, HOME: accountRoot },
        stdio: ["ignore", "pipe", "pipe"],
      };
      let child: ChildProcess;
      try {
        child = this.deps.spawn("codex", args, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve(`[spawn-failed] ${msg}`);
        return;
      }

      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

      const finish = (extra: string): void => {
        resolve(`${stdout}\n${stderr}\n${extra}`.trim());
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGKILL"); } catch { /* best-effort */ }
        finish("[timeout] codex CLI did not exit in time");
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

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

  private readSourceFreshness(accountId: string): number | null {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("codex", accountId);
    return readCodexTokenFreshness(path.join(accountRoot, CODEX_AUTH_RELATIVE));
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

export type { ProviderAccount };
