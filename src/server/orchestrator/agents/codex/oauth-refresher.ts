import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { AgentId } from "../../../shared/types.js";
import { killProcessTree } from "../../../shared/kill-child.js";
import { stripAnsi } from "../../../shared/strip-ansi.js";
import type { ProviderAccountManager } from "../../provider-account-manager.js";
import type { RuntimeMode } from "../../app-di.js";
import { readCodexTokenFreshness } from "../../session-credentials.js";
import {
  perSessionCredentialsDir,
  readSessionAccountMarker,
  sessionCredentialsRoot,
} from "../../session-credentials-scaffold.js";
import { sessionTokenIsAheadOfSource, syncProviderAccountTokenBack } from "../../token-sync-manager.js";
import { summarizeRefreshFailure } from "../claude/oauth-refresher.js";

// A session's CLI refreshes by itself only in the last 5 minutes of a token (docs/154).
const SAFETY_MARGIN_MS = 45 * 60 * 1000;
const STARTUP_OVERDUE_DELAY_MS = 1_000;
const RETRY_NOW_MS: readonly number[] = [STARTUP_OVERDUE_DELAY_MS];
const RATE_LIMIT_BACKOFF_MS: readonly number[] = [60_000, 120_000, 300_000, 600_000, 1_800_000];
const GENERIC_BACKOFF_MS: readonly number[] = [30_000, 60_000, 300_000, 900_000];
const REFRESH_TIMEOUT_MS = 30_000;
const EXIT_GRACE_MS = 5_000;

// A session's CLI that won the grant writes its rotation moments after the loser is refused;
// the late harvest looks this much later, so that a race does not read as a revocation.
const LATE_ROTATION_WAIT_MS = 5_000;

const CODEX_AUTH_RELATIVE = path.join(".codex", "auth.json");
const NO_FRESHNESS = null;

const TIMED_OUT = "[timeout] codex app-server did not answer in time";
const NO_REPLY = "[no-reply] codex app-server ended before it answered";

const INITIALIZE_ID = 0;
const REFRESH_ID = 1;

// scripts/probe-codex-refresh.mjs runs these against the real binary.
export const CODEX_REFRESH_COMMAND = ["app-server"] as const;
export const CODEX_REFRESH_MESSAGES = {
  initialize: {
    jsonrpc: "2.0",
    id: INITIALIZE_ID,
    method: "initialize",
    params: { clientInfo: { name: "shipit-codex-oauth-refresh", version: "1.0.0" } },
  },
  initialized: { jsonrpc: "2.0", method: "initialized" },
  // One refresh request at any time before expiry, and no model call.
  refresh: { jsonrpc: "2.0", id: REFRESH_ID, method: "account/read", params: { refreshToken: true } },
} as const;

export type CodexRefreshRefusal =
  | { kind: "rejected"; code: string }
  | { kind: "rate_limited" }
  | { kind: "none" };

// The token host's answers that are about the grant. Another 401 (`invalid_client`) is not.
const GRANT_REJECTION_CODES: ReadonlySet<string> = new Set([
  "refresh_token_reused",
  "refresh_token_invalidated",
  "refresh_token_expired",
  "invalid_grant",
]);

// The server has judged the grant itself: no session can hold its successor.
const DEFINITE_REVOCATION_CODES: ReadonlySet<string> = new Set([
  "refresh_token_invalidated",
  "refresh_token_expired",
]);

// What the CLI prints for the same answers outside app-server.
const REJECTION_MESSAGES: readonly (readonly [string, string])[] = [
  ["refresh token was already used", "refresh_token_reused"],
  ["refresh token was revoked", "refresh_token_invalidated"],
  ["refresh token has expired", "refresh_token_expired"],
];

