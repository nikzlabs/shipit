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
import type { SessionRunnerRegistry } from "../session-runner.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import type { SessionInfo, AgentId } from "../../shared/types.js";
import { generateBranchPrefix } from "../git-utils.js";
import { provisionAgentCredentials } from "../session-credentials.js";
import { ServiceError } from "./types.js";

/** Default per-parent quota for active spawned child sessions. */
export const DEFAULT_MAX_ACTIVE_SPAWNED_SESSIONS = 16;

/** Default per-turn quota for newly-spawned child sessions. */
export const DEFAULT_MAX_SPAWNED_SESSIONS_PER_TURN = 4;

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
  parentSessionId: string,
  opts: SpawnChildSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
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

  // Compute the child's session dir.
  const crypto = await import("node:crypto");
  const newSessionId = crypto.randomUUID();
  const newSessionDir = path.join(sessionsRoot, newSessionId);
  const newWorkspaceDir = path.join(newSessionDir, "workspace");
  await fs.mkdir(newSessionDir, { recursive: true });

  // Resolve the branch start point. When the caller omits `--base`, we use the
  // parent's current HEAD so the child sees the parent's *committed* state.
  // Uncommitted/unstaged work in the parent's working tree is intentionally
  // not visible — the child has its own clone.
  let startPoint = opts.base?.trim();
  if (!startPoint) {
    try {
      const parentHead = await simpleGit(parent.workspaceDir).revparse(["HEAD"]);
      startPoint = parentHead.trim();
    } catch {
      // Empty repo or detached HEAD with no commits — let `git checkout -b`
      // fall back to the current branch tip.
      startPoint = undefined;
    }
  }

  // Clone path mirrors `forkSession`: bare-cache → workspace when the parent
  // has a remote; local clone of the parent's session dir otherwise.
  if (parent.remoteUrl) {
    const cacheDir = getBareCacheDir(parent.remoteUrl);
    const cacheGit = createRepoGit(cacheDir);
    try {
      await cacheGit.fetchCache();
    } catch (err) {
      // Non-fatal: a stale bare cache should not block spawn. The branch is
      // cut from `startPoint`, which we resolved against the parent's
      // workspace clone (or `git checkout -b` falls back to current HEAD).
      console.warn("[spawn-child] fetchCache failed (non-fatal):", String(err));
    }
    await cacheGit.cloneFromCache(newWorkspaceDir, parent.remoteUrl);
  } else {
    // Local-repo fallback (used by integration tests that don't set up a remote).
    await simpleGit().raw(["clone", "--local", parent.workspaceDir, newWorkspaceDir]);
    await simpleGit(newWorkspaceDir).raw(["config", "gc.auto", "0"]);
  }

  // Cut the child's branch off `startPoint` (or HEAD when undefined).
  const branchArgs = ["checkout", "-b", branchName];
  if (startPoint) branchArgs.push(startPoint);
  try {
    await simpleGit(newWorkspaceDir).raw(branchArgs);
  } catch (err) {
    // Best-effort cleanup; the next garbage sweep will reclaim the empty dir.
    await fs.rm(newSessionDir, { recursive: true, force: true }).catch(() => {});
    throw new ServiceError(400, `Failed to create branch '${branchName}': ${String(err)}`);
  }

  if (githubAuthManager.authenticated) {
    githubAuthManager.configureGitCredentials(newWorkspaceDir);
  }

  // Persist the session row + parent linkage + model. We deliberately do NOT
  // mark the session warm — it's an explicit, user-visible session from the
  // moment it appears in the sidebar.
  sessionManager.track(newSessionId, title, newWorkspaceDir);
  sessionManager.setBranch(newSessionId, branchName);
  // Branch is already a deliberate name (either user-supplied or a generated
  // prefix) — we don't need the warm-session "rename on first message" dance.
  sessionManager.setBranchRenamed(newSessionId, true);
  if (parent.remoteUrl) {
    sessionManager.setRemoteUrl(newSessionId, parent.remoteUrl);
  }
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

  // docs/138 — the first turn on a child session is kicked off by
  // `sendSystemMessage` below, which bypasses the WS `runAgentWithMessage`
  // handler that normally pins the agent and copies its credential subtree
  // into the per-session credentials dir. Without this, the freshly-spawned
  // container has an empty `/credentials/sessions/<id>` and the Claude CLI
  // reports "Not logged in · Please run /login" on its first turn. Mirror
  // the WS handler's first-turn block here so the spawn path is at parity.
  if (runner instanceof ContainerSessionRunner && credentialsDir) {
    try {
      provisionAgentCredentials(credentialsDir, newSessionId, childAgentId);
    } catch (err) {
      console.warn("[spawn-child] credentials provisioning failed:", String(err));
    }
  }
  sessionManager.setAgentId(newSessionId, childAgentId);
  sessionManager.setAgentPinned(newSessionId);

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
 * List the children spawned under `parentSessionId`. Sorted "this turn first"
 * if `currentTurn` is provided; otherwise most-recently-used first.
 */
export function listSpawnedChildren(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  parentSessionId: string,
  currentTurn?: string,
): ChildSessionView[] {
  const children = sessionManager.findChildren(parentSessionId);
  const views = children.map((c) => buildChildView(c, runnerRegistry));
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
): ChildSessionView {
  const child = sessionManager.get(childSessionId);
  if (child?.parentSessionId !== parentSessionId) {
    throw new ServiceError(404, "Spawned session not found");
  }
  return buildChildView(child, runnerRegistry);
}

function buildChildView(
  child: SessionInfo,
  runnerRegistry: SessionRunnerRegistry,
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
  // `latestAssistantMessage` is intentionally omitted in v1: pulling it from
  // chat history would require importing ChatHistoryManager here and tracking
  // a "most recent assistant text" projection. The shim's plain-text rendering
  // degrades gracefully (the field just doesn't print).
  return view;
}
