import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { killProcessTree } from "../../../shared/kill-child.js";
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

// The CLI refreshes a credential only when its file says this little is left (docs/153).
export const CLI_REFRESH_WINDOW_MS = 5 * 60 * 1000;

// What a probe's private copy claims is left, so that the CLI refreshes it now.
export const PROBE_REMAINING_MS = 60_000;

// scripts/probe-claude-refresh.mjs runs these against the real binary.
export const REFRESH_PROBE_COMMANDS = {
  tier1: ["auth", "status", "--json"],
  tier2: ["--print", "ok", "--model", "claude-haiku-4-5-20251001", "--tools", "", "--no-session-persistence"],
} as const;

// Before the subcommand: `claude auth status` rejects --debug as an unknown option.
export function withDebugCapture(args: readonly string[], debugFile: string): string[] {
  return ["--debug", "api", "--debug-file", debugFile, ...args];
}

const STARTUP_OVERDUE_DELAY_MS = 1_000;

const RETRY_NOW_MS: readonly number[] = [STARTUP_OVERDUE_DELAY_MS];

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
const KILL_SETTLE_MS = 5_000;

// A session's CLI reads its file again about 0.5 s after a 401, so the install must not wait
// for the probe to exit (docs/153).
export const PROBE_COPY_POLL_MS = 50;

// Session naming's CLI times out after 15 s. Past this a tick stops waiting for a run, but does not probe.
const PRIVATE_RUN_WAIT_MS = 30_000;

// A session's CLI that won the grant writes its rotation moments after the loser is rejected;
// the late harvest looks this much later, so that a race does not read as a revocation.
const LATE_ROTATION_WAIT_MS = 5_000;

const TIMED_OUT = "[timeout] claude CLI did not exit in time";
const INSTALL_FAILED = "[install-failed] the rotated credential is kept for the next tick";

// A tick that starts this long before expiry ends before the session CLIs refresh by themselves:
// both tier timeouts, their kill grace and the late-rotation wait come to 105 s.
const LAST_CHANCE_BEFORE_EXPIRY_MS = CLI_REFRESH_WINDOW_MS + 2 * 60_000;

const CLAUDE_CREDENTIALS_RELATIVE = path.join(".claude", ".credentials.json");

// A generic 401 can mean an expired access token, not a revoked refresh grant.
const TERMINAL_AUTH_FAILURE_PATTERNS = [
  "invalid_grant",
  "invalid_refresh_token",
  "invalid refresh token",
];

const NO_EXPIRY = null;

// Capped per line, so that one long line cannot hide the others: at most 294 characters.
const REASON_MAX_LINES = 3;
const REASON_LINE_MAX_CHARS = 96;

const FAILURE_SIGNAL_PATTERN =
  /(error|invalid|denied|forbidden|unauthor|rate[ _-]?limit|429|401|403|timeout|refus|fail|expired)/i;

// The CLI logs each optional file it does not find; none of them explains a refresh.
const MISSING_FILE_NOISE_PATTERN = /\bENOENT\b/;
// A refresher's own note ("[error] spawn claude ENOENT") is not that noise. The CLI's level tags are upper case.
const REFRESHER_NOTE_PATTERN = /^\[[a-z]+(?:-[a-z]+)*\] /;
const DEBUG_LEVEL_TAG = "[DEBUG]";
const LOG_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+/gm;

const CREDENTIAL_HEADER_PATTERN =
  /^([ \t>|-]*)(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token|anthropic-api-key)(\s*[:=]\s*).*$/gim;

// The CLI knows the account's address. After the token shapes, which can take a part of one:
// "[redacted]@example.com" must not keep its host. Bounded: an open local part is quadratic on a long line.
const EMAIL_PATTERN =
  /(?:\[redacted\]|[\w.+-]){1,64}@(?:\[redacted\]|[\w-]){1,63}(?:\.(?:\[redacted\]|[\w-]){1,63})+/g;

// Short, unprefixed secrets in unknown fields can escape this filter.
function redactSecrets(text: string): string {
  return text
    .replace(CREDENTIAL_HEADER_PATTERN, "$1$2$3[redacted]")
    .replace(/("[A-Za-z_]*(?:token|secret|key|password|passwd|auth)[A-Za-z_]*"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\b(bearer|basic)(\s+)\S+/gi, "$1$2[redacted]")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\b[A-Za-z0-9_\-+/]{24,}={0,2}/g, "[redacted]")
    .replace(EMAIL_PATTERN, "[email]");
}

// Which credential a file holds. A hash, so that no token stays in memory; null without a token.
function claudeCredentialIdentity(parsed: unknown): string | null {
  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)?.claudeAiOauth;
  const access = typeof oauth?.accessToken === "string" ? oauth.accessToken : "";
  const refresh = typeof oauth?.refreshToken === "string" ? oauth.refreshToken : "";
  if (!access && !refresh) return null;
  return createHash("sha256").update(`${access}\n${refresh}`).digest("hex");
}

