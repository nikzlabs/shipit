/**
 * docs/161 Part 2 — steady-state disk-tier escalation ladder (hot → light →
 * evicted).
 *
 * Distinct from the startup janitor (`startup-janitor.ts`): the failure-recovery
 * sweeps there run once at boot, but the disk-tier ladder is the one disk task
 * that accumulates STEADILY (idle node_modules piling up), so it does NOT live in
 * `runDiskJanitor`. It's invoked async after each session start (the primary
 * steady-state reclaim), at orchestrator boot, AND on a low-frequency periodic
 * timer (issue #1049 — `DISK_ESCALATION_INTERVAL_MS`, wired in `index.ts`),
 * because session-start kicks alone create a self-heal feedback trap (a full disk
 * fails new starts → the kick never fires → nothing reclaims).
 */

import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SessionManager } from "./sessions.js";
import type { SessionInfo } from "../shared/types.js";
import type { SessionRunnerRegistry } from "./session-runner.js";
import type { ServiceManager } from "./service-manager.js";
import type { GitManager, UnreadableWorkspace } from "../shared/git.js";
import type { PersistedMessage } from "./chat-history.js";
import type { SecretFinding } from "../shared/secret-scan.js";
import { DEFAULT_DISK_LADDER, holdsActiveReservation, type DiskLadderThresholds } from "./sessions.js";
import {
  getMessage,
  sleep,
  reclaimRegenerableSessionDirs,
  reclaimBlockedSessionCaches,
} from "./disk-utils.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import { formatEvictBlockedNotice, type EvictBlockReason } from "./services/evict-blocked-notice.js";
import { autoCommitAllowed } from "./services/auto-commit-gate.js";

/**
 * docs/161 — dependencies for the disk-tier escalation pass. Distinct from the
 * startup-janitor deps: escalation needs live runner/container/compose state to
 * evaluate guards and execute teardown, plus a git factory to remediate dirty
 * checkouts before the destructive `evicted` rung.
 */
export interface TierEscalationDeps {
  sessionManager: SessionManager;
  runnerRegistry: SessionRunnerRegistry;
  /** Live compose stacks, keyed by session id (same map the WS layer uses). */
  serviceManagers: Map<string, ServiceManager>;
  /** Destroys the agent container so a bind-mounted workspace can be removed. */
  containerManager?: { destroy(sessionId: string): Promise<void> } | null;
  /** Prune named volumes by `shipit-session=<id>` label when no runner is left. */
  pruneVolumes?: (sessionId: string) => Promise<void>;
  /**
   * Git factory bound to a workspace dir. Used at `light → evicted` to
   * auto-commit + push a dirty checkout before wiping it. Omit in tests that
   * don't exercise dirty remediation.
   */
  createGitManager?: (dir: string) => GitManager;
  /**
   * docs/161 / planning#199 — the disk-idle ladder thresholds as one ordered config
   * (`lightAfterMs ≤ evictMergedAfterMs ≤ evictUnmergedAfterMs`). Defaults to
   * `DEFAULT_DISK_LADDER`. The orchestrator validates the ordering once at
   * startup (`assertDiskLadderOrdering`) before passing it here.
   */
  ladder?: DiskLadderThresholds;
  /**
   * planning#296 — chat-history sink for the persisted warning emitted when an
   * eviction is blocked by uncommittable work. Omit in tests that don't assert
   * the notice; the block itself never depends on it.
   */
  chatHistory?: { append(sessionId: string, message: PersistedMessage): unknown };
  /**
   * planning#296 — session ids already warned about a blocked eviction. Owned by the
   * caller (one Set per orchestrator process) so the hourly pass warns once per
   * stuck session instead of appending a row to its transcript every hour. A
   * restart re-warns, which is the right trade: the notice is cheap and the
   * condition is still true.
   */
  notifiedEvictBlocked?: Set<string>;
  /**
   * Sessions whose eviction is stuck for a reason that CANNOT change between
   * passes, mapped to the signature of what was last reported for them. Owned by
   * the caller (one Map per orchestrator process), same shape and lifetime as
   * `notifiedEvictBlocked`.
   *
   * The pass runs hourly and on every session start, and these outcomes repeat
   * identically forever — one production session logged the same "git check
   * failed" pair 117 times in an hour, for eight days, drowning real events in
   * the orchestrator log. The entry is cleared whenever the outcome changes, so
   * a session that gets stuck for a NEW reason is reported again; a stuck
   * session stays visible, just not once per pass.
   *
   * Omit in tests that don't assert the throttle: without it every occurrence
   * logs, which is the old behavior and harmless in a single-pass test.
   */
  evictStuckLog?: Map<string, string>;
  /**
   * Disk-pressure water marks (bytes free). When `getFreeDiskBytes` reports
   * below `diskFreeLow`, the pass escalates LRU-eligible sessions — ignoring the
   * idle thresholds — until free space crosses `diskFreeHigh`. Both must be set
   * (and `getFreeDiskBytes` provided) for the pressure path to engage.
   */
  diskFreeLow?: number;
  diskFreeHigh?: number;
  /** Free-bytes probe (a `statfs`), injectable for tests. */
  getFreeDiskBytes?: () => Promise<number | null>;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Throttle: milliseconds to pause between each AGE-BASED tier descent so the
   * steady-state reclaim of the idle node_modules tail doesn't hammer the
   * Docker daemon a concurrent agent start needs. Deliberately NOT applied to
   * the disk-pressure LRU descent (`applyDiskPressure`) — that path only fires
   * when the box is critically low and new starts are already failing, so there
   * fast is correct. Defaults to `0` (no pause) so unit tests stay fast;
   * production wires it via `DISK_ESCALATION_PACE_MS` in `index.ts`.
   */
  paceMs?: number;
}

