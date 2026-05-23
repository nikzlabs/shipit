/**
 * Agent-spawned child sessions (docs/117).
 *
 * Extracted from `session.ts` to keep the parent-session module focused on
 * reads/mutations against a single session. The child-session feature is its
 * own sub-feature: a parent session can spawn sibling sessions under it, each
 * with its own clone, branch, chat history, and runner.
 */

import path from "node:path";
import fs from "node:fs/promises";
import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { RepoGit } from "../repo-git.js";
import type { RepoStore } from "../repo-store.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { SessionInfo, AgentId } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import { generateBranchPrefix } from "../git-utils.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { ServiceError } from "./types.js";
import type { ClaimSessionService } from "./claim-session.js";

/**
 * Read a positive-integer env var override. Returns `undefined` when the var
 * is unset or unparseable (non-integer, ≤ 0) so the caller falls back to the
 * compile-time default. Logged once on parse failure to make typos visible.
 */
function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`[child-sessions] ignoring ${name}=${raw} (must be a positive integer)`);
    return undefined;
  }
  return parsed;
}

/**
 * Default per-parent quota for active spawned child sessions.
 * Overridable via the `MAX_SPAWNED_SESSIONS_PER_PARENT` env var (positive
 * integer); the compile-time default is `16`. Read once at module init.
 */
export const DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_PARENT") ?? 16;

/**
 * Default per-turn quota for newly-spawned child sessions.
 * Overridable via the `MAX_SPAWNED_SESSIONS_PER_TURN` env var (positive
 * integer); the compile-time default is `4`. Read once at module init.
 */
export const DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SPAWNED_SESSIONS_PER_TURN") ?? 4;

/**
 * Tiny regex-style validation reused from `forkSession`. Rejects anything
 * that's not a sane git ref. Keep in sync with `forkSession`.
 */