// Color codes split `status=401`, and a timestamp uses up a third of a reason line's length.
// The email: the CLI knows the account's, and the reason goes to the log.
function stripLogDecoration(text: string): string {
  return stripAnsi(text)
    .replace(/^\s*\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/gm, "")
    .replace(/[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g, "[email]");
}

// Only the token host's answer to the refresh counts: a 401 from the model API is not a rejected grant.
export function classifyCodexRefreshOutput(output: string): CodexRefreshRefusal {
  let rateLimited = false;
  for (const line of stripLogDecoration(output).split(/\r?\n/)) {
    const lc = line.toLowerCase();
    if (!lc.includes("failed to refresh token")) continue;
    const status = /status=(\d{3})\b/.exec(line)?.[1] ?? /refresh token: (\d{3}) /.exec(line)?.[1];
    const code = /error_code: Some\("([^"]*)"\)/.exec(line)?.[1] ?? REJECTION_MESSAGES.find(([phrase]) => lc.includes(phrase))?.[1];
    if (code !== undefined && GRANT_REJECTION_CODES.has(code)) return { kind: "rejected", code };
    if (status === "429") rateLimited = true;
  }
  return rateLimited ? { kind: "rate_limited" } : { kind: "none" };
}

// Which credential a file holds. A hash, so that no token stays in memory; null without a token.
function codexCredentialIdentity(parsed: unknown): string | null {
  const tokens = (parsed as { tokens?: Record<string, unknown> } | null)?.tokens;
  const access = typeof tokens?.access_token === "string" ? tokens.access_token : "";
  const refresh = typeof tokens?.refresh_token === "string" ? tokens.refresh_token : "";
  if (!access && !refresh) return null;
  return createHash("sha256").update(`${access}\n${refresh}`).digest("hex");
}

export type CodexRefreshOutcome =
  | "rotated"
  | "harvested_session"
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
  account_reauthenticated: [accountId: string];
}

interface HarvestResult {
  before: number | null;
  after: number;
}

interface AccountState {
  accountId: string;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<CodexRefreshResult> | null;
  failureCount: number;
  emittedUnauthenticated: boolean;
  // The CLI leaves a rejected credential in the file, so this is the record that its grant is dead.
  rejectedIdentity: string | null;
  rejectedCode: string;
  // Until then a turn start leaves the retry to the schedule's backoff.
  retryNotBefore: number;
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
  lateRotationWaitMs?: number;
}