export interface TierEscalationResult {
  /** Sessions taken `hot → light` (deps dropped, checkout kept). */
  toLight: number;
  /** Sessions taken `light → evicted` (workspace wiped). */
  toEvicted: number;
  /** Eviction skipped because a dirty checkout's push failed (kept at light). */
  evictBlockedByPush: number;
  /**
   * planning#296 — eviction skipped because the pre-eviction auto-commit refused
   * (secret finding / unresolved merge state), leaving uncommittable work in
   * the tree. Kept at light, with its regenerable overlay reclaimed.
   */
  evictBlockedByDirty: number;
}

/** docs/161 — idle age for the disk ladder: turn activity OR a recent view. */
function diskIdleAgeMs(s: SessionInfo, now: number): number {
  const used = Date.parse(s.lastUsedAt);
  const viewed = s.lastViewedAt ? Date.parse(s.lastViewedAt) : NaN;
  const latest = Math.max(
    Number.isFinite(used) ? used : 0,
    Number.isFinite(viewed) ? viewed : 0,
  );
  // latest === 0 only for a row with no parseable timestamps — treat as ancient.
  return now - latest;
}

/**
 * Guard shared by every automatic descent: never touch a session whose agent is
 * running or that currently has an attached viewer. (`light` additionally keeps
 * the checkout, so it skips the clean-tree guard handled inline at `evicted`.)
 */
function canAutoDescend(s: SessionInfo, runnerRegistry: SessionRunnerRegistry): boolean {
  // docs/110 — a pinned (persistent) session is never auto-reclaimed. This is the
  // single chokepoint for BOTH the age-based descent and the disk-pressure LRU
  // descent, so this one guard makes a pin immune to all automatic tier demotion;
  // its workspace is never dropped or wiped. (Explicit user archive still evicts,
  // but archive clears the pin first — see SessionManager.archive.)
  if (s.pinnedAt) return false;
  // docs/241 / docs/256 — an always-on preview reservation is a user-facing
  // guarantee that the container and its `x-shipit-preview: auto` services stay
  // up "across viewer disconnects, idle cleanup, memory-pressure eviction, and
  // orchestrator restarts". `idle-enforcer.ts` honors it; this ladder did not,
  // so a reserved preview nobody happened to view for 24h was demoted by the
  // `hot → light` rung — which disposes the runner and destroys the container,
  // exactly what the reservation promises won't happen. It also thrashed: the
  // container exit reaches the keep-preview restart supervisor
  // (`startup-monitors.ts`), which recreates what this pass just tore down.
  // The reservation is capacity-capped on admission (default 1), so honoring it
  // here cannot strand more than the deployment already agreed to hold.
  // The predicate, not the raw flag: a stale flag on an archived row must not
  // shield that row's disk from reclaim (see `holdsActiveReservation`).
  if (holdsActiveReservation(s)) return false;
  const runner = runnerRegistry.get(s.id);
  // docs/235 — `agentBusy` covers both an orchestrator-started turn and a
  // self-woken one (background task finished → the CLI started its own turn),
  // plus a task still pending between turns. `running` alone would let the
  // `hot → light` rung destroy the container of a session that is mid-work.
  if (runner?.agentBusy) return false;
  if (runner && runner.viewerCount > 0) return false;
  return true;
}

/**
 * `hot → light`: stop the container and drop the per-session compose named
 * volumes (node_modules / build caches — the bulk of the disk), while leaving
 * the workspace checkout (incl. uncommitted edits) on disk. Restore is a
 * dependency reinstall, not a re-clone.
 */