function assertValidBranchName(name: string): void {
  if (/[\s~^:?*[\\]/.test(name) || name.includes("..")) {
    throw new ServiceError(400, "Invalid branch name");
  }
}

export interface SpawnChildSessionOptions {
  /** The required initial user prompt that the spawned session's agent runs. */
  prompt: string;
  /** Session title. Defaults to a slug derived from `prompt`. */
  title?: string;
  /** Child branch name. Defaults to a generated prefix (`shipit/<slug>`). */
  branch?: string;
  /**
   * Git ref to branch off. Defaults to the parent's current HEAD via
   * `git rev-parse HEAD`. When provided, this is passed verbatim to
   * `git checkout -b <child-branch> <base>` in the child's workspace, so
   * any value `git` accepts there is allowed (commit hash, `origin/main`,
   * a tag, etc.).
   */
  base?: string;
  /** Optional agent id override. Defaults to the parent's selected agent. */
  agent?: AgentId;
  /** Optional model override. Defaults to the parent's selected model. */
  model?: string;
  /**
   * Free-form id of the parent turn that triggered the spawn. Persisted as
   * `spawnedByTurn` so `shipit session list` can sort "this turn first"
   * without walking chat history.
   */
  spawnedByTurn?: string;
  /**
   * Per-turn cap. Default {@link DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN}.
   * Counted by matching `spawnedByTurn` on the parent's existing children.
   * Skipped when `spawnedByTurn` is undefined (no turn id ⇒ nothing to
   * count, but the per-parent cap still applies).
   */
  maxSpawnedSessionsPerTurn?: number;
  /**
   * Per-parent cap on active (non-archived) spawned children. Default
   * {@link DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS}.
   */
  maxActiveSpawnedSessions?: number;
}

export interface SpawnChildSessionResult {
  /** The newly-created child session. */
  session: SessionInfo;
  /** Convenience field for the CLI shim's text output. */
  sessionId: string;
  /** The child's branch name (generated or user-supplied). */
  branch: string;
  /** Updated session list (for SSE broadcast on the parent's side). */
  sessions: SessionInfo[];
}

/**
 * Spawn a sibling session under `parentSessionId`. The new session shares
 * the parent's repo (or local-only fallback) but gets its own clone, branch,
 * chat history, and runner — exactly like a session created from the UI.
 *
 * The agent never reaches this function directly; the call chain is:
 *   `shipit session create` (shim)
 *   → worker `/agent-ops/session/create`
 *   → orchestrator `POST /api/sessions/:parentId/spawn`
 *   → `spawnChildSession`.
 *
 * Quotas are enforced fail-closed (the orchestrator returns 429 / ServiceError
 * before any disk work happens). The first prompt is enqueued on the child's
 * runner via `sendSystemMessage` so it kicks off the agent the moment the
 * runner is ready — matching the home-screen "send a message" behaviour
 * without needing a WS to be attached.
 */
export async function spawnChildSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  createRepoGit: (dir: string) => RepoGit,
  getBareCacheDir: (repoUrl: string) => string,
  sessionsRoot: string,
  githubAuthManager: { authenticated: boolean; configureGitCredentials: (dir: string) => void },
  claimService: ClaimSessionService,
  repoStore: RepoStore,
  parentSessionId: string,
  opts: SpawnChildSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
): Promise<SpawnChildSessionResult> {
  const trimmedPrompt = opts.prompt?.trim();
  if (!trimmedPrompt) {
    throw new ServiceError(400, "prompt is required");
  }
  if (trimmedPrompt.length > 50_000) {
    throw new ServiceError(400, "prompt exceeds 50,000 characters");
  }

  const parent = sessionManager.get(parentSessionId);
  if (!parent) throw new ServiceError(404, "Parent session not found");
  if (parent.archived) throw new ServiceError(400, "Parent session is archived");
  if (!parent.workspaceDir) {
    throw new ServiceError(400, "Parent session has no workspace");
  }

  // Quota: per-parent cap on active spawned children. Fail-closed.
  const maxActive = opts.maxActiveSpawnedSessions ?? DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS;
  const existingChildren = sessionManager.findChildren(parentSessionId);
  if (existingChildren.length >= maxActive) {
    throw new ServiceError(
      429,
      `This session already has ${existingChildren.length} spawned children (max ${maxActive}). Archive one before spawning another.`,
    );
  }

  // Quota: per-turn cap. Skipped when no turn id is supplied; the per-parent
  // cap still bounds total fanout.
  if (opts.spawnedByTurn) {
    const maxPerTurn = opts.maxSpawnedSessionsPerTurn ?? DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN;
    const inThisTurn = existingChildren.filter((c) => c.spawnedByTurn === opts.spawnedByTurn).length;
    if (inThisTurn >= maxPerTurn) {
      throw new ServiceError(
        429,
        `Per-turn spawn limit reached (${maxPerTurn}). Wait for the current turn to end before spawning more sessions.`,
      );
    }
  }

  // Validate and compute branch + title up front so we fail fast before disk work.
  const branchName = opts.branch?.trim() || generateBranchPrefix();
  assertValidBranchName(branchName);
  const title = opts.title?.trim() || trimmedPrompt.slice(0, 60) || "Spawned session";

  // When the parent's repo is registered and ready, route through the same
  // warm-pool-aware claim path the home screen uses (`claimSessionService`).
  // The claim gives us a workspace branched off a freshly-fetched
  // `origin/main`, so the child's "Changes vs main" diff is accurate from
  // the moment it appears — instead of inheriting whatever stale `origin/main`
  // snapshot the parent's bare cache happened to have, plus the parent's
  // committed-but-not-merged WIP on top.
  //
  // The fallback path below is preserved for parents without a registered
  // remote (integration tests, ad-hoc local repos) — there's no `origin/main`
  // to branch off, so we keep the original "branch off parent's HEAD" behavior.
  const useClaim = !!(parent.remoteUrl && repoStore.get(parent.remoteUrl)?.status === "ready");

  let newSessionId: string;
  let newWorkspaceDir: string;

  if (useClaim && parent.remoteUrl) {
    const claimed = await claimService.claim(parent.remoteUrl);
    newSessionId = claimed.sessionId;
    newWorkspaceDir = claimed.workspaceDir;

    // The claim cut a warm-prefix branch (`shipit/<random>`). Rename it to
    // the spawn's chosen name so the child appears with the right branch
    // from the start.
    try {
      const currentBranch = (await simpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
      if (currentBranch && currentBranch !== branchName) {
        await simpleGit(newWorkspaceDir).raw(["branch", "-m", currentBranch, branchName]);
      }
    } catch (err) {
      throw new ServiceError(400, `Failed to rename branch to '${branchName}': ${String(err)}`);
    }

    // Honor an explicit `--base`. The claim placed HEAD at `origin/HEAD`; a
    // caller-supplied base needs a hard reset to take effect. Safe because
    // the claim's workspace has no user changes yet.
    if (opts.base) {
      try {
        await simpleGit(newWorkspaceDir).raw(["reset", "--hard", opts.base]);
      } catch (err) {
        throw new ServiceError(400, `Failed to reset to base '${opts.base}': ${String(err)}`);
      }
    }

    // Graduate the warm session into a user-visible spawn and override the
    // claim-assigned title / branch. Credentials, gc.auto config, and the
    // remoteUrl row were all set during the claim itself.
    sessionManager.rename(newSessionId, title);
    sessionManager.setBranch(newSessionId, branchName);
    sessionManager.setBranchRenamed(newSessionId, true);
    sessionManager.setWarm(newSessionId, false);
  } else {
    // Local-repo fallback: parent isn't backed by a registered remote (tests,
    // ad-hoc repos). Branch off parent's HEAD so the child sees the parent's
    // committed state — preserves the docs/117 v1 behavior for this path.
    const crypto = await import("node:crypto");
    newSessionId = crypto.randomUUID();
    const newSessionDir = path.join(sessionsRoot, newSessionId);
    newWorkspaceDir = path.join(newSessionDir, "workspace");
    await fs.mkdir(newSessionDir, { recursive: true });

    let startPoint = opts.base?.trim();
    if (!startPoint) {
      try {
        const parentHead = await simpleGit(parent.workspaceDir).revparse(["HEAD"]);
        startPoint = parentHead.trim();
      } catch {
        // Empty repo / detached HEAD — fall through.
        startPoint = undefined;
      }
    }

    if (parent.remoteUrl) {
      // Remote URL exists but the repo isn't registered (yet/anymore) —
      // mirror the original bare-cache clone for graceful degradation.
      const cacheDir = getBareCacheDir(parent.remoteUrl);
      const cacheGit = createRepoGit(cacheDir);
      try {
        await cacheGit.fetchCache();
      } catch (err) {
        console.warn("[spawn-child] fetchCache failed (non-fatal):", String(err));
      }
      await cacheGit.cloneFromCache(newWorkspaceDir, parent.remoteUrl);
    } else {
      await simpleGit().raw(["clone", "--local", parent.workspaceDir, newWorkspaceDir]);
      await simpleGit(newWorkspaceDir).raw(["config", "gc.auto", "0"]);
    }

    const branchArgs = ["checkout", "-b", branchName];
    if (startPoint) branchArgs.push(startPoint);
    try {
      await simpleGit(newWorkspaceDir).raw(branchArgs);
    } catch (err) {
      await fs.rm(newSessionDir, { recursive: true, force: true }).catch(() => {});
      throw new ServiceError(400, `Failed to create branch '${branchName}': ${String(err)}`);
    }

    if (githubAuthManager.authenticated) {
      githubAuthManager.configureGitCredentials(newWorkspaceDir);
    }

    sessionManager.track(newSessionId, title, newWorkspaceDir);
    sessionManager.setBranch(newSessionId, branchName);
    sessionManager.setBranchRenamed(newSessionId, true);
    if (parent.remoteUrl) {
      sessionManager.setRemoteUrl(newSessionId, parent.remoteUrl);
    }
  }

  // Common metadata (both paths).
  sessionManager.setParentSession(newSessionId, parentSessionId, opts.spawnedByTurn);
  const modelToSet = opts.model ?? parent.model;
  if (modelToSet) {
    sessionManager.setModel(newSessionId, modelToSet);
  }

  const child = sessionManager.get(newSessionId);
  if (!child) throw new ServiceError(500, "Failed to read back spawned child session");

  // Enqueue the first prompt. `getOrCreate` on the runner registry creates a
  // container-backed runner (in production) or a SessionRunner (in tests);
  // `sendSystemMessage` then either starts the turn directly (when
  // SystemTurnDeps are wired) or enqueues for the next agent start.
  //
  // We don't store the parent's agent id on `SessionInfo` (only the model is
  // persisted). For v1, children inherit `defaultAgentId` unless the caller
  // passes an explicit `--agent`. The parent agent can specify
  // `opts.agent` to override; otherwise the orchestrator's configured
  // default is used. (A future iteration could carry the parent's runner
  // agent id through.)
  const childAgentId: AgentId = opts.agent ?? defaultAgentId;
  const runner = runnerRegistry.getOrCreate(newSessionId, newWorkspaceDir, childAgentId);

  // docs/149 — bring the child to full env-prep parity with the WS path
  // BEFORE the first system turn fires. Otherwise the freshly-spawned
  // container has no agent credentials, a stale OAuth token, no MCP env
  // pushed, and no `agentPinned` flag — so the CLI reports "Not logged in"
  // (or 401 on a rotated token) on its first turn. Subsumes the previous
  // inline `provisionAgentCredentials` + `setAgentId` + `setAgentPinned`
  // block (docs/138). Idempotent; safe to call before every system turn.
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: newSessionId,
      agentId: childAgentId,
      deps: { credentialsDir, credentialStore, sessionManager },
    });
  } else {
    // Tests without credentialsDir / credentialStore still need the pin so
    // `runner.agentId` is meaningful when the agent factory is invoked.
    sessionManager.setAgentId(newSessionId, childAgentId);
    sessionManager.setAgentPinned(newSessionId);
  }

  runner.sendSystemMessage(trimmedPrompt);

  console.log(
    `[spawn-child] Spawned session ${newSessionId} under parent ${parentSessionId}: branch=${branchName} title="${title}"`,
  );

  return {
    session: child,
    sessionId: child.id,
    branch: branchName,
    sessions: sessionManager.list(),
  };
}