export function summarizeRefreshFailure(combinedOutput: string): string {
  const lines = redactSecrets(combinedOutput)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && (REFRESHER_NOTE_PATTERN.test(line) || !MISSING_FILE_NOISE_PATTERN.test(line)));
  const signal = lines.filter((line) => FAILURE_SIGNAL_PATTERN.test(line));
  const loud = signal.filter((line) => !line.includes(DEBUG_LEVEL_TAG));
  const picked = loud.length > 0 ? loud : signal.length > 0 ? signal : lines;
  const joined = picked
    .slice(-REASON_MAX_LINES)
    .map((line) => line.replace(/\s+/g, " "))
    .map((line) => (line.length > REASON_LINE_MAX_CHARS ? `${line.slice(0, REASON_LINE_MAX_CHARS - 1)}…` : line))
    .join(" | ");
  return joined || "no CLI output";
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

interface ProbeHome {
  home: string;
  credentialsFile: string;
  // The credential whose grant the copy's CLI spends: the seed, and after an install the installed one.
  seedIdentity: string;
  // The copy's credential was installed into the source. Kept, such a copy can hold no successor.
  installed: boolean;
  // The copy holds a rotation that is not in the source: the only record of a live grant.
  outstanding: boolean;
}

// What started a tick. A caller that joins a tick in flight is reported under the first one's.
type TickTrigger = "scheduled" | "backoff_retry" | "turn_start" | "forced_heal" | "nudge";

interface CliRun {
  output: string;
  // False for a CLI that did not start, and for one that did not end before its timeout.
  completed: boolean;
  durationMs: number;
  timedOut: boolean;
  // The exit code or signal. Null when the CLI did not start, or did not exit within the kill grace.
  exit: string | null;
}

function describeTierRun(run: CliRun | null): string {
  if (run === null) return "not_run";
  const parts = [`${(run.durationMs / 1000).toFixed(1)}s`];
  if (run.timedOut) parts.push("timeout");
  parts.push(run.exit === null ? "no_exit" : `exit=${run.exit}`);
  return parts.join(",");
}

// "rejected": the CLI blanks a credential only when the OAuth server answers invalid_grant.
// "superseded": the copy rotated, but the source holds another token by now.
type ProbeResult = "installed" | "rejected" | "unchanged" | "superseded" | "install_failed";

export type RefreshOutcome =
  | "rotated_tier1"
  | "rotated_tier2"
  | "rotated_kept"
  | "rotated_private_run"
  | "harvested_session"
  | "noop"
  | "rate_limited"
  | "revoked"
  | "not_rotated"
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
  // The source is never blanked, so this is the record that its grant is dead.
  rejectedIdentity: string | null;
  pendingRotation: ProbeHome | null;
  // Until then a turn start leaves the retry to the schedule's backoff.
  retryNotBefore: number;
  // Each resolves when its run's copy is settled. A tick waits for them: both can spend one grant.
  privateRuns: Set<Promise<void>>;
  // Runs whose CLI has not ended. A run that is only settling cannot hold a grant's successor.
  openRuns: number;
  // A run's rejected grant, judged when no other run that can hold its successor is open.
  unjudgedRejection: string | null;
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
  lateRotationWaitMs?: number;
}

