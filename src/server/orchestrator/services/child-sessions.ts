/**
 * Agent-spawned child sessions (docs/117).
 *
 * Extracted from `session.ts` to keep the parent-session module focused on
 * reads/mutations against a single session. The child-session feature is its
 * own sub-feature: a parent session can spawn sibling sessions under it, each
 * with its own clone, branch, chat history, and runner.
 */

import simpleGit from "simple-git";
import type { SessionManager } from "../sessions.js";
import type { SessionRunnerRegistry, SessionRunnerInterface } from "../session-runner.js";
import type { SessionInfo, AgentId } from "../../shared/types.js";
import type { CredentialStore } from "../credential-store.js";
import type { ProviderAccountManager } from "../provider-account-manager.js";
import type { SessionContainerManager } from "../session-container.js";
import { ContainerSessionRunner } from "../container-session-runner.js";
import { prepareSessionAgentEnvironment } from "../session-agent-env.js";
import { graduateSession, type GraduateSessionDeps } from "./graduate-session.js";
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
 * docs/162 — lower per-turn cap for Ops `--shipit-source` fix-session spawns.
 * A ShipIt fix session is heavier and higher-stakes than a generic fan-out
 * child (it claims the ShipIt repo and opens a PR against it), so we bound how
 * many an Ops turn can kick off. Overridable via `MAX_SHIPIT_FIX_SESSIONS_PER_TURN`
 * (positive integer); the compile-time default is `2`. Read once at module init.
 */
export const DEFAULT_MAX_SHIPIT_FIX_SESSIONS_PER_TURN =
  readPositiveIntEnv("MAX_SHIPIT_FIX_SESSIONS_PER_TURN") ?? 2;