async function reclaimToLight(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<boolean> {
  const { sessionManager, runnerRegistry, pruneVolumes } = deps;
  const runner = runnerRegistry.get(session.id);
  const runnerWasAlive = runner !== undefined;

  // Signal the compose disposed-handler to drop named volumes, then dispose.
  // The guard already proved the agent isn't running, so a non-forced dispose
  // is safe and respects the runner-level "never kill a running agent" rule.
  if (runner && "removeVolumesOnDispose" in runner) {
    (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = true;
  }
  runnerRegistry.dispose(session.id);
  // planning#298's rule, which this ladder did not follow: a DECLINED dispose means
  // "leave this container alone". `canAutoDescend` ran before `sleep(paceMs)`
  // and before the git work above, so the runner can have picked up live work in
  // between — and the destroy below is unconditional, so the work died anyway
  // and the surviving runner was left pointed at a dead container. The window
  // widened when a turn's post-turn sequence became a decline reason of its own
  // (a turn that ends during the pace delay now holds the runner through its
  // commit), which is what made this worth closing rather than noting.
  if (runner && !runner.disposed) {
    // Un-arm the volume drop as well. It is a demotion instruction, not a
    // property of the runner: left set, the next ORDINARY dispose (idle
    // cleanup) would silently wipe the session's node_modules volume without
    // anything having decided to demote it.
    if ("removeVolumesOnDispose" in runner) {
      (runner as { removeVolumesOnDispose: boolean }).removeVolumesOnDispose = false;
    }
    console.log(
      `[disk-janitor] light: skipping container destroy for ${session.id}`
      + " — runner declined disposal (still holds live work)",
    );
    return false;
  }

  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] light: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  // Fallback: if no runner existed, the flag-driven compose-down with
  // `--volumes` never fired (idle eviction already disposed it). Stop any
  // lingering stack with volume removal and prune by label.
  if (!runnerWasAlive) {
    const mgr = deps.serviceManagers.get(session.id);
    if (mgr) {
      try { await mgr.stop({ removeVolumes: true }); } catch { /* best-effort */ }
    }
    if (pruneVolumes) {
      try { await pruneVolumes(session.id); } catch { /* best-effort */ }
    }
  }

  sessionManager.setDiskTier(session.id, "light");
  console.log(`[disk-janitor] ${session.id}: hot → light (dropped deps, kept checkout)`);
  return true;
}

/**
 * planning#296 — attribute a refused auto-commit to one of `GitManager.autoCommit`'s
 * refusal branches, for the user-facing notice only. Nothing branches on the
 * result: the wipe is already gated on the tree being clean.
 */
function describeBlock(r: {
  secretFindings: SecretFinding[];
  conflictedFiles: string[];
  rebaseInProgress: boolean;
  unreadable?: UnreadableWorkspace | null;
}): EvictBlockReason {
  if (r.secretFindings.length > 0) return { kind: "secret", findings: r.secretFindings };
  if (r.conflictedFiles.length > 0 || r.rebaseInProgress) {
    return { kind: "conflict", conflictedFiles: r.conflictedFiles, rebaseInProgress: r.rebaseInProgress };
  }
  // docs/266 / planning#407 — ranked below the two refusals above and above
  // `unknown`: a secret or a conflict is both more actionable and the reason
  // NOTHING was committed, while an unreadable path can accompany a commit that
  // otherwise succeeded.
  if (r.unreadable) return { kind: "unreadable", unreadable: r.unreadable };
  return { kind: "unknown" };
}

/**
 * planning#296 — the blocked-eviction outcome: the checkout is the only copy of some
 * work, so the session keeps it and stays at `light`. The ladder still does the
 * two things it safely can.
 *
 * 1. **Reclaim what is regenerable anyway.** The `overlay/` upper is a pure
 *    install-delta cache (docs/183) that eviction would have deleted and a
 *    restore re-installs, so dropping it (with its install marker — see
 *    `reclaimBlockedSessionCaches`) keeps a session that may stay pinned for
 *    weeks from also pinning the expensive half of its disk. Done for BOTH
 *    blocked outcomes: a push failure is usually transient, but "no remote at
 *    all" is permanent, and the two are indistinguishable from here. The
 *    `light` rung deliberately does NOT do this — it's the cheap, reversible
 *    tier, and a session resting there normally should restore fast.
 * 2. **Tell the user, when they can act on it.** A session pinned at `light` is
 *    otherwise invisible: it is idle, nothing is attached to it, and the only
 *    trace is a log line. The warning is persisted chat content (it must survive
 *    a reload — CLAUDE.md), emitted once per process per session so the hourly
 *    pass doesn't append a row an hour. Only for the refused-commit case: a
 *    failed push is usually a transient outage the next pass clears, and warning
 *    on it would post a row into every idle session during a GitHub blip.
 *
 * Deliberately NOT done: committing the work anyway to some rescue ref. A
 * secret-refused commit is refused to keep the credential out of git history,
 * and a rescue commit — pushed or not — puts it right back in.
 */
async function blockedEvict<T extends "blocked-by-push" | "blocked-by-dirty">(
  session: SessionInfo,
  deps: TierEscalationDeps,
  outcome: T,
  reason?: EvictBlockReason,
): Promise<T> {
  // A block is a different outcome than "stuck on an unchanging failure", and it
  // has its own once-per-session notice. Drop any throttled signature so a
  // later failure is reported again.
  clearStuck(session, deps);
  if (reason) {
    // Not always an auto-commit refusal: `no-repository` is the ladder's own,
    // for a workspace with no repository for a commit to have been refused in.
    console.warn(
      `[disk-janitor] evict blocked for ${session.id} — the checkout can't be made durable `
      + `(${reason.kind}), keeping it at light`,
    );
  }
  // Same freshness re-check the wipe path makes: the git/network work that led
  // here takes seconds, and dropping a dep cache out from under a session the
  // user just opened (its container may already be installing) is its own small
  // wreck. The notice is still worth posting, so only the reclaim is skipped.
  const fresh = deps.sessionManager.get(session.id);
  const stillIdle = fresh !== undefined && canAutoDescend(fresh, deps.runnerRegistry);
  if (session.workspaceDir && stillIdle) {
    // Never rejects — a failed cache reclaim reports and is otherwise ignored;
    // the block itself is what matters.
    const r = await reclaimBlockedSessionCaches(session.workspaceDir);
    if (r.message) {
      console.warn(`[disk-janitor] evict blocked: cache reclaim failed for ${session.id}:`, r.message);
    }
    if (r.removed.length > 0) {
      console.log(`[disk-janitor] ${session.id}: blocked evict — reclaimed dep caches, kept checkout`);
    }
  }
  const notified = deps.notifiedEvictBlocked;
  if (reason && deps.chatHistory && !notified?.has(session.id)) {
    try {
      const runner = deps.runnerRegistry.get(session.id);
      emitNoticePostTurn(
        (m) => runner?.emitMessage(m),
        deps.chatHistory,
        session.id,
        formatEvictBlockedNotice(reason),
        "warn",
      );
      // Marked only AFTER the append succeeds. Marking first would make a
      // transient DB failure permanent for the life of the process — the notice
      // would never be retried and the pin would stay silent.
      notified?.add(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] evict blocked: notice failed for ${session.id}:`, getMessage(err));
    }
  }
  return outcome;
}

/**
 * planning#296 — is the branch tip already recoverable from `origin`? "Tip present
 * in the bare cache" is the wrong question (a fresh push isn't in the cache
 * until its next fetch), and so is "the working tree is clean" (a committed but
 * unpushed tip is clean and still exists nowhere else). This asks the only
 * question that matters before a wipe: is HEAD contained in `origin/<branch>`?
 *
 * Fails toward pushing: an unresolvable remote ref (never pushed, no `origin`
 * at all, pruned tracking ref) returns false, and the caller's push then either
 * makes the tip durable or blocks the eviction. An empty repo (no HEAD) has
 * nothing to lose.
 *
 * Answered from the local remote-tracking ref rather than a live `ls-remote`,
 * deliberately. The tracking ref records what THIS clone pushed, which is the
 * thing at risk, and it needs no network or credentials on a janitor pass. A
 * live query would also be *wrong* for the ladder's most common eviction: a
 * merged session whose branch GitHub auto-deleted has no remote branch left,
 * yet its commits are safely in the base branch — `ls-remote` would say "not
 * durable" and pin every merged session forever. The residual risk is a remote
 * branch force-pushed out from under a stale tracking ref, which loses commits
 * that were nonetheless pushed once.
 */
async function tipIsOnOrigin(git: GitManager, branch: string): Promise<boolean> {
  const head = await git.getHeadHash();
  if (!head) return true;
  const remoteTip = await git.getRefHash(`refs/remotes/origin/${branch}`);
  if (!remoteTip) return false;
  return remoteTip === head || await git.isAncestor(head, remoteTip);
}

/**
 * Does a path exist? Deliberately three-valued, and deliberately `lstat`.
 *
 * Both callers below feed a DESTRUCTIVE decision, so "the stat failed" must not
 * collapse into "it isn't there": an `EACCES` on a mount being remounted, or an
 * `EIO` on a failing disk, would otherwise read as an absent workspace and
 * authorize the wipe. Only the two errors that genuinely mean "no such path"
 * (`ENOENT`, and `ENOTDIR` for a component that isn't a directory) answer
 * `absent`; anything else answers `unknown`, which every caller treats as
 * `present` — the careful path. `lstat` because a `.git` SYMLINK is still a
 * repository pointer worth protecting even when its target is gone.
 */
async function pathState(p: string): Promise<"present" | "absent" | "unknown"> {
  try {
    await lstat(p);
    return "present";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "unknown";
  }
}

/** True only when `dir` is readable AND holds nothing. An unreadable directory
 * answers false — the callers use this to authorize a wipe, so "I couldn't
 * tell" must mean "assume there is something in there". */
async function isEmptyDir(dir: string): Promise<boolean> {
  const entries = await readdir(dir).catch(() => null);
  return entries !== null && entries.length === 0;
}

/**
 * Report a repeating eviction failure ONCE per session per distinct cause,
 * instead of once per pass. `signature` identifies the cause (kind + the
 * underlying message, when there is one): a DIFFERENT signature is a different
 * outcome and logs again, so the throttle can never hide a new problem behind an
 * old one. See {@link TierEscalationDeps.evictStuckLog}.
 */
function warnStuck(
  session: SessionInfo,
  deps: TierEscalationDeps,
  signature: string,
  message: string,
): void {
  const log = deps.evictStuckLog;
  if (log?.get(session.id) === signature) return;
  log?.set(session.id, signature);
  console.warn(message);
}

/**
 * Forget a session's last reported stuck-signature, so the next occurrence of
 * anything — including the same cause — is logged again. Called from every path
 * that reaches a DIFFERENT outcome than "stuck": the throttle is scoped to an
 * unchanging outcome, not to the session.
 */
function clearStuck(session: SessionInfo, deps: TierEscalationDeps): void {
  deps.evictStuckLog?.delete(session.id);
}

/**
 * `light → evicted`: the destructive rung. Everything it wipes must be
 * recoverable from `origin` first, so it remediates the checkout and refuses to
 * proceed unless three things hold: the tree is clean, no merge/rebase is
 * mid-flight, and HEAD is on `origin`. Any of them failing leaves the session at
 * `light` with its files intact. On success the workspace is wiped — restore
 * re-clones from the bare cache off fresh `origin/main`.
 */
async function reclaimToEvicted(
  session: SessionInfo,
  deps: TierEscalationDeps,
): Promise<"evicted" | "blocked-by-push" | "blocked-by-dirty" | "skipped"> {
  const { sessionManager, createGitManager } = deps;

  // planning#296 — a checkout that is already gone has nothing to protect, and every
  // git question below would throw on it and return "skipped" forever. That
  // left a `light` row whose workspace is missing pinned in a broken state:
  // activation's `light → hot` shortcut skips `restoreSessionWorkspace`
  // (route-registry.ts), so the container bind-mount 404s in a loop. Recording
  // the truth — it IS evicted — routes the next activation through restore.
  // Only when a remote can supply the re-clone; without one it is unrecoverable
  // either way, so leave the row alone rather than assert a lie.
  //
  // "Already gone" is not only a MISSING DIRECTORY. A directory that survives
  // with NO git repository inside it can never satisfy the durability gate
  // below either — every git question throws on it — and that case was not
  // covered: a production session sat at `light` for eight days logging "git
  // check failed: fatal: not a git repository" on every pass, because
  // `workspaceGone` was false (the dir exists), the first git call threw, and
  // the catch returned "skipped" — no state change, no backoff, so the next pass
  // repeated the identical work and failed identically, forever.
  //
  // It splits in two, and the split is the whole point. "No repository" does NOT
  // mean "no work": loose files in such a directory are recoverable from nowhere
  // (no commits, no branch, nothing that could ever be pushed), so wiping them
  // would be the one place this rung destroys something origin can't give back —
  // exactly what every other refusal here (no remote, detached HEAD, refused
  // commit) declines to do. So only an EMPTY remnant joins the missing-workspace
  // case; a non-empty one is a BLOCK (below), which still reclaims the
  // regenerable overlay — the expensive half of the disk — and tells the user.
  // `.git` present in ANY form (a directory, or the file a worktree/submodule
  // uses) keeps the old, careful path: a corrupt-but-real checkout is still
  // never wiped.
  const wsDir = session.workspaceDir;
  const workspaceMissing = wsDir !== undefined && (await pathState(wsDir)) === "absent";
  const repoMissing = wsDir !== undefined && !workspaceMissing
    && (await pathState(join(wsDir, ".git"))) === "absent";
  const emptyRemnant = repoMissing && await isEmptyDir(wsDir);
  const nothingToProtect = workspaceMissing || emptyRemnant;
  if (nothingToProtect && !session.remoteUrl) {
    warnStuck(
      session, deps,
      `no-remote:${workspaceMissing ? "missing" : "empty-remnant"}`,
      `[disk-janitor] evict skipped for ${session.id} — workspace `
      + `${workspaceMissing ? "missing" : "is an empty non-repository directory"} and no remote to `
      + "restore from (this cannot change on its own; further passes stay quiet)",
    );
    return "skipped";
  }

  // docs/128 / docs/211 — an `ops` or `sandbox` session is never evicted, and
  // therefore never auto-committed on the way out (this function holds the only
  // `git.autoCommit` call the disk janitor makes). Two independent reasons:
  //
  //  - **Eviction of these kinds is unrecoverable.** Step 3 below reads the
  //    CHECKOUT's `refs/remotes/origin/<branch>`, not `session.remoteUrl` — so a
  //    sandbox that ran `git clone <url> .` at the root, or an ops agent that
  //    added an origin by hand mid-investigation, satisfies the durability gate
  //    with a session row that still has NO `remoteUrl`. The wipe then succeeds
  //    and `restoreSessionWorkspace` (`services/session.ts`) throws 410, because
  //    restore re-clones from session METADATA. Refusing here closes that; do
  //    NOT "fix" it by inferring the remote from the checkout, since neither kind
  //    has a tracked branch lifecycle for restore to land on.
  //  - **The remediation commit is itself forbidden.** ShipIt does not
  //    auto-commit these kinds (`services/auto-commit-gate.ts`), and an idle ops
  //    session whose investigation left scratch files is the common case, not a
  //    corner — so the old path wrote `Auto-commit before disk eviction` commits
  //    into exactly the history the gate exists to keep ShipIt out of.
  //
  // `blocked-by-push` is the honest outcome: the checkout is not durably
  // recoverable. It still reclaims the regenerable dep caches (the expensive
  // half) and, being reason-less, posts no user-facing notice — there is nothing
  // the user can act on, and no commit was attempted to have been "refused".
  if (!autoCommitAllowed(session)) {
    console.warn(
      `[disk-janitor] evict refused for ${session.id} — kind=${session.kind} sessions are never `
      + "evicted: restore re-clones from session metadata they don't have, so the wipe would be "
      + "unrecoverable; keeping the checkout at light",
    );
    return await blockedEvict(session, deps, "blocked-by-push");
  }

  // A workspace with no repository but with FILES in it. Nothing here can ever
  // make those files durable — there is no branch to push and no commit to
  // contain them — so this is a terminal block, not a retry: the outcome is
  // recorded once and the ladder does the two things it safely can (reclaim the
  // regenerable overlay, tell the user), exactly as for a refused commit. The
  // user is the only one who can resolve it, by rescuing what matters and
  // archiving the session.
  if (repoMissing && !emptyRemnant) {
    return await blockedEvict(session, deps, "blocked-by-push", { kind: "no-repository" });
  }

  // Durability guard: a `light` session keeps its checkout on disk, and the
  // container is stopped — so we operate git directly on the host checkout.
  if (createGitManager && session.workspaceDir && !nothingToProtect) {
    try {
      const git = createGitManager(session.workspaceDir);

      // 1. Remediate a dirty tree, then re-check it. planning#296 — `autoCommit`
      //    returns a null hash from THREE paths and only one of them is safe to
      //    wipe: "nothing to commit". The other two — an unresolved merge/rebase
      //    state, and a secret-scanner refusal (docs/213) — are normal returns,
      //    not throws, so they used to fall straight past the old
      //    `if (commitHash)` gate into the wipe, destroying uncommitted work
      //    that has no reflog entry. That is exactly the loss the `catch` below
      //    exists to prevent.
      //
      //    The gate is a RE-CHECK of the tree rather than an inspection of
      //    `secretFindings` / `conflictedFiles`: both refusals leave the tree
      //    dirty (the secret path `git reset`s to unstage) while
      //    nothing-to-commit leaves it clean, so one cause-agnostic question —
      //    "is the work still only in the working tree?" — separates them, and
      //    covers any future refusal path (or a commit hook that leaves the tree
      //    dirty behind a successful commit) by construction. The returned
      //    fields only explain the block.
      //    docs/266 / planning#407 — and the question is `inspectWorkingTree()`,
      //    NOT `isClean()`. `isClean()` is TRUE for content git cannot read,
      //    because git cannot see it. Root-side git read everything, so the
      //    re-check was correct by accident; once orchestrator git runs as the
      //    tree's own uid it is not, and the gap is a DATA-LOSS path the uid
      //    drop created: a subtree the session uid cannot open answers "clean",
      //    the commit is never even attempted, and the wipe below destroys work
      //    that root-side git used to commit. An unreadable path is therefore a
      //    block in its own right, before and after the commit.
      const before = await git.inspectWorkingTree();
      if (!before.clean) {
        const { secretFindings, conflictedFiles, rebaseInProgress, unreadable } =
          await git.autoCommit("Auto-commit before disk eviction (docs/161)");
        const after = await git.inspectWorkingTree();
        if (!after.clean || after.unreadable || unreadable) {
          return await blockedEvict(
            session, deps, "blocked-by-dirty",
            describeBlock({
              secretFindings, conflictedFiles, rebaseInProgress,
              unreadable: unreadable ?? after.unreadable,
            }),
          );
        }
      } else if (before.unreadable) {
        // The sharp case, and the one no re-check could have caught: the
        // unreadable subtree holds the ONLY uncommitted content, so git reports
        // a clean tree and there is nothing for `autoCommit` to stage. Nothing
        // will ever make this durable at this uid — block, and tell the user,
        // exactly as for a workspace with no repository.
        return await blockedEvict(
          session, deps, "blocked-by-dirty",
          { kind: "unreadable", unreadable: before.unreadable },
        );
      }

      // 2. A clean tree is not a quiet repo. An interactive rebase stopped at an
      //    `edit`/`exec` step, or a conflict-free merge awaiting its commit, has
      //    NOTHING uncommitted yet holds in-flight commits and recovery state
      //    that live only in `.git`. `autoCommit`'s own conflict branch never
      //    sees these — step 1 short-circuits on the clean tree — so the check
      //    has to be made here.
      const rebasing = await git.isRebaseInProgress();
      if (rebasing || await git.isMergeOrSequencerInProgress()) {
        return await blockedEvict(
          session, deps, "blocked-by-dirty",
          { kind: "conflict", conflictedFiles: [], rebaseInProgress: rebasing },
        );
      }

      // 3. Durability gate: the tip must be on `origin` (the recoverable state —
      //    evicted → hot re-clones from the cache, which is refreshed from
      //    origin). Checked UNCONDITIONALLY, not only when we just committed:
      //    a commit this pass made but failed to push leaves a *clean* tree, so
      //    a later pass used to sail through and wipe it. A session with no
      //    remote at all can never satisfy this and is never evicted — matching
      //    `archiveSession`, which likewise refuses to reclaim a repo-less
      //    workspace because nothing can restore it.
      //    Both the check and the push key off the CHECKED-OUT branch, not
      //    `session.branch`: `GitManager.push` pushes the *named local branch*,
      //    so on a detached HEAD (or a session row whose branch drifted from the
      //    checkout) pushing `session.branch` reports "Everything up-to-date"
      //    while HEAD's commits stay local — a successful push that proves
      //    nothing, followed by a wipe. A detached HEAD has no branch to push at
      //    all, so it can never be durable: block.
      const branch = await git.currentBranchOrNull();
      if (!branch) {
        console.warn(
          `[disk-janitor] evict blocked for ${session.id} — HEAD is detached, so its commits `
          + "belong to no branch that could be pushed; keeping at light",
        );
        return await blockedEvict(session, deps, "blocked-by-push");
      }
      if (!(await tipIsOnOrigin(git, branch))) {
        try {
          await git.push("origin", branch);
        } catch (pushErr) {
          console.warn(
            `[disk-janitor] evict blocked for ${session.id} — the branch tip is not on origin `
            + "and the push failed (offline / no auth / no remote), keeping at light:",
            getMessage(pushErr),
          );
          return await blockedEvict(session, deps, "blocked-by-push");
        }
      }
    } catch (err) {
      // A git failure here (corrupt checkout, etc.) must not wipe unrecoverable
      // work — bail out and leave the session at light. Reported once per
      // distinct failure: nothing here changes the session's state, so an
      // unchanged failure means the next pass will fail identically. A session
      // stuck this way is still visible in the log; it just doesn't repeat
      // hourly (and, above, one whole class of it no longer reaches here).
      const message = getMessage(err);
      warnStuck(
        session, deps, `git-check:${message}`,
        `[disk-janitor] evict skipped for ${session.id} — git check failed`
        + ` (repeats of this same failure stay quiet): ${message}`,
      );
      return "skipped";
    }
    // The git block completed, so whatever was stuck before isn't now. Forget
    // it, so a later failure — even the same one — is reported again.
    clearStuck(session, deps);
  }

  // planning#296 — the guards were evaluated before the pacing delay and the git /
  // network work above, which take seconds. Re-read the row and re-run them
  // immediately before the destructive step so a session the user opened in the
  // meantime isn't wiped out from under them.
  const fresh = sessionManager.get(session.id);
  if (!fresh || !canAutoDescend(fresh, deps.runnerRegistry)) {
    console.warn(`[disk-janitor] evict skipped for ${session.id} — became active during remediation`);
    return "skipped";
  }

  // Tear down container (no runner should exist at light, but be defensive).
  deps.runnerRegistry.dispose(session.id);
  // Same planning#298 rule as the `hot → light` rung, and it matters more here: the
  // step after the destroy WIPES THE WORKSPACE. A declined dispose is the runner
  // saying it still holds live work, so this must not be the path that deletes
  // that work's checkout.
  const evictRunner = deps.runnerRegistry.get(session.id);
  if (evictRunner && !evictRunner.disposed) {
    console.warn(
      `[disk-janitor] evict skipped for ${session.id} — runner declined disposal (still holds live work)`,
    );
    return "skipped";
  }
  if (deps.containerManager) {
    try {
      await deps.containerManager.destroy(session.id);
    } catch (err) {
      console.warn(`[disk-janitor] evict: container destroy failed for ${session.id}:`, getMessage(err));
    }
  }

  if (session.workspaceDir) {
    // planning#194 — reclaim BOTH the checkout and the regenerable overlay/ upper
    // sibling, preserving durable siblings (uploads/). Removing only the
    // checkout orphaned the overlay upper (the bulk of the disk).
    const { failed } = await reclaimRegenerableSessionDirs(session.workspaceDir);
    for (const f of failed) {
      console.warn(`[disk-janitor] evict: rm failed for ${session.id} (${f.dir}):`, f.message);
    }
  }

  sessionManager.setDiskTier(session.id, "evicted");
  // After the tier write, not before: a throwing `setDiskTier` leaves the
  // session stuck exactly as it was, and forgetting its signature first would
  // make the next pass re-log a failure whose outcome never changed.
  clearStuck(session, deps);
  console.log(`[disk-janitor] ${session.id}: light → evicted (workspace + overlay wiped)`);
  return "evicted";
}

/**
 * docs/161 Part 2 — the disk-tier escalation pass. Walks idle sessions and
 * descends the ladder (`hot → light → evicted`) when idle age crosses the
 * thresholds, or — under disk pressure — escalates least-recently-used eligible
 * sessions regardless of age until free space recovers. The `light → evicted`
 * threshold is merge-aware: a session whose PR is merged (`mergedAt` set) is
 * reclaimed on the short `ladder.evictMergedAfterMs` clock, while unmerged WIP
 * stays on the gentle `ladder.evictUnmergedAfterMs` clock. Every descent passes
 * `canAutoDescend` (not running, no attached viewer); the destructive `evicted`
 * rung additionally remediates dirty checkouts.
 *
 * Invoked async after each session start (the primary steady-state reclaim,
 * since prod deploys manually so the startup janitor runs rarely) and never on
 * the start critical path; fired once at orchestrator startup as a safety net
 * for the long-idle tail; and re-fired on a low-frequency periodic timer
 * (issue #1049) so reclaim + the disk-pressure check still run when the
 * instance is quiet or wedged (a full disk fails new session starts, which
 * would otherwise stop the only steady-state trigger). Always resolves — never
 * rejects — so callers can fire-and-forget.
 *
 * Excludes the just-started `excludeSessionId` defensively even though its
 * viewer/running guards would already protect it.
 */
export async function escalateDiskTiers(
  deps: TierEscalationDeps,
  excludeSessionId?: string,
): Promise<TierEscalationResult> {
  const result: TierEscalationResult = {
    toLight: 0, toEvicted: 0, evictBlockedByPush: 0, evictBlockedByDirty: 0,
  };
  const now = (deps.now ?? Date.now)();
  const ladder = deps.ladder ?? DEFAULT_DISK_LADDER;
  const paceMs = deps.paceMs ?? 0;

  // Candidate set: non-warm sessions still holding disk, minus the one we just
  // started. (`listAll` already excludes warm.)
  const candidates = deps.sessionManager.listAll().filter(
    (s) => s.id !== excludeSessionId && s.diskTier !== "evicted",
  );

  // --- Age-based descent ---
  for (const s of candidates) {
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    const age = diskIdleAgeMs(s, now);
    const tier = s.diskTier ?? "hot";
    // Merge-aware threshold: a merged PR ("done") evicts far sooner than
    // unmerged WIP, which stays on the gentle `evictUnmergedAfterMs` clock. Idle
    // age is still max(lastUsedAt, lastViewedAt), so a merged session you
    // reopened to look at isn't yanked mid-view.
    const evictThreshold = s.mergedAt ? ladder.evictMergedAfterMs : ladder.evictUnmergedAfterMs;
    try {
      // Pace only when we're about to actually act — skipped candidates
      // (wrong tier / not idle enough) cost nothing and shouldn't drip-delay
      // the scan. The disk-pressure descent below is intentionally un-paced.
      if (tier === "light" && age >= evictThreshold) {
        await sleep(paceMs);
        const outcome = await reclaimToEvicted(s, deps);
        if (outcome === "evicted") result.toEvicted += 1;
        else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
        else if (outcome === "blocked-by-dirty") result.evictBlockedByDirty += 1;
      } else if (tier === "hot" && age >= ladder.lightAfterMs) {
        await sleep(paceMs);
        if (await reclaimToLight(s, deps)) result.toLight += 1;
      }
    } catch (err) {
      console.warn(`[disk-janitor] tier escalation failed for ${s.id}:`, getMessage(err));
    }
  }

  // --- Disk-pressure LRU descent ---
  await applyDiskPressure(deps, now, excludeSessionId, result);

  // Prune the stuck-log to sessions that could still be stuck the same way.
  // `clearStuck` covers the outcomes this function decides; a session can also
  // stop being stuck for reasons the ladder never sees — it was opened (back to
  // `hot`, its checkout repaired by the agent), archived, or deleted. Keeping
  // the map to the current `light` rows both bounds it and honors the contract:
  // an entry only suppresses a repeat of an outcome that is still the truth.
  const stuck = deps.evictStuckLog;
  if (stuck && stuck.size > 0) {
    const stillLight = new Set(
      deps.sessionManager.listAll().filter((s) => (s.diskTier ?? "hot") === "light").map((s) => s.id),
    );
    for (const id of [...stuck.keys()]) {
      if (!stillLight.has(id)) stuck.delete(id);
    }
  }

  if (result.toLight || result.toEvicted || result.evictBlockedByPush || result.evictBlockedByDirty) {
    console.log(
      `[disk-janitor] tier escalation: hot→light=${result.toLight} `
      + `light→evicted=${result.toEvicted} evict-blocked-push=${result.evictBlockedByPush} `
      + `evict-blocked-dirty=${result.evictBlockedByDirty}`,
    );
  }
  return result;
}

/**
 * Folded into the escalation pass: when free disk drops below `diskFreeLow`,
 * escalate the least-recently-used eligible sessions (`hot → light` first, then
 * `light → evicted`) regardless of idle age until free space crosses
 * `diskFreeHigh`. Guards still apply. No-op unless both water marks and the
 * probe are configured.
 */
async function applyDiskPressure(
  deps: TierEscalationDeps,
  now: number,
  excludeSessionId: string | undefined,
  result: TierEscalationResult,
): Promise<void> {
  const { diskFreeLow, diskFreeHigh, getFreeDiskBytes } = deps;
  if (diskFreeLow === undefined || diskFreeHigh === undefined || !getFreeDiskBytes) return;

  let free = await getFreeDiskBytes();
  if (free === null || free >= diskFreeLow) return;

  // LRU order: oldest idle first. Re-read from the DB so already-escalated
  // sessions reflect their new tier.
  const lru = (sids: SessionInfo[]) =>
    sids.slice().sort((a, b) => diskIdleAgeMs(b, now) - diskIdleAgeMs(a, now));

  // Pass 1: hot → light (cheap, non-destructive) recovers the bulk of disk.
  for (const s of lru(
    deps.sessionManager.listAll().filter(
      (x) => x.id !== excludeSessionId && (x.diskTier ?? "hot") === "hot",
    ),
  )) {
    if (free !== null && free >= diskFreeHigh) break;
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    try {
      if (await reclaimToLight(s, deps)) result.toLight += 1;
    } catch (err) {
      console.warn(`[disk-janitor] pressure light failed for ${s.id}:`, getMessage(err));
    }
    free = await getFreeDiskBytes();
  }

  if (free !== null && free >= diskFreeHigh) return;

  // Pass 2: light → evicted (destructive) only if still under the high mark.
  for (const s of lru(
    deps.sessionManager.listAll().filter(
      (x) => x.id !== excludeSessionId && (x.diskTier ?? "hot") === "light",
    ),
  )) {
    if (free !== null && free >= diskFreeHigh) break;
    if (!canAutoDescend(s, deps.runnerRegistry)) continue;
    try {
      const outcome = await reclaimToEvicted(s, deps);
      if (outcome === "evicted") result.toEvicted += 1;
      else if (outcome === "blocked-by-push") result.evictBlockedByPush += 1;
      else if (outcome === "blocked-by-dirty") result.evictBlockedByDirty += 1;
    } catch (err) {
      console.warn(`[disk-janitor] pressure evict failed for ${s.id}:`, getMessage(err));
    }
    free = await getFreeDiskBytes();
  }
}