// ---- Reads scoped by parent (docs/117) ----

/**
 * Snapshot of a single child session for `shipit session view`. Strictly a
 * read-only projection — the shim cannot mutate the child through this shape.
 */
export interface ChildSessionView {
  id: string;
  title: string;
  branch?: string;
  status: "running" | "idle" | "error";
  queueLength: number;
  parentSessionId: string;
  spawnedAt: string;
  spawnedByTurn?: string;
  prUrl?: string;
  /** Most recent assistant message text. Undefined when the child has not produced one yet. */
  latestAssistantMessage?: string;
}

/**
 * Optional projections wired into `buildChildView` to populate
 * `latestAssistantMessage` and `prUrl`. Phase 3 (docs/117) wired these in:
 * `view` now surfaces the child's most recent assistant text and PR URL when
 * either projection is available, so `shipit session view` / `wait` can give
 * the agent a useful snapshot without forcing it to crack open the child's
 * full chat history.
 */
export interface ChildViewProjections {
  /** ChatHistoryManager — used to pull the child's last assistant message text. */
  chatHistoryManager?: { loadLatestAssistantText(sessionId: string): string | undefined };
  /** PR status poller — used to surface the child's open-PR URL. */
  prStatusPoller?: { getStatus(sessionId: string): { prUrl: string } | undefined };
}