export interface SpawnChildSessionOptions {
  /** The required initial user prompt that the spawned session's agent runs. */
  prompt: string;
  /** Session title. Defaults to a slug derived from `prompt`. */
  title?: string;
  /**
   * Optional override for the text used to name the session (placeholder slice
   * + AI naming) when no explicit `title` is given. Defaults to `prompt`. Set
   * this when `prompt` is a machine-wrapped packet (e.g. the Ops ShipIt-fix
   * incident packet) so the session is named after the actual work rather than
   * the wrapper's boilerplate header. The agent still runs the full `prompt`.
   */
  namingText?: string;
  /**
   * Git ref to branch off. When omitted, the child is branched off the
   * freshly-fetched `origin/main` (or `origin/HEAD` / `origin/master`) of
   * the parent's repo — matching what a manual new session would do — so
   * the child's "Changes vs main" diff doesn't inherit the parent's WIP.
   *
   * When provided, this is passed verbatim to `git reset --hard <base>` in
   * the child's workspace, so any value `git` accepts there is allowed
   * (commit hash, `origin/main`, a tag, etc.).
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
  /**
   * docs/162 — claim the child's workspace from this repo instead of the
   * parent's `remoteUrl`. Used by the Ops "fix ShipIt itself" spawn, where the
   * parent is an Ops session with no ShipIt remote of its own. The repo must
   * already be registered + ready in the repo store (the caller ensures that).
   * Combine with `base` to pin the child to the exact inspected source commit.
   */
  repoUrlOverride?: string;
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
 * the parent's repo but gets its own clone, branch, chat history, and
 * runner — exactly like a session created from the UI. Spawn is *only* a
 * thin wrapper around the home-screen claim flow: it requires the parent
 * to have a registered, ready remote URL and delegates workspace
 * provisioning to `ClaimSessionService`. There is no local-clone fallback
 * — production sessions always come from a registered repo, and tests
 * must register one too.
 *
 * The agent never reaches this function directly; the call chain is:
 *   `shipit session create` (shim)
 *   → worker `/agent-ops/session/create`
 *   → orchestrator `POST /api/sessions/:parentId/spawn`
 *   → `spawnChildSession`.
 *
 * Quotas are enforced fail-closed (the orchestrator returns 429 / ServiceError
 * before any disk work happens). The first prompt is dispatched on the child's
 * runner via `runner.dispatch` so it kicks off the agent the moment the
 * runner is ready — matching the home-screen "send a message" behaviour
 * without needing a WS to be attached.
 */
export async function spawnChildSession(
  sessionManager: SessionManager,
  runnerRegistry: SessionRunnerRegistry,
  claimService: ClaimSessionService,
  parentSessionId: string,
  opts: SpawnChildSessionOptions,
  defaultAgentId: AgentId,
  credentialsDir: string | undefined,
  credentialStore: CredentialStore | undefined,
  providerAccountManager: ProviderAccountManager | undefined,
  graduationDeps: GraduateSessionDeps,
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

  // The child's branch is always a generated `shipit/<slug>` — the agent
  // cannot pick it (dropping `--branch` is intentional: agent-supplied names
  // drifted outside the `shipit/` namespace and broke our branch conventions).
  // Title precedence: explicit `opts.title` wins; otherwise the AI naming
  // flow inside `graduateSession` picks one. We don't pre-set a slice here —
  // graduateSession's placeholder logic does that.
  const explicitTitle = opts.title?.trim();

  // Spawn requires the parent to be backed by a registered, ready remote.
  // We route the workspace creation through the same warm-pool-aware claim
  // path the home-screen "new session" flow uses (`claimSessionService`) so
  // the child gets a workspace branched off freshly-fetched `origin/main` —
  // identical shape to a manual new session, with no chance of inheriting
  // the parent's WIP. There is no local-only fallback: in production every
  // session is created from a registered repo, and tests must register one
  // too (use `claimGraduatedParent` / the home-screen claim endpoint).
  // docs/162 — an Ops fix spawn claims the ShipIt source repo (the override)
  // rather than the parent's own remote (an Ops session has none).
  const claimUrl = opts.repoUrlOverride ?? parent.remoteUrl;
  if (!claimUrl) {
    throw new ServiceError(
      400,
      "Cannot spawn a child session: the parent has no remote URL. Spawn requires the parent's repo to be registered.",
    );
  }
  // `forceFetch: true` bypasses the docs/145 prefetch-skip optimization so the
  // child always branches off a freshly-fetched `origin/main`. The home-screen
  // claim accepts up to ~6 minutes of bare-cache staleness for latency, but a
  // child spawned moments after a merge must see the merged commit on `main`,
  // not the pre-merge snapshot the cache happens to hold.
  const claimed = await claimService.claim(claimUrl, { forceFetch: true });
  const newSessionId = claimed.sessionId;
  const newWorkspaceDir = claimed.workspaceDir;

  // The claim cut a `shipit/<random>` branch off freshly-fetched origin/HEAD.
  // That's already the shape we want for the child's branch, so we adopt it
  // verbatim instead of renaming.
  let branchName: string;
  try {
    branchName = (await simpleGit(newWorkspaceDir).raw(["branch", "--show-current"])).trim();
    if (!branchName) {
      throw new Error("claim produced an empty branch name");
    }
  } catch (err) {
    throw new ServiceError(500, `Failed to read claimed branch: ${String(err)}`);
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

  // graduate-session.ts owns the warm → active transition (docs/156).
  // Do not inline setWarm / track / setBranchRenamed / scheduleSessionNaming
  // / repoStore.touch / sseBroadcast("session_list") here.
  //
  // skipBranchRename: true because `POST /spawn`'s response body returns
  // `branch` synchronously to the CLI shim — a delayed AI branch rename
  // would make the printed value stale. AI naming still runs (when the
  // agent didn't pass `--title`) and updates the title; the branch row
  // keeps the claim-time `shipit/<random>` value.
  // Name the session after `namingText` (the human diagnosis) when supplied,
  // so an Ops fix spawn isn't named after the incident-packet boilerplate it
  // dispatches. Empty/whitespace falls back to `trimmedPrompt` in graduate.
  const namingText = opts.namingText?.trim();
  graduateSession(graduationDeps, {
    sessionId: newSessionId,
    userText: trimmedPrompt,
    ...(namingText ? { namingText } : {}),
    agentId: opts.agent ?? parent.agentId ?? defaultAgentId,
    skipBranchRename: true,
    ...(explicitTitle ? { explicitTitle } : {}),
    ...((opts.model ?? parent.model) ? { model: (opts.model ?? parent.model)! } : {}),
    parentSessionId,
    ...(opts.spawnedByTurn ? { spawnedByTurn: opts.spawnedByTurn } : {}),
  });

  const child = sessionManager.get(newSessionId);
  if (!child) throw new ServiceError(500, "Failed to read back spawned child session");

  // Enqueue the first prompt. `getOrCreate` on the runner registry creates a
  // container-backed runner (in production) or a SessionRunner (in tests);
  // `runner.dispatch` then either starts the turn directly (when
  // SystemTurnDeps are wired) or enqueues for the next agent start.
  //
  // Precedence: explicit `opts.agent` (e.g. `--agent` on the shim) wins;
  // otherwise inherit the parent's pinned `agentId` so a child spawned from
  // a Codex session stays on Codex (the orchestrator's `defaultAgentId` is
  // global and may point at a provider the user hasn't authenticated). Fall
  // back to `defaultAgentId` only when the parent hasn't been pinned yet
  // (fresh parent, no turn taken).
  const childAgentId: AgentId = opts.agent ?? parent.agentId ?? defaultAgentId;
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
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  } else {
    // Tests without credentialsDir / credentialStore still need the pin so
    // `runner.agentId` is meaningful when the agent factory is invoked.
    sessionManager.setAgentId(newSessionId, childAgentId);
    sessionManager.setAgentPinned(newSessionId);
  }

  runner.dispatch({ text: trimmedPrompt });

  console.log(
    `[spawn-child] Spawned session ${newSessionId} under parent ${parentSessionId}: branch=${branchName} title="${child.title}"`,
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
 * How long `sendChildMessage` waits for a freshly-booted container's worker to
 * become ready before it gives up and reports the truthful outcome. The wait
 * is a backstop only — `prepareSessionAgentEnvironment` already awaits worker
 * readiness on the credentialed path — so it's generous but finite. On timeout
 * we still dispatch (the dispatched turn's own `_startAgentViaProxy` awaits
 * readiness too), so a slow-but-eventual boot is not a false failure; the wait
 * exists so a boot *failure* (which disposes the runner) is observed before we
 * ack, not after.
 */
const CHILD_MESSAGE_WORKER_READY_TIMEOUT_MS = 30_000;

/**
 * True when `containerManager` is tracking a live (running or starting)
 * container for the session. A runner can outlive its container in the
 * registry — an idle-eviction race, a missed Docker `die` event, a daemon
 * restart, or an external `docker rm` all leave the runner pointed at a dead
 * worker URL. `getOrCreate` would then hand that stale runner straight back,
 * and `dispatch()` would fire a turn into the void. Used to detect that case
 * so the stale runner can be torn down and re-created (booting a fresh
 * container via the registry factory).
 */
function hasLiveContainer(
  containerManager: SessionContainerManager,
  sessionId: string,
): boolean {
  const sc = containerManager.get(sessionId);
  return !!sc && (sc.status === "running" || sc.status === "starting");
}

/**
 * Phase 3 — send a follow-up prompt to a child session the parent itself
 * spawned. Returns the child's queue position so the shim can surface a
 * "queued behind N turns" hint to the agent.
 *
 * Validates the parent → child linkage (cross-tenancy 404) and the prompt
 * shape (non-empty, ≤ 50,000 chars) before reaching for the runner registry,
 * so a malformed call doesn't even create a runner.
 *
 * Container resume: an agent-driven follow-up must honor the idle-enforcer's
 * "Send a message to resume" contract just like a browser viewer reopening the
 * tab does. When the child's container has been idle-reaped, two states are
 * possible: (a) the runner was disposed too (the common idle-enforcer path) —
 * `getOrCreate` then builds a fresh runner and the registry factory boots a new
 * container; or (b) the runner survives in the registry while its container is
 * gone (eviction race / missed `die` event / external `docker rm`) — here
 * `getOrCreate` returns the stale, container-less runner, so we dispose it
 * first to force a fresh boot. Either way the turn is only acked as
 * started/queued once a live worker holds it; if the container fails to boot we
 * fail loudly rather than reporting a phantom "starting turn".
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
  providerAccountManager?: ProviderAccountManager,
  containerManager?: SessionContainerManager | null,
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

  // If a runner is lingering in the registry but its container has already
  // been reaped, it points at a dead worker — dispatching into it silently
  // fails (the symptom: `delivered: starting turn` with no agent reaction).
  // Tear it down so the `getOrCreate` below builds a fresh runner and the
  // registry factory boots a new container. `force` because a stale runner may
  // still believe a turn is `running` even though the worker that ran it is
  // gone. Only meaningful in container mode (a `containerManager` is wired).
  if (containerManager) {
    const stale = runnerRegistry.get(childSessionId);
    if (stale && !hasLiveContainer(containerManager, childSessionId)) {
      runnerRegistry.dispose(childSessionId, { force: true });
    }
  }

  // Resolve or create the runner. `getOrCreate` matches the spawn path:
  // creating a runner here primes the registry, and — in container mode — the
  // registry factory boots a container for a brand-new runner (so an
  // idle-reaped or never-started session is resumed, not silently dropped).
  // Prefer the child's pinned `agentId` (set by `spawnChildSession` /
  // first-turn provisioning) so a Codex child stays on Codex even if the
  // orchestrator's `defaultAgentId` points elsewhere. Only newly-created,
  // never-run children are missing `agentId`, in which case the default is the
  // right fallback.
  const runner = runnerRegistry.getOrCreate(childSessionId, child.workspaceDir, child.agentId ?? defaultAgentId);

  // docs/149 — refresh per-session credentials + OAuth + MCP env before the
  // follow-up turn fires. Mirrors the spawn path; idempotent so re-running
  // it on every message is fine. Without this, a child whose OAuth token
  // has been rotated by another session since the first turn 401s here too.
  // Skipped while the agent is already running — `runner.dispatch` will
  // enqueue, and the env-prep of the next-starting turn covers it.
  const wasRunning = runner.running;
  if (!wasRunning && credentialsDir && credentialStore) {
    await prepareSessionAgentEnvironment(runner, {
      sessionId: childSessionId,
      agentId: runner.agentId,
      deps: {
        credentialsDir,
        credentialStore,
        sessionManager,
        ...(providerAccountManager ? { providerAccountManager } : {}),
      },
    });
  }
  // Truthful ack: in container mode, only report a started/queued turn once a
  // live worker actually exists to run it. For a fresh runner the registry
  // factory boots the container asynchronously and resolves `whenWorkerReady`
  // on success — or disposes the runner on boot failure. Wait (bounded) for
  // that to settle. The credentialed env-prep above already awaits readiness,
  // so on the common path this resolves immediately; the explicit wait covers
  // the no-credentials path and makes the boot-failure case observable here.
  if (runner instanceof ContainerSessionRunner) {
    await Promise.race([
      runner.whenWorkerReady(),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, CHILD_MESSAGE_WORKER_READY_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
  }
  if (runner.disposed) {
    // The container failed to boot (the factory disposed the runner). Fail
    // loudly instead of returning a phantom "starting turn" the agent will
    // wait on forever.
    throw new ServiceError(503, "Could not resume the session container; the message was not delivered.");
  }

  runner.dispatch({ text: trimmed });
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