export class CodexOAuthRefresher extends EventEmitter<CodexOAuthRefresherEvents> {
  private readonly deps: Required<CodexOAuthRefresherDeps>;
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
      lateRotationWaitMs: deps.lateRotationWaitMs ?? LATE_ROTATION_WAIT_MS,
    };
  }

  start(): void {
    if (this.stopped) return;
    if (this.deps.runtimeMode !== "containerized") {
      console.log("[codex-oauth-refresh] skipping start: runtimeMode != containerized");
      return;
    }
    for (const account of this.deps.providerAccountManager.list("openai")) {
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
    if (this.deps.runtimeMode !== "containerized" && !accountId) return [];
    if (accountId) return [await this.runTickForAccount(accountId)];
    const accounts = this.deps.providerAccountManager.list("openai");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id)));
  }

  // A turn start asks if the token can be used. A forced call (a session's 401) asks if the source
  // holds another credential than the one the session failed with: time left on it proves nothing.
  async ensureFresh(accountId: string, opts?: { force?: boolean }): Promise<boolean> {
    const force = opts?.force ?? false;
    if (!this.sourceIsReadable(accountId)) return false;
    const before = this.readSourceFreshness(accountId);
    const now = this.deps.now();
    if (!force && before !== NO_FRESHNESS && !this.sourceGrantIsKnownRejected(accountId)) {
      if (before > now + this.deps.safetyMarginMs) return true;
      // A turn start in a backoff would only add a request to the retry that the schedule owns.
      if (now < this.ensureAccountState(accountId).retryNotBefore) return before > now;
    }
    const seedIdentity = this.readSourceIdentity(accountId);
    const { outcome } = await this.runTickForAccount(accountId, force);
    const after = this.readSourceFreshness(accountId);
    if (after === NO_FRESHNESS || after <= this.deps.now()) return false;
    if (outcome === "revoked" || outcome === "missing_credentials") return false;
    if (!force) return true;
    // The outcome too: a call that joins a tick after its rotation was written reads the new one as its seed.
    if (outcome === "rotated" || outcome === "harvested_session") return true;
    const identity = this.readSourceIdentity(accountId);
    return identity !== null && identity !== seedIdentity;
  }

  private async waitForLateRotation(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.lateRotationWaitMs);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  private scheduleAccount(accountId: string): void {
    if (this.deps.runtimeMode !== "containerized") return;
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
    state.retryNotBefore = 0;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[codex-oauth-refresh] unexpected error in tick for ${accountId}:`, err);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private scheduleBackoff(accountId: string, schedule: readonly number[]): void {
    if (this.deps.runtimeMode !== "containerized") return;
    if (this.stopped) return;
    const state = this.ensureAccountState(accountId);
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    const idx = Math.min(state.failureCount, schedule.length - 1);
    state.retryNotBefore = this.deps.now() + schedule[idx];
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId).catch((err: unknown) => {
        console.error(`[codex-oauth-refresh] unexpected error in backoff tick for ${accountId}:`, err);
      });
    }, schedule[idx]);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private runTickForAccount(accountId: string, force = false): Promise<CodexRefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId, force).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = promise;
    return promise;
  }

  private async executeTick(accountId: string, force = false): Promise<CodexRefreshResult> {
    const state = this.ensureAccountState(accountId);
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("codex", accountId);
    const sourceFile = path.join(accountRoot, CODEX_AUTH_RELATIVE);

    // Harvest first: a session's CLI can spend the source's single-use refresh grant.
    const harvest = this.harvestSessionRotations(accountId);
    if (harvest) return this.handleSuccess(accountId, harvest.before, harvest.after, "harvested_session");

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
      this.emitUnauthenticated(accountId, "missing_credentials");
      return result;
    }

    // Before the healthy-source branch: an unchanged dead grant must not read as a new sign-in.
    if (this.sourceGrantIsKnownRejected(accountId)) {
      return this.handleRevoked(accountId, before, before, state.rejectedCode);
    }

    const nearExpiry = before <= this.deps.now() + this.deps.safetyMarginMs;
    if (!nearExpiry && !force) {
      state.failureCount = 0;
      this.handleHealthySource(accountId);
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeFreshness: before,
        afterFreshness: before,
      };
    }

    const seedIdentity = this.readSourceIdentity(accountId);
    const log = await this.refreshOnDemand(accountRoot);
    const after = this.readSourceFreshness(accountId);
    // New tokens are a rotation whatever their expiry says, and a later expiry without tokens is none.
    const identityAfter = this.readSourceIdentity(accountId);
    if (after !== NO_FRESHNESS && identityAfter !== null && (after > before || identityAfter !== seedIdentity)) {
      return this.handleSuccess(accountId, before, after, "rotated");
    }

    const refusal = classifyCodexRefreshOutput(log);
    if (refusal.kind === "rejected") {
      // Before the source check: a session's rotation can reach the source during the wait.
      if (!DEFINITE_REVOCATION_CODES.has(refusal.code)) await this.waitForLateRotation();
      if (this.readSourceIdentity(accountId) !== seedIdentity) {
        // The verdict is on a token the source no longer holds; the new one gets a tick of its own.
        state.failureCount = 0;
        this.scheduleBackoff(accountId, RETRY_NOW_MS);
        return {
          outcome: "noop",
          accountId,
          beforeFreshness: before,
          afterFreshness: this.readSourceFreshness(accountId),
          reason: "the source's token changed while the refresh ran",
        };
      }
      // A session can spend the grant between the first harvest and the refresh.
      const late = this.harvestSessionRotations(accountId);
      if (late) return this.handleSuccess(accountId, late.before, late.after, "harvested_session");
      state.rejectedIdentity = seedIdentity;
      state.rejectedCode = refusal.code;
      return this.handleRevoked(accountId, before, after, refusal.code);
    }

    // A forced refresh that got no answer leaves a token with time left on its expiry schedule.
    return this.handleFailure(accountId, before, after, log, refusal.kind === "rate_limited", force && !nearExpiry);
  }

  private handleSuccess(
    accountId: string,
    before: number | null,
    after: number,
    outcome: "rotated" | "harvested_session",
  ): CodexRefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    state.rejectedIdentity = null;
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
      this.emit("account_reauthenticated", accountId);
    }
    this.scheduleAccount(accountId);
    return {
      outcome,
      accountId,
      beforeFreshness: before,
      afterFreshness: after,
    };
  }

  private handleRevoked(
    accountId: string,
    before: number | null,
    after: number | null,
    code: string,
  ): CodexRefreshResult {
    console.log(`[codex-oauth-refresh] account=${accountId} revoked (${code}) — emitting auth_required`);
    this.emitUnauthenticated(accountId, "revoked");
    return {
      outcome: "revoked",
      accountId,
      beforeFreshness: before,
      afterFreshness: after,
      reason: code,
    };
  }

  private handleFailure(
    accountId: string,
    before: number,
    after: number | null,
    log: string,
    rateLimited: boolean,
    keepExpirySchedule: boolean,
  ): CodexRefreshResult {
    const state = this.ensureAccountState(accountId);
    const outcome = rateLimited ? "rate_limited" : "unknown_failure";
    const reason = summarizeRefreshFailure(log);
    if (keepExpirySchedule) {
      console.log(
        `[codex-oauth-refresh] account=${accountId} ${outcome} on a forced refresh — expiry schedule kept reason="${reason}"`,
      );
      this.scheduleAccount(accountId);
    } else {
      state.failureCount += 1;
      console.log(
        `[codex-oauth-refresh] account=${accountId} ${outcome} failure_count=${state.failureCount} — `
          + `${rateLimited ? "backoff scheduled" : "short backoff"} reason="${reason}"`,
      );
      this.scheduleBackoff(accountId, rateLimited ? RATE_LIMIT_BACKOFF_MS : GENERIC_BACKOFF_MS);
    }
    return {
      outcome,
      accountId,
      beforeFreshness: before,
      afterFreshness: after,
      reason,
    };
  }

  private emitUnauthenticated(accountId: string, reason: "revoked" | "missing_credentials"): void {
    const state = this.ensureAccountState(accountId);
    if (state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("codex_account_unauthenticated", { accountId });
    this.deps.sseBroadcast("agent_auth_failed", { loginId: "openai-chatgpt", accountId, reason });
  }

  private handleHealthySource(accountId: string): void {
    const state = this.ensureAccountState(accountId);
    if (!state.emittedUnauthenticated) return;
    state.emittedUnauthenticated = false;
    try {
      this.deps.repushAccountToken("codex", accountId);
    } catch (err) {
      console.error(`[codex-oauth-refresh] account=${accountId} recovery repush failed:`, err);
    }
    this.deps.sseBroadcast("codex_account_authenticated", { accountId });
    this.emit("account_reauthenticated", accountId);
  }

  // Resolves with the CLI's log when the CLI has ended: it writes the file before it answers.
  private refreshOnDemand(accountRoot: string): Promise<string> {
    return new Promise<string>((resolve) => {
      // CODEX_HOME is explicit, so that an inherited one cannot point the CLI at another account.
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: accountRoot,
        CODEX_HOME: path.join(accountRoot, ".codex"),
      };
      delete env.CODEX_API_KEY;
      // Not the orchestrator's directory: the CLI reads project settings from where it runs.
      const opts: SpawnOptions = { cwd: accountRoot, env, stdio: ["pipe", "pipe", "pipe"] };
      let child: ChildProcess;
      try {
        child = this.deps.spawn("codex", [...CODEX_REFRESH_COMMAND], opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        resolve(`[spawn-failed] ${msg}`);
        return;
      }

      let stderr = "";
      let pending = "";
      let rpcError = "";
      let replied = false;
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const settle = (extra: string): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(`${stripLogDecoration(stderr)}\n${rpcError}\n${extra}`.trim());
      };
      const arm = (ms: number, onFire: () => void): void => {
        // An answer that arrives after the call gave up must not start a kill.
        if (settled) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(onFire, ms);
        if (typeof timer.unref === "function") timer.unref();
      };
      // Settle on the close, not on the signal: a write under way must land before the source is read.
      const kill = (note: string): void => {
        arm(EXIT_GRACE_MS, () => settle(note));
        killProcessTree(child, "SIGKILL", { label: "codex-refresh" });
      };
      const send = (message: unknown): void => {
        try {
          child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch { /* the exit settles a broken pipe */ }
      };
      const onMessage = (line: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null) return;
        const message = parsed as { id?: unknown; method?: unknown; error?: { code?: unknown } };
        // A request from the server has an id of its own numbering.
        if (typeof message.method === "string") return;
        if (message.id === INITIALIZE_ID) {
          send(CODEX_REFRESH_MESSAGES.initialized);
          send(CODEX_REFRESH_MESSAGES.refresh);
          return;
        }
        if (message.id !== REFRESH_ID || replied) return;
        replied = true;
        if (message.error) {
          // Not the error's text: the CLI writes it, and it can name the account.
          const code = typeof message.error.code === "number" ? String(message.error.code) : "unknown";
          rpcError = `[rpc-error] account/read failed with code ${code}`;
        }
        // The CLI ends when its input ends.
        try {
          child.stdin?.end();
        } catch { /* already closed */ }
        arm(EXIT_GRACE_MS, () => kill(""));
      };

      // A CLI that ends early leaves a broken pipe; the close reports it.
      child.stdin?.on("error", () => {});
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
      // The answers carry the account's email: only their ids are read, and none of them is kept.
      child.stdout?.on("data", (d: Buffer) => {
        pending += d.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          onMessage(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
      });
      // On the close, not on the exit: the line that names a refusal can arrive after the exit.
      child.on("close", () => settle(timedOut ? TIMED_OUT : replied ? "" : NO_REPLY));
      child.on("error", (err: NodeJS.ErrnoException) => {
        // A kill that fails is an error and not an exit: the CLI can still write.
        if (timedOut) return;
        // Not the message for a missing binary: the reason's summary drops a line that says ENOENT.
        settle(err.code === "ENOENT" ? "[error] the codex binary was not found" : `[error] ${err.message}`);
      });

      arm(REFRESH_TIMEOUT_MS, () => {
        timedOut = true;
        kill(TIMED_OUT);
      });
      send(CODEX_REFRESH_MESSAGES.initialize);
    });
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
      .filter((sessionId) => readSessionAccountMarker(credentialsDir, sessionId).codex === accountId)
      .filter((sessionId) => this.tokenFileIsOwnedBySubtree(sessionId));
    if (candidates.length === 0) return null;

    const before = this.readSourceFreshness(accountId);
    let best = before;
    let adoptedFrom: string | null = null;
    for (const sessionId of candidates) {
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, "codex", accountId)) continue;
      try {
        syncProviderAccountTokenBack(credentialsDir, sessionId, "codex", accountId, { sessionOwnRoute: true });
      } catch (err) {
        console.warn(`[codex-oauth-refresh] account=${accountId} harvest from session ${sessionId} failed:`, err);
        continue;
      }
      const after = this.readSourceFreshness(accountId);
      if (after === NO_FRESHNESS) continue;
      if (best !== NO_FRESHNESS && after <= best) continue;
      best = after;
      adoptedFrom = sessionId;
    }
    if (adoptedFrom === null || best === NO_FRESHNESS) return null;
    console.log(
      `[codex-oauth-refresh] account=${accountId} harvested a session-side rotation from ${adoptedFrom}`
        + ` was=${before === NO_FRESHNESS ? "none" : new Date(before).toISOString()}`
        + ` now=${new Date(best).toISOString()}`,
    );
    return { before, after: best };
  }

  // Resolve parent symlinks too: .codex can point into another account's root.
  private tokenFileIsOwnedBySubtree(sessionId: string): boolean {
    const sessionDir = perSessionCredentialsDir(this.deps.credentialsDir, sessionId);
    try {
      const resolvedFile = fs.realpathSync(path.join(sessionDir, CODEX_AUTH_RELATIVE));
      const resolvedDir = fs.realpathSync(sessionDir);
      return resolvedFile.startsWith(resolvedDir + path.sep);
    } catch {
      return false;
    }
  }

  private sourceFileFor(accountId: string): string {
    const accountRoot = this.deps.providerAccountManager.resolveCredentialRoot("codex", accountId);
    return path.join(accountRoot, CODEX_AUTH_RELATIVE);
  }

  private readSourceFreshness(accountId: string): number | null {
    return readCodexTokenFreshness(this.sourceFileFor(accountId));
  }

  private sourceIsReadable(accountId: string): boolean {
    try {
      JSON.parse(fs.readFileSync(this.sourceFileFor(accountId), "utf8"));
      return true;
    } catch {
      return false;
    }
  }

  private readSourceIdentity(accountId: string): string | null {
    try {
      return codexCredentialIdentity(JSON.parse(fs.readFileSync(this.sourceFileFor(accountId), "utf8")));
    } catch {
      return null;
    }
  }

  private sourceGrantIsKnownRejected(accountId: string): boolean {
    const rejected = this.ensureAccountState(accountId).rejectedIdentity;
    return rejected !== null && this.readSourceIdentity(accountId) === rejected;
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
        rejectedIdentity: null,
        rejectedCode: "",
        retryNotBefore: 0,
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