/**
 * List the children spawned under `parentSessionId`. Sorted "this turn first"
 * if `currentTurn` is provided; otherwise most-recently-used first.
 */
export function listSpawnedChildren(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  currentTurn?: string,
  projections: ChildViewProjections = {},
): ChildSessionView[] {
  const children = sessionManager.findChildren(parentSessionId);
  const views = children.map((c) => buildChildView(c, runnerRegistry, projections));
  if (currentTurn) {
    return views.sort((a, b) => {
      const aIn = a.spawnedByTurn === currentTurn ? 0 : 1;
      const bIn = b.spawnedByTurn === currentTurn ? 0 : 1;
      if (aIn !== bIn) return aIn - bIn;
      return b.spawnedAt.localeCompare(a.spawnedAt);
    });
  }
  return views;
}

/**
 * Look up a single child session and verify it's a descendant of `parentSessionId`.
 * Throws 404 (`ServiceError`) when the id doesn't exist *or* when it isn't a
 * direct child of the supplied parent — the orchestrator never tells the shim
 * "wrong parent" because cross-tenancy leakage is the threat that motivates
 * this whole boundary in the first place.
 */
export function getSpawnedChild(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  projections: ChildViewProjections = {},
): ChildSessionView {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  return buildChildView(child, runnerRegistry, projections);
}

/**
 * Verify that `childSessionId` exists and was spawned by `parentSessionId`.
 * Throws a 404 `ServiceError` in either case — the orchestrator deliberately
 * doesn't disambiguate "wrong parent" from "not found" so cross-tenancy
 * existence isn't leaked.
 *
 * Shared with the Phase 3 mutations (`sendChildMessage`, `archiveChild`,
 * `waitForChildIdle`) so they all share one cross-tenancy contract.
 */