export class ClaudeOAuthRefresher extends EventEmitter<ClaudeOAuthRefresherEvents> {
  private readonly deps: Required<ClaudeOAuthRefresherDeps>;
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
      lateRotationWaitMs: deps.lateRotationWaitMs ?? LATE_ROTATION_WAIT_MS,
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
      return [await this.runTickForAccount(accountId, "nudge")];
    }
    const accounts = this.deps.providerAccountManager.list("anthropic");
    return Promise.all(accounts.map((a) => this.runTickForAccount(a.id, "nudge")));
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
    // Before the last chance the schedule owns the retries; a turn start would only add to them.
    const turnStartMarginMs = Math.min(this.deps.safetyMarginMs, LAST_CHANCE_BEFORE_EXPIRY_MS);
    if (!force && before - now > turnStartMarginMs && !this.sourceGrantIsKnownRejected(accountId)) return true;
    // A turn start in the backoff would spend it: each one is a probe, and under a 429 a request more.
    if (!force && now < this.ensureAccountState(accountId).retryNotBefore) return before > now;
    let outcome: RefreshOutcome | null = null;
    try {
      outcome = (await this.runTickForAccount(accountId, force ? "forced_heal" : "turn_start", force)).outcome;
    } catch (err) {
      console.error(`[claude-oauth-refresh] ensureFresh tick for ${accountId} threw:`, err);
    }
    const after = this.readSourceExpiresAt(accountId);
    if (after === NO_EXPIRY) return false;
    if (outcome === "revoked" || outcome === "missing_credentials") {
      if (force) {
        console.log(
          `[claude-oauth-refresh] account=${accountId} forced heal probe reported ${outcome} — not healed`,
        );
      }
      return false;
    }
    return after > this.deps.now();
  }

  // For a model call outside the refresher (session naming): the copy keeps the real expiry, and
  // what the CLI does to it is judged as a probe's result is, so that the source is never written
  // by the CLI and a grant the CLI spent is not lost (docs/153).
  async runInPrivateCopy<T>(accountId: string, run: (home: string) => Promise<T>): Promise<T> {
    const state = this.ensureAccountState(accountId);
    while (state.inFlight) await state.inFlight.catch(() => undefined);
    let copy: ProbeHome;
    try {
      copy = this.createProbeHome(this.sourceFileFor(accountId), null);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unreadable source";
      // eslint-disable-next-line preserve-caught-error -- a JSON parse error quotes the credential file.
      throw new Error(`The Claude account's credentials could not be copied (${code}).`);
    }
    let release = (): void => {};
    const settled = new Promise<void>((resolve) => { release = resolve; });
    state.privateRuns.add(settled);
    state.openRuns += 1;
    try {
      return await run(copy.home);
    } finally {
      state.openRuns -= 1;
      await this.settlePrivateRun(accountId, copy, state.openRuns > 0);
      state.privateRuns.delete(settled);
      release();
    }
  }

  // Never rejects: it runs in the caller's finally.
  private async settlePrivateRun(accountId: string, copy: ProbeHome, othersOpen: boolean): Promise<void> {
    const state = this.ensureAccountState(accountId);
    try {
      // A copy kept after its install can hold no successor, which the checks below take a kept copy to hold.
      if (state.pendingRotation?.installed) {
        try {
          this.retryKeptRotation(accountId, this.readSourceExpiresAt(accountId));
        } catch (err) {
          // This run's copy is still to be judged: it can hold the only successor.
          console.error(`[claude-oauth-refresh] account=${accountId} judging the kept rotation failed:`, err);
        }
      }
      const before = this.readSourceExpiresAt(accountId);
      const result = this.adoptProbeRotation(accountId, copy);
      const after = this.readSourceExpiresAt(accountId);
      if (result === "installed" && after !== NO_EXPIRY) {
        this.handleSuccess(accountId, before, after, "rotated_private_run");
      } else if (copy.outstanding) {
        const kept = state.pendingRotation;
        const keptFor = kept ? this.readSourceFor(kept, this.sourceFileFor(accountId)).state : null;
        // A copy kept after its install that still holds that credential (its seed) is superseded by this
        // run's rotation of it. A kept copy that holds a later rotation, or cannot be read, is not.
        const supersedesKept = kept?.installed === true
          && this.readIdentityAt(kept.credentialsFile) === kept.seedIdentity
          && kept.seedIdentity === copy.seedIdentity
          && this.holdsRotation(copy);
        // Otherwise only where a tick would give the kept rotation up: the source is gone or holds another credential.
        if (kept && !supersedesKept && keptFor !== "replaced" && keptFor !== "gone") {
          console.error(`[claude-oauth-refresh] account=${accountId} a rotation is kept already; this copy is left at ${copy.home}`);
        } else {
          if (kept) this.removeProbeHome(kept);
          state.pendingRotation = copy;
          this.scheduleBackoff(accountId, RETRY_NOW_MS);
        }
      } else if (result === "rejected" && this.readSourceIdentity(accountId) === copy.seedIdentity) {
        state.unjudgedRejection = copy.seedIdentity;
      }
      const rejected = othersOpen ? null : state.unjudgedRejection;
      if (rejected === null) return;
      state.unjudgedRejection = null;
      if (!this.rejectionStillApplies(accountId, rejected)) return;
      await this.waitForLateRotation();
      if (!this.rejectionStillApplies(accountId, rejected)) return;
      const late = this.harvestSessionRotations(accountId);
      if (late) {
        this.handleSuccess(accountId, late.before, late.after, "harvested_session");
        return;
      }
      state.rejectedIdentity = rejected;
      this.handleRevoked(
        accountId, before, before, "invalid_grant",
        `trigger=private_run verdict=blanked_copy expires_in=${this.describeExpiresIn(before)}`,
      );
    } catch (err) {
      console.error(`[claude-oauth-refresh] account=${accountId} settling a private run failed:`, err);
    } finally {
      if (!copy.outstanding) this.removeProbeHome(copy);
    }
  }

  // Judges the kept rotation again; it stays kept while it is outstanding.
  private retryKeptRotation(accountId: string, before: number | null): {
    kept: boolean;
    rejected: boolean;
    success: RefreshResult | null;
  } {
    const state = this.ensureAccountState(accountId);
    const pending = state.pendingRotation;
    if (!pending) return { kept: false, rejected: false, success: null };
    const retried = this.adoptProbeRotation(accountId, pending);
    if (pending.outstanding) return { kept: true, rejected: false, success: null };
    state.pendingRotation = null;
    this.removeProbeHome(pending);
    // A kept copy that reads as blanked is a rejected grant, as after a probe.
    const rejected = retried === "rejected";
    if (rejected) state.rejectedIdentity = pending.seedIdentity;
    const installedAt = this.readSourceExpiresAt(accountId);
    if (retried !== "installed" || installedAt === NO_EXPIRY) return { kept: false, rejected, success: null };
    return { kept: false, rejected, success: this.handleSuccess(accountId, before, installedAt, "rotated_kept") };
  }

  // A copy that cannot be read proves no rotation.
  private holdsRotation(copy: ProbeHome): boolean {
    const identity = this.readIdentityAt(copy.credentialsFile);
    return identity !== null && identity !== copy.seedIdentity;
  }

  // Only for the credential the source still holds, and only if no kept rotation holds its successor.
  private rejectionStillApplies(accountId: string, rejected: string): boolean {
    const kept = this.ensureAccountState(accountId).pendingRotation;
    return kept?.seedIdentity !== rejected && this.readSourceIdentity(accountId) === rejected;
  }

  // False when a run is still open at the cap.
  private async waitForPrivateRuns(state: AccountState): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let capped = false;
    const cap = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        capped = true;
        resolve();
      }, PRIVATE_RUN_WAIT_MS);
      if (typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([Promise.all(state.privateRuns), cap]);
    clearTimeout(timer);
    return !capped;
  }

  private async waitForLateRotation(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.deps.lateRotationWaitMs);
      if (typeof timer.unref === "function") timer.unref();
    });
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
    state.retryNotBefore = 0;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId, "scheduled").catch((err: unknown) => {
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
    const delay = this.clampToLastChance(accountId, schedule[idx]);
    state.retryNotBefore = this.deps.now() + delay;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.runTickForAccount(accountId, "backoff_retry").catch((err: unknown) => {
        console.error(`[claude-oauth-refresh] unexpected error in backoff tick for ${accountId}:`, err);
      });
    }, delay);
    if (typeof state.timer.unref === "function") state.timer.unref();
  }

  private clampToLastChance(accountId: string, delay: number): number {
    const expiresAt = this.readSourceExpiresAt(accountId);
    if (expiresAt === NO_EXPIRY) return delay;
    const untilLastChance = expiresAt - LAST_CHANCE_BEFORE_EXPIRY_MS - this.deps.now();
    if (untilLastChance <= 0) return delay;
    return Math.max(STARTUP_OVERDUE_DELAY_MS, Math.min(delay, untilLastChance));
  }

  private runTickForAccount(accountId: string, trigger: TickTrigger, force = false): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    if (state.inFlight) return state.inFlight;
    const promise = this.executeTick(accountId, trigger, force).finally(() => {
      state.inFlight = null;
    });
    state.inFlight = promise;
    return promise;
  }

  private async executeTick(accountId: string, trigger: TickTrigger, force: boolean): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    const sourceFile = this.sourceFileFor(accountId);

    const runStillOpen = state.privateRuns.size > 0 && !(await this.waitForPrivateRuns(state));

    // Harvest first: a resident CLI can spend the source's single-use refresh grant.
    // This skips forced probing, so a grant revoked since the session's refresh can pass.
    const harvest = this.harvestSessionRotations(accountId);
    if (harvest) {
      return this.handleSuccess(accountId, harvest.before, harvest.after, "harvested_session");
    }

    const before = this.readSourceExpiresAt(accountId);

    // Before the missing-source check: an unreadable source must not end the account while a
    // rotation waits for it.
    const retry = this.retryKeptRotation(accountId, before);
    // The source's grant is spent: another probe would only be rejected.
    if (retry.kept) return this.handleFailure(accountId, before, before, INSTALL_FAILED);
    if (retry.success) return retry.success;
    const keptCopyRejected = retry.rejected;

    if (before === NO_EXPIRY) {
      const unusable = this.describeUnusableSource(sourceFile);
      const result: RefreshResult = {
        outcome: "missing_credentials",
        accountId,
        beforeExpiresAt: null,
        afterExpiresAt: null,
        reason: unusable.detail,
      };
      // A sign-in removes the source at its start, and reports its own outcome.
      const signingIn = this.accountStatus(accountId) === "authenticating";
      console.log(
        `[claude-oauth-refresh] account=${accountId} missing_credentials — waiting for auth_complete`
          + ` source=${unusable.kind} detail=${unusable.detail}${signingIn ? " sign_in=in_progress" : ""}`,
      );
      if (!signingIn) this.emitUnauthenticated(accountId, "missing_credentials");
      return result;
    }

    if (this.sourceGrantIsKnownRejected(accountId)) {
      // Short on purpose: this repeats on each later tick, and the first line has the detail.
      const detail = keptCopyRejected
        ? `verdict=blanked_copy rejected_by=kept_copy expires_in=${this.describeExpiresIn(before)}`
        : "verdict=known_rejected";
      return this.handleRevoked(accountId, before, before, "invalid_grant", `trigger=${trigger} ${detail}`);
    }

    const now = this.deps.now();
    const isNearExpiry = before <= now + this.deps.safetyMarginMs;
    // A session's 401 needs a probe even when the source has time left.
    if (!force && !isNearExpiry) {
      state.failureCount = 0;
      this.handleHealthySource(accountId);
      this.scheduleAccount(accountId);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: before,
      };
    }

    // That run can hold the grant's successor, so a probe could only spend or misjudge the grant.
    if (runStillOpen) {
      return this.handleFailure(accountId, before, before, "[private-run-open] session naming has not finished");
    }

    const claimedExpiresAt = isNearExpiry ? Math.min(before, now + PROBE_REMAINING_MS) : null;
    // Tier 1 sends the refresh grant and exits before the token host can answer, so that tier 2
    // would present a grant that is spent already (docs/153). It gets only a copy that the CLI
    // will not refresh for as long as tier 1 can run.
    const runTier1 = (claimedExpiresAt ?? before) - now > CLI_REFRESH_WINDOW_MS + TIER1_TIMEOUT_MS;
    let probe: ProbeHome;
    try {
      probe = this.createProbeHome(sourceFile, claimedExpiresAt);
    } catch (err) {
      // No error text: a JSON parse error quotes the credential file.
      const code = (err as NodeJS.ErrnoException).code ?? "unreadable source";
      return this.handleFailure(accountId, before, before, `[probe-home-failed] ${code}`);
    }
    try {
      return await this.runProbes(accountId, probe, before, trigger, force, isNearExpiry, runTier1);
    } finally {
      // Decided here, so that no path out of the probes, a throw included, deletes a rotation.
      if (probe.outstanding) state.pendingRotation = probe;
      else this.removeProbeHome(probe);
    }
  }

  private async runProbes(
    accountId: string,
    probe: ProbeHome,
    before: number,
    trigger: TickTrigger,
    force: boolean,
    isNearExpiry: boolean,
    runTier1: boolean,
  ): Promise<RefreshResult> {
    const state = this.ensureAccountState(accountId);
    let tier1: CliRun | null = null;
    let probeResult: ProbeResult = "unchanged";
    let after: number | null = before;
    if (runTier1) {
      tier1 = await this.spawnCli(probe, "tier1", TIER1_TIMEOUT_MS);
      probeResult = this.adoptProbeRotation(accountId, probe);
      after = this.readSourceExpiresAt(accountId);
      if (after !== NO_EXPIRY && (probeResult === "installed" || after > before)) {
        return this.handleSuccess(accountId, before, after, "rotated_tier1");
      }
    }

    let tier2: CliRun | null = null;
    if (probeResult === "unchanged") {
      const detail = ` tier1=${describeTierRun(tier1)}`;
      // Installed while the CLI still runs: from the refresh on, the sessions' token can be dead (docs/153).
      const early: { installedAt: number | null; result: RefreshResult | null } = { installedAt: null, result: null };
      // A billable API call.
      tier2 = await this.spawnCli(probe, "tier2", TIER2_TIMEOUT_MS, () => {
        if (this.adoptProbeRotation(accountId, probe) !== "installed") return;
        const installedAt = this.readSourceExpiresAt(accountId);
        if (installedAt === NO_EXPIRY) return;
        // Before the success path, whose listeners can throw.
        early.installedAt = installedAt;
        // A throw below must not leave the result of an earlier install standing for this one.
        early.result = null;
        early.result = this.handleSuccess(accountId, before, installedAt, "rotated_tier2", detail);
      });
      probeResult = this.adoptProbeRotation(accountId, probe);
      after = this.readSourceExpiresAt(accountId);
      // Before any success: a rotation that is not installed is the only record of a live grant.
      if (probe.outstanding) return this.handleFailure(accountId, before, after, INSTALL_FAILED);
      if (after !== NO_EXPIRY && probeResult === "installed") {
        return this.handleSuccess(accountId, before, after, "rotated_tier2", detail);
      }
      // The source still holds what was installed while the CLI ran.
      if (early.installedAt !== null && probeResult === "unchanged" && after !== NO_EXPIRY) {
        if (!early.result) return this.handleSuccess(accountId, before, after, "rotated_tier2", detail);
        // A scheduled tick that fired during the run joined this one, and is spent.
        this.scheduleAccount(accountId);
        return early.result;
      }
      if (after !== NO_EXPIRY && after > (early.installedAt ?? before)) {
        return this.handleSuccess(accountId, before, after, "rotated_tier2", detail);
      }
    }

    if (probe.outstanding) return this.handleFailure(accountId, before, after, INSTALL_FAILED);
    const combinedOutput = `${tier1?.output ?? ""}\n${tier2?.output ?? ""}`;
    const blanked = probeResult === "rejected";
    const grantRejected = blanked || this.outputIndicatesRevoked(combinedOutput);
    // Before the source check: a session's rotation can reach the source during the wait.
    if (grantRejected) await this.waitForLateRotation();
    if (this.readSourceIdentity(accountId) !== probe.seedIdentity) {
      // The verdict is on a token the source no longer holds; the new one gets a tick of its own.
      state.failureCount = 0;
      this.scheduleBackoff(accountId, RETRY_NOW_MS);
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason: "the source's token changed while the probe ran",
      };
    }

    let rejection: string | undefined;
    if (grantRejected) {
      // A session can spend the grant between the first harvest and the probe.
      const late = this.harvestSessionRotations(accountId);
      if (late) return this.handleSuccess(accountId, late.before, late.after, "harvested_session");
      state.rejectedIdentity = probe.seedIdentity;
      const namedBy = [tier1, tier2]
        .map((run, index) => (run && this.outputIndicatesRevoked(run.output) ? `tier${index + 1}` : null))
        .filter((tier) => tier !== null)
        .join("+");
      const verdict = blanked
        ? `verdict=blanked_copy rejected_by=${tier2 ? "tier2" : "tier1"}`
        : `verdict=output_phrase rejected_by=${namedBy}`;
      rejection = `trigger=${trigger} ${verdict} tier1=${describeTierRun(tier1)} tier2=${describeTierRun(tier2)}`;
    }
    // No rotation before expiry is not a scheduling failure; retain the expiry schedule.
    if (force && !isNearExpiry && !grantRejected) {
      state.failureCount = 0;
      this.scheduleAccount(accountId);
      let reason = "forced validity probe found a live token that needed no rotation";
      // Tier 1 sends no request for a token that is not near expiry: only tier 2 tests it.
      if (!tier2?.completed) {
        reason = summarizeRefreshFailure(combinedOutput);
        console.log(
          `[claude-oauth-refresh] account=${accountId} forced probe did not complete — no verdict on the token`
            + ` reason="${reason}"`,
        );
      }
      return {
        outcome: "noop",
        accountId,
        beforeExpiresAt: before,
        afterExpiresAt: after,
        reason,
      };
    }
    return this.handleFailure(accountId, before, after, combinedOutput, rejection);
  }

  private outputIndicatesRevoked(combinedOutput: string): boolean {
    const lc = combinedOutput.toLowerCase();
    return TERMINAL_AUTH_FAILURE_PATTERNS.some((phrase) => lc.includes(phrase));
  }

  private handleSuccess(
    accountId: string,
    before: number | null,
    after: number,
    outcome: "rotated_tier1" | "rotated_tier2" | "rotated_kept" | "rotated_private_run" | "harvested_session",
    detail = "",
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount = 0;
    state.rejectedIdentity = null;
    const wasUnauthenticated = state.emittedUnauthenticated;
    state.emittedUnauthenticated = false;
    console.log(
      `[claude-oauth-refresh] account=${accountId} ${outcome} new_expires_at=${new Date(after).toISOString()}${detail}`,
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

  // The sentence up to "auth_required" is what incidents are searched by; the detail follows it.
  private handleRevoked(
    accountId: string,
    before: number | null,
    after: number | null,
    reason: string,
    detail: string,
  ): RefreshResult {
    console.log(`[claude-oauth-refresh] account=${accountId} revoked (${reason}) — emitting auth_required ${detail}`);
    this.emitUnauthenticated(accountId, "revoked");
    return {
      outcome: "revoked",
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
      reason,
    };
  }

  private handleFailure(
    accountId: string,
    before: number | null,
    after: number | null,
    combinedOutput: string,
    // How the probes found the grant rejected; absent for every other failure.
    rejection?: string,
  ): RefreshResult {
    const state = this.ensureAccountState(accountId);
    state.failureCount += 1;
    const lc = combinedOutput.toLowerCase();
    const reason = summarizeRefreshFailure(combinedOutput);
    const isRateLimited =
      lc.includes("429") || lc.includes("rate_limit") || lc.includes("rate limited");

    if (rejection !== undefined) {
      return this.handleRevoked(
        accountId, before, after, this.authFailureReason(lc),
        `${rejection} expires_in=${this.describeExpiresIn(before)} reason="${reason}"`,
      );
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

    const stillValid = before !== null && before > this.deps.now();
    console.log(
      stillValid
        ? `[claude-oauth-refresh] account=${accountId} not_rotated failure_count=${state.failureCount}`
          + ` expires_in=${this.describeExpiresIn(before)} — token still valid, retry scheduled reason="${reason}"`
        : `[claude-oauth-refresh] account=${accountId} unknown_failure failure_count=${state.failureCount} — short backoff`
          + ` reason="${reason}"`,
    );
    this.scheduleBackoff(accountId, GENERIC_BACKOFF_MS);
    return {
      outcome: stillValid ? "not_rotated" : "unknown_failure",
      accountId,
      beforeExpiresAt: before,
      afterExpiresAt: after,
      reason,
    };
  }

  private describeExpiresIn(expiresAt: number | null): string {
    return expiresAt === null ? "unknown" : `${Math.round((expiresAt - this.deps.now()) / 60_000)}m`;
  }

  private authFailureReason(lcOutput: string): string {
    return TERMINAL_AUTH_FAILURE_PATTERNS.find((phrase) => lcOutput.includes(phrase)) ?? "invalid_grant";
  }

  private emitUnauthenticated(accountId: string, reason: "revoked" | "missing_credentials"): void {
    const state = this.ensureAccountState(accountId);
    // A sign-in's completion sets the row ready by itself. If the credential is still dead, say so again.
    if (state.emittedUnauthenticated && this.accountStatus(accountId) !== "ready") return;
    state.emittedUnauthenticated = true;
    this.emit("account_unauthenticated", accountId);
    this.deps.sseBroadcast("claude_account_unauthenticated", { accountId });
    this.deps.sseBroadcast("agent_auth_failed", { loginId: "anthropic-oauth", accountId, reason });
  }

  private accountStatus(accountId: string): string | undefined {
    return this.deps.providerAccountManager.list("anthropic").find((account) => account.id === accountId)?.status;
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

  // A private copy: the CLI refreshes only what is near expiry, and blanks a rejected credential (docs/153).
  private createProbeHome(sourceFile: string, claimedExpiresAt: number | null): ProbeHome {
    const source = fs.readFileSync(sourceFile, "utf8");
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const seedIdentity = claudeCredentialIdentity(parsed);
    if (seedIdentity === null) throw new Error("the source holds no token");
    const oauth = (parsed.claudeAiOauth ?? {}) as Record<string, unknown>;
    const seeded = claimedExpiresAt === null
      ? source
      : JSON.stringify({ ...parsed, claudeAiOauth: { ...oauth, expiresAt: claimedExpiresAt } });
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "shipit-claude-refresh-"));
    try {
      const credentialsFile = path.join(home, CLAUDE_CREDENTIALS_RELATIVE);
      fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
      fs.writeFileSync(credentialsFile, seeded, { mode: 0o600 });
      return { home, credentialsFile, seedIdentity, installed: false, outstanding: false };
    } catch (err) {
      fs.rmSync(home, { recursive: true, force: true });
      throw err;
    }
  }

  private removeProbeHome(probe: ProbeHome): void {
    try {
      fs.rmSync(probe.home, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  // What the source holds, set against the credential the copy was made from. "unknown" is a
  // file that cannot be read or has no credential in a known shape: it proves nothing.
  private readSourceFor(probe: ProbeHome, sourceFile: string): {
    state: "same" | "blanked" | "replaced" | "gone" | "unknown";
    current: Record<string, unknown>;
  } {
    let current: Record<string, unknown>;
    try {
      current = JSON.parse(fs.readFileSync(sourceFile, "utf8")) as Record<string, unknown>;
    } catch (err) {
      return { state: (err as NodeJS.ErrnoException).code === "ENOENT" ? "gone" : "unknown", current: {} };
    }
    const identity = claudeCredentialIdentity(current);
    if (identity === probe.seedIdentity) return { state: "same", current };
    if (identity !== null) return { state: "replaced", current };
    return { state: isBlankedClaudeCredential(current) ? "blanked" : "unknown", current };
  }

  // Never throws. A rotation is given up only for a source that is gone (a sign-out) or that
  // holds another credential: in every other doubt it stays, because its grant is spent.
  private adoptProbeRotation(accountId: string, probe: ProbeHome): ProbeResult {
    let rotated: Record<string, unknown> | null = null;
    try {
      rotated = JSON.parse(fs.readFileSync(probe.credentialsFile, "utf8")) as Record<string, unknown>;
    } catch { /* the CLI writes this file only to rotate or to blank it, so it can hold a rotation */ }
    const rotatedIdentity = rotated === null ? null : claudeCredentialIdentity(rotated);
    // An installed copy is judged against the source again: another writer can have changed it.
    const installedCopy = probe.installed && rotatedIdentity !== null && rotatedIdentity === probe.seedIdentity;
    if (rotated !== null && !installedCopy && (rotatedIdentity === null || rotatedIdentity === probe.seedIdentity)) {
      probe.outstanding = false;
      return isBlankedClaudeCredential(rotated) ? "rejected" : "unchanged";
    }
    probe.outstanding = true;

    const sourceFile = this.sourceFileFor(accountId);
    const source = this.readSourceFor(probe, sourceFile);
    if (source.state === "gone" || source.state === "replaced") {
      console.log(
        `[claude-oauth-refresh] account=${accountId} the source was ${source.state} while the probe ran`
          + " — the probe's rotation is not installed",
      );
      probe.outstanding = false;
      return "superseded";
    }
    if (installedCopy && source.state === "same") {
      probe.outstanding = false;
      return "unchanged";
    }
    if (rotated === null || rotatedIdentity === null || source.state === "unknown") return "install_failed";
    if (source.state === "blanked") {
      // Another CLI in the account root lost the grant to this probe and blanked the file.
      console.log(`[claude-oauth-refresh] account=${accountId} the source was blanked while the probe ran — installing over it`);
    }
    const tmp = `${sourceFile}.tmp-${process.pid}-${Date.now()}`;
    try {
      // Other CLIs rewrite the source's other keys; only the token is the probe's to replace.
      fs.writeFileSync(tmp, JSON.stringify({ ...source.current, claudeAiOauth: rotated.claudeAiOauth }), { mode: 0o600 });
      fs.renameSync(tmp, sourceFile);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch { /* best-effort */ }
      console.error(`[claude-oauth-refresh] account=${accountId} failed to install the rotated credential:`, err);
      return "install_failed";
    }
    probe.outstanding = false;
    probe.installed = true;
    // The CLI can still write the copy: what it writes next is judged against what is installed.
    probe.seedIdentity = rotatedIdentity;
    return "installed";
  }

  private readSourceIdentity(accountId: string): string | null {
    return this.readIdentityAt(this.sourceFileFor(accountId));
  }

  private readIdentityAt(file: string): string | null {
    try {
      return claudeCredentialIdentity(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      return null;
    }
  }

  private sourceGrantIsKnownRejected(accountId: string): boolean {
    const rejected = this.ensureAccountState(accountId).rejectedIdentity;
    return rejected !== null && this.readSourceIdentity(accountId) === rejected;
  }

  // `onCopyChange` runs, while the CLI runs, each time the copy's bytes change.
  private spawnCli(
    probe: ProbeHome,
    label: "tier1" | "tier2",
    timeoutMs: number,
    onCopyChange?: () => void,
  ): Promise<CliRun> {
    return new Promise<CliRun>((resolve) => {
      const startedAt = performance.now();
      const finish = (output: string, timedOut: boolean, exit: string | null): void => {
        const completed = !timedOut && exit !== null;
        resolve({ output, completed, durationMs: performance.now() - startedAt, timedOut, exit });
      };
      // Tier 1 prints the account's email and organization; keep them out of the log.
      const keepStdout = label === "tier2";
      const debugFile = path.join(probe.home, `${label}.debug.log`);
      const fullArgs = withDebugCapture(REFRESH_PROBE_COMMANDS[label], debugFile);
      const readCopy = (): string | null => {
        try {
          return fs.readFileSync(probe.credentialsFile, "utf8");
        } catch {
          return null;
        }
      };
      // Before the spawn: the CLI can refresh before this process runs again.
      let copySeen = readCopy();
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: probe.home };
      // With this set, the CLI ignores HOME and the copy is not private.
      delete env.CLAUDE_CONFIG_DIR;
      const opts: SpawnOptions = {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      };
      let child: ChildProcess;
      try {
        child = this.deps.spawn("claude", fullArgs, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        finish(`[spawn-failed] ${msg}`, false, null);
        return;
      }
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout?.on("data", (d: Buffer) => { if (keepStdout) stdout += d.toString("utf8"); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });

      const copyPoll = onCopyChange
        ? setInterval(() => {
          const current = readCopy();
          if (current === copySeen) return;
          copySeen = current;
          try {
            onCopyChange();
          } catch (err) {
            console.error("[claude-oauth-refresh] judging the probe's copy while the CLI runs failed:", err);
          }
        }, PROBE_COPY_POLL_MS)
        : null;
      if (copyPoll && typeof copyPoll.unref === "function") copyPoll.unref();

      let timedOut = false;
      let killGrace: ReturnType<typeof setTimeout> | null = null;
      const settle = (note: string, exit: string | null): void => {
        if (settled) return;
        settled = true;
        if (copyPoll) clearInterval(copyPoll);
        clearTimeout(timer);
        if (killGrace) clearTimeout(killGrace);
        let debugContent = "";
        try {
          // A timestamp's milliseconds can read as an HTTP status (".429Z").
          debugContent = fs.readFileSync(debugFile, "utf8").replace(LOG_TIMESTAMP_PATTERN, "");
        } catch { /* the CLI wrote no debug log */ }
        finish(`${stdout}\n${stderr}\n${debugContent}\n${note}`.trim(), timedOut, exit);
      };

      const timer = setTimeout(() => {
        timedOut = true;
        // Settle on the exit, not on the signal: a write under way must land before the copy is read.
        killGrace = setTimeout(() => settle(TIMED_OUT, null), KILL_SETTLE_MS);
        if (typeof killGrace.unref === "function") killGrace.unref();
        killProcessTree(child, "SIGKILL", { label: "claude-refresh" });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      child.on("exit", (code, signal) => settle(timedOut ? TIMED_OUT : "", String(code ?? signal ?? "unknown")));
      child.on("error", (err) => {
        // A kill that fails is an error and not an exit: the CLI can still write.
        if (!timedOut) settle(`[error] ${err.message}`, null);
      });
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
      .filter((sessionId) => readSessionAccountMarker(credentialsDir, sessionId).claude === accountId)
      .filter((sessionId) => this.tokenFileIsOwnedBySubtree(sessionId));
    if (candidates.length === 0) return null;

    const before = this.readSourceExpiresAt(accountId);
    const rejected = this.ensureAccountState(accountId).rejectedIdentity;
    let best = before;
    let adoptedFrom: string | null = null;
    for (const sessionId of candidates) {
      if (!sessionTokenIsAheadOfSource(credentialsDir, sessionId, "claude", accountId)) continue;
      // A session's copy of the credential that the token host rejected is no rotation.
      if (rejected !== null && this.readIdentityAt(this.sessionTokenFileFor(sessionId)) === rejected) continue;
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
        rejectedIdentity: null,
        pendingRotation: null,
        retryNotBefore: 0,
        privateRuns: new Set(),
        openRuns: 0,
        unjudgedRejection: null,
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