function assertChildOfParent(
  sessionManager: SessionManager,
  parentSessionId: string,
  childSessionId: string,
): SessionInfo {
  const child = sessionManager.get(childSessionId);
  if (child?.parentSessionId !== parentSessionId) {
    throw new ServiceError(404, "Spawned session not found");
  }
  return child;
}

function buildChildView(
  child: SessionInfo,
  runnerRegistry: SessionRunnerRegistry,
  projections: ChildViewProjections,
): ChildSessionView {
  const runner = runnerRegistry.get(child.id);
  const view: ChildSessionView = {
    id: child.id,
    title: child.title,
    status: runner?.running ? "running" : "idle",
    queueLength: runner?.queueLength ?? 0,
    parentSessionId: child.parentSessionId ?? "",
    spawnedAt: child.createdAt,
  };
  if (child.branch) view.branch = child.branch;
  if (child.spawnedByTurn) view.spawnedByTurn = child.spawnedByTurn;
  const latest = projections.chatHistoryManager?.loadLatestAssistantText(child.id);
  if (latest) view.latestAssistantMessage = latest;
  const pr = projections.prStatusPoller?.getStatus(child.id);
  if (pr?.prUrl) view.prUrl = pr.prUrl;
  return view;
}

// ---- Phase 3 mutations: message / wait / archive ----

/**
 * Result of `sendChildMessage`. Mirrors the home-screen "send a message" hop:
 * the orchestrator returns immediately after the runner accepts the message
 * (either as a direct turn start or by enqueuing it behind the running turn).
 */
export interface SendChildMessageResult {
  /**
   * Position in the runner's queue (1-based) when the prompt was enqueued
   * because the child was already running, OR `0` when the prompt was
   * accepted directly and the runner started a turn (or queued because no
   * SystemTurnDeps are wired in tests).
   */
  queuePosition: number;
  /** `true` when the message was enqueued behind a running turn; `false` when it started immediately. */
  enqueued: boolean;
}

/**
 * Phase 3 — send a follow-up prompt to a child session the parent itself
 * spawned. Returns the child's queue position so the shim can surface a
 * "queued behind N turns" hint to the agent.
 *
 * Validates the parent → child linkage (cross-tenancy 404) and the prompt
 * shape (non-empty, ≤ 50,000 chars) before reaching for the runner registry,
 * so a malformed call doesn't even create a runner.
 */
export async function sendChildMessage(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  text: string,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
): Promise<SendChildMessageResult> {
  const trimmed = text?.trim();
  if (!trimmed) throw new ServiceError(400, "Message text is required");
  if (trimmed.length > 50_000) {
    throw new ServiceError(400, "Message text exceeds 50,000 characters");
  }
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (!child.workspaceDir) {
    throw new ServiceError(400, "Child session has no workspace");
  }
  if (child.archived) {
    throw new ServiceError(400, "Child session is archived");
  }

  // Resolve or create the runner. `getOrCreate` matches the spawn path —
  // creating a runner here is fine: it just primes the registry and the
  // runner picks the message up on its next start. The child's agent id is
  // not persisted on `SessionInfo`, so we fall back to the orchestrator's
  // default; this matches `spawnChildSession`'s behavior.
  const runner = runnerRegistry.getOrCreate(childSessionId, child.workspaceDir, defaultAgentId);

  // docs/149 — refresh per-session credentials + OAuth + MCP env before the
  // follow-up turn fires. Mirrors the spawn path; idempotent so re-running
  // it on every message is fine. Without this, a child whose OAuth token
  // has been rotated by another session since the first turn 401s here too.
  if (credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: childSessionId,
      agentId: runner.agentId,
      deps: { credentialsDir, credentialStore, sessionManager },
    });
  }

  const wasRunning = runner.running;
  runner.sendSystemMessage(trimmed);
  return {
    queuePosition: wasRunning ? runner.queueLength : 0,
    enqueued: wasRunning,
  };
}

/**
 * Idle predicate used by both the fast-path return and the long-poll inside
 * `waitForChildIdle`. A child counts as idle when no runner exists in the
 * registry (already torn down / never started) OR when the runner reports
 * `running: false && queueLength == 0`.
 */
function isRunnerIdle(runner: SessionRunnerInterface | undefined): boolean {
  if (!runner) return true;
  return !runner.running && runner.queueLength === 0;
}

/** Server-side cap on `shipit session wait --timeout`. */
export const MAX_WAIT_FOR_CHILD_IDLE_MS = 60 * 60 * 1000; // 1 hour

/** Default `shipit session wait --timeout` when the agent omits one. */
export const DEFAULT_WAIT_FOR_CHILD_IDLE_MS = 5 * 60 * 1000; // 5 minutes

export interface WaitForChildIdleResult {
  idle: boolean;
  timedOut: boolean;
  child: ChildSessionView;
}

/**
 * Phase 3 — long-poll until the child's runner reports idle (or timeout).
 * Returns a snapshot view of the child so the agent doesn't need a separate
 * `view` call after wait. The orchestrator caps `timeoutMs` server-side; the
 * shim caps it client-side too as defense-in-depth.
 *
 * Resolves with `timedOut: true` (no rejection) when the wait elapses —
 * the route returns 200 so the shim can decide whether to exit non-zero,
 * matching the "non-zero on timeout" contract from the plan.
 */
export function waitForChildIdle(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
  timeoutMs: number,
  projections: ChildViewProjections = {},
): Promise<WaitForChildIdleResult> {
  // Validate up front so a stale child id fails fast (404) without arming a timer.
  assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  const cappedTimeout = Math.min(Math.max(0, timeoutMs), MAX_WAIT_FOR_CHILD_IDLE_MS);

  const buildResult = (timedOut: boolean): WaitForChildIdleResult => ({
    idle: !timedOut,
    timedOut,
    child: getSpawnedChild(sessionManager, runnerRegistry, parentSessionId, childSessionId, projections),
  });

  const runner = runnerRegistry.get(childSessionId);
  if (isRunnerIdle(runner)) {
    return Promise.resolve(buildResult(false));
  }

  return new Promise<WaitForChildIdleResult>((resolve) => {
    let settled = false;
    const idleListener = (): void => {
      // The runner's `idle` event fires *after* `running` is cleared and the
      // queue is empty (see `SessionRunner.onAgentFinished`). Re-check via
      // the predicate to defend against any future churn in the event order.
      if (settled) return;
      const r = runnerRegistry.get(childSessionId);
      if (!isRunnerIdle(r)) return;
      settled = true;
      clearTimeout(timer);
      runner?.off("idle", idleListener);
      runner?.off("disposed", disposedListener);
      resolve(buildResult(false));
    };
    const disposedListener = (): void => {
      // A disposed runner means the child was archived or otherwise torn
      // down while we were waiting. From the agent's perspective it's idle
      // (there's nothing to wait for), so we resolve as idle rather than
      // timing out.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner?.off("idle", idleListener);
      runner?.off("disposed", disposedListener);
      resolve(buildResult(false));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      runner?.off("idle", idleListener);
      runner?.off("disposed", disposedListener);
      resolve(buildResult(true));
    }, cappedTimeout);

    // Attach AFTER scheduling the timer so a race where the runner emits
    // idle synchronously inside the attach is still observed.
    runner?.on("idle", idleListener);
    runner?.on("disposed", disposedListener);
  });
}

/**
 * Phase 3 — pre-archive validation. Confirms the child belongs to the
 * caller's parent AND is not currently running, then returns the resolved
 * child + runner-presence flag so the route can pass them to the existing
 * `archiveSession` service.
 *
 * Why not call `archiveSession` directly here? Because that lives in
 * `session.ts`, and `session.ts` re-exports the child-sessions service —
 * importing back from there would form a module cycle. Splitting the work
 * (validation here, archive at the route) keeps the import graph tidy and
 * lets `archiveSession`'s container/volume cleanup hooks stay in one place.
 */
export function assertArchivableChild(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  childSessionId: string,
): SessionInfo {
  const child = assertChildOfParent(sessionManager, parentSessionId, childSessionId);
  if (child.archived) {
    throw new ServiceError(400, "Child session is already archived");
  }
  const runner = runnerRegistry.get(childSessionId);
  if (runner?.running) {
    throw new ServiceError(
      409,
      "Cannot archive a running child session. Wait for it to finish (try `shipit session wait`) or interrupt it from the UI.",
    );
  }
  return child;
}
