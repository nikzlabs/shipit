/**
 * Git API routes.
 * Handles: git log, branches, remotes, commit, push, pull, diff, rollback, merge, workspace-state.
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BranchAutoResetCard, PrStatusSummary, WsServerMessage } from "../shared/types.js";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitChatCard } from "./chat-card-persistence.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";

import {
  getGitLog,
  getGitRemotes,
  getGitBranches,
  getTurnDiff,
  getDiffVsBranch,
  getWorkspaceState,
  gitRollback,
  setGitRemote,
  gitPush,
  gitPull,
  mergeSession,
  rebaseAbort,
  runRebaseFlow,
  repoDefaultBranch,
  ServiceError,
} from "./services/index.js";
import { detectAndReArmResetSession } from "./services/pr-rearm.js";
import {
  buildManualResetAgentNotice,
  resetBranchToBaseExplicit,
  type ExplicitResetOutcome,
} from "./services/pre-turn-reset.js";
import { getErrorMessage } from "./validation.js";

interface ExplicitResetPresentationDeps {
  runner: SessionRunnerInterface | undefined;
  chatHistoryManager: ChatHistoryManager;
  sessionId: string;
  prStatus: PrStatusSummary | null | undefined;
  /**
   * planning#279 — durable PR identity for the card when the live snapshot is gone.
   * `PrStatusPoller.reArm` nulls `prStatus` on any merged session that gained
   * new work, which is the ordinary state of a session needing a forced reset —
   * and without a fallback the destructive move would leave NO transcript
   * record, which is the one thing the forced path cannot afford. Same durable
   * source `resolveResetBase` uses (`session.previousMergedPr`).
   */
  fallbackPr?: { prNumber: number; prUrl: string } | undefined;
  outcome: ExplicitResetOutcome;
  reArmResetSession: () => Promise<void>;
}

/**
 * docs/221 — park the agent-facing notice for a reset the USER asked for.
 *
 * The "Sync with `<base>`" menu item lands on THIS route (not `/git/rebase`)
 * once the PR has merged, and the agent was as unaware of it as it was of a
 * manual rebase. Unlike the docs/218 pre-turn reset, nothing here can prepend to
 * a prompt — there is no turn — so the sentence is parked for the next one.
 *
 * `runner.running` is the discriminator between this route's two callers. The
 * `shipit branch reset-to-base` shim can only run from inside an agent turn, and
 * the agent reads the outcome in its own tool result, so telling it again next
 * turn would be noise. Anything arriving with no turn in flight — the menu click,
 * or a human running the shim in the terminal panel — is news to the agent.
 *
 * Best-effort: the reset already succeeded and is recorded for the user, so a
 * failed notice write must not turn that into a reported failure.
 */
export function recordManualResetAgentNotice(deps: {
  setPendingAgentNotice: (sessionId: string, notice: string) => void;
  runner: SessionRunnerInterface | undefined;
  sessionId: string;
  outcome: ExplicitResetOutcome;
  prNumber?: number;
}): void {
  if (deps.outcome.outcome !== "reset" || !deps.outcome.base) return;
  if (deps.runner?.running) return;
  try {
    deps.setPendingAgentNotice(
      deps.sessionId,
      buildManualResetAgentNotice({
        base: deps.outcome.base,
        fromSha: deps.outcome.fromSha,
        toSha: deps.outcome.toSha,
        prNumber: deps.prNumber,
      }),
    );
  } catch (err) {
    console.error("[reset-to-base] recording the agent notice failed:", getErrorMessage(err));
  }
}

/**
 * docs/239 + docs/218 — an explicit self-wake reset must settle the same UI
 * state as the checked composer flow. The git move alone is not enough: the
 * composer eligibility signal is transient, the merged PR card must re-arm,
 * and the destructive move needs a durable transcript record.
 */
export async function presentExplicitResetSuccess(
  deps: ExplicitResetPresentationDeps,
): Promise<void> {
  if (deps.outcome.outcome === "refused") return;

  deps.runner?.emitMessage({
    type: "reset_eligible",
    sessionId: deps.sessionId,
    eligible: false,
  });
  await deps.reArmResetSession();

  const pr = deps.prStatus ?? deps.fallbackPr;
  if (deps.outcome.outcome !== "reset" || !deps.runner || !pr
    || !deps.outcome.base || !deps.outcome.fromSha || !deps.outcome.toSha) return;

  const card: BranchAutoResetCard = {
    cardId: `branch-reset-${randomUUID()}`,
    base: deps.outcome.base,
    prNumber: pr.prNumber,
    prUrl: pr.prUrl,
    fromSha: deps.outcome.fromSha,
    toSha: deps.outcome.toSha,
    createdAt: new Date().toISOString(),
    ...(deps.outcome.forced
      ? { forced: true, ...(deps.outcome.forceReason ? { forceReason: deps.outcome.forceReason } : {}) }
      : {}),
  };
  emitChatCard(
    deps.runner,
    { type: "branch_auto_reset_card", sessionId: deps.sessionId, card },
    { role: "assistant", text: "", branchAutoReset: card },
    { chatHistoryManager: deps.chatHistoryManager, sessionId: deps.sessionId },
  );
}

export async function registerGitRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager } = deps;

  // POST /api/sessions/:id/branch/reset-to-base — docs/239. Backs
  // `shipit branch reset-to-base`: the explicit, agent-invoked mode over the
  // docs/218 reset core, used as the first step of a self-merge wake turn.
  // Container-reachable so the shim can broker it; own-session scoped (the worker
  // injects the caller's id), and the full safety gate still applies — the arming
  // is the consent, not a bypass.
  app.post<{ Params: { id: string }; Body: { force?: boolean; reason?: string } }>(
    "/api/sessions/:id/branch/reset-to-base",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const sessionId = request.params.id;
      const prStatus = sessionManager.getPrStatus(sessionId);
      // planning#279 — the break-glass. A force with no stated reason is not a
      // break-glass, it is a silent bypass: the reason IS what replaces the gate
      // this mode removes, so it is validated here rather than trusted from the
      // shim (the HTTP route is container-reachable in its own right).
      const force = request.body?.force === true;
      const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
      if (force && !reason) {
        reply.code(400).send({
          outcome: "refused",
          reason: "A forced reset requires --reason: it bypasses the check that this branch "
            + "carries nothing beyond its merged PR, so the transcript record of WHY is the "
            + "only account of the override.",
        });
        return;
      }
      const outcome = await resetBranchToBaseExplicit(
        {
          getSession: (id: string) => sessionManager.get(id),
          getPrStatus: (id: string) => sessionManager.getPrStatus(id),
          createGitManager,
        },
        sessionId,
        dir,
        ...(force ? [{ force: { reason } }] as const : []),
      );
      const previous = sessionManager.get(sessionId)?.previousMergedPr;

      recordManualResetAgentNotice({
        setPendingAgentNotice: (id, notice) => sessionManager.setPendingAgentNotice(id, notice),
        runner: deps.runnerRegistry.get(sessionId),
        sessionId,
        outcome,
        prNumber: prStatus?.prNumber ?? previous?.number,
      });

      await presentExplicitResetSuccess({
        runner: deps.runnerRegistry.get(sessionId),
        chatHistoryManager: deps.chatHistoryManager,
        sessionId,
        prStatus,
        fallbackPr: previous ? { prNumber: previous.number, prUrl: previous.url } : undefined,
        outcome,
        reArmResetSession: async () => {
          if (!deps.prStatusPoller) return;
          await detectAndReArmResetSession({
            deps: {
              sessionManager,
              prStatusPoller: deps.prStatusPoller,
              createGitManager,
              sseBroadcast: deps.sseBroadcast,
            },
            sessionId,
            sessionDir: dir,
            emit: (message: WsServerMessage) => deps.runnerRegistry.get(sessionId)?.emitMessage(message),
            skipFetch: true,
          });
        },
      });
      return outcome;
    },
  );

  // GET /api/sessions/:id/git/log — git commit log
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/log", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return { commits: await getGitLog(git) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get git log: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/git/diff — turn diff between two commits
  app.get<{ Params: { id: string }; Querystring: { from: string; to: string } }>(
    "/api/sessions/:id/git/diff",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const { from, to } = request.query;
      if (!from || !to) {
        reply.code(400).send({ error: "Query params 'from' and 'to' are required" });
        return;
      }
      try {
        const git = createGitManager(dir);
        return await getTurnDiff(git, from, to);
      } catch (err) {
        reply.code(500).send({ error: `Failed to get diff: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/git/diff-vs-branch — diff HEAD vs a base branch (for PR diffs)
  app.get<{ Params: { id: string }; Querystring: { base?: string } }>(
    "/api/sessions/:id/git/diff-vs-branch",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      // No explicit base → the repo's own default branch, not a hard-coded
      // "main" (which is simply unresolvable on a `master`/`trunk` repo).
      const baseBranch = request.query.base
        || repoDefaultBranch(deps.repoStore, sessionManager.get(request.params.id)?.remoteUrl);
      try {
        const git = createGitManager(dir);
        return await getDiffVsBranch(git, baseBranch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to get diff: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/git/remotes — git remotes
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/remotes", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return { remotes: await getGitRemotes(git) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get remotes: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/git/branches — git branches
  app.get<{ Params: { id: string } }>("/api/sessions/:id/git/branches", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return await getGitBranches(git);
    } catch (err) {
      reply.code(500).send({ error: `Failed to get branches: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/sessions/:id/workspace-state — git log + file tree (combined)
  app.get<{ Params: { id: string } }>("/api/sessions/:id/workspace-state", async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const git = createGitManager(dir);
      return await getWorkspaceState(git, dir);
    } catch (err) {
      reply.code(500).send({ error: `Failed to get workspace state: ${getErrorMessage(err)}` });
    }
  });

  // POST /api/sessions/:id/git/rollback — rollback to a commit
  app.post<{ Params: { id: string }; Body: { commitHash: string } }>(
    "/api/sessions/:id/git/rollback",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await gitRollback(git, request.body.commitHash);
        // A rollback rewrites the working tree from the orchestrator, so the
        // session's `shipit.yaml` / compose file may now describe a different
        // stack. Re-read it rather than relying on the in-container file
        // watcher to notice (same reasoning as the rebase path). Best-effort —
        // never fail a completed rollback on a config re-read.
        try {
          deps.runnerRegistry.get(request.params.id)?.reevaluateWorkspaceConfig?.();
        } catch (err) {
          console.error("[rollback] config re-evaluation failed:", getErrorMessage(err));
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rollback failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/remotes — add/update a remote
  app.post<{ Params: { id: string }; Body: { name: string; url: string } }>(
    "/api/sessions/:id/git/remotes",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await setGitRemote(git, sessionManager, request.params.id, request.body.name, request.body.url);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set remote: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/push — git push
  app.post<{ Params: { id: string }; Body: { remote?: string; branch?: string } }>(
    "/api/sessions/:id/git/push",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await gitPush(git, deps.githubAuthManager, request.body?.remote, request.body?.branch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Push failed: ${getErrorMessage(err)}`, branch: "" };
      }
    },
  );

  // POST /api/sessions/:id/git/pull — git pull
  app.post<{ Params: { id: string }; Body: { remote?: string; branch?: string } }>(
    "/api/sessions/:id/git/pull",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await gitPull(git, deps.githubAuthManager, request.body?.remote, request.body?.branch);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Pull failed: ${getErrorMessage(err)}` };
      }
    },
  );

  // POST /api/sessions/:id/git/merge — merge a branch into this session
  app.post<{ Params: { id: string }; Body: { sourceSessionId: string } }>(
    "/api/sessions/:id/git/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        return await mergeSession(
          sessionManager, createGitManager, dir, request.body.sourceSessionId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to merge: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/rebase — rebase onto base branch (with agent-driven conflict resolution)
  app.post<{ Params: { id: string }; Body: { baseBranch: string } }>(
    "/api/sessions/:id/git/rebase",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const baseBranch = request.body?.baseBranch;
      if (!baseBranch) {
        reply.code(400).send({ error: "baseBranch is required" });
        return;
      }

      const sessionId = request.params.id;
      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(404).send({ error: "No active session runner — start the session first" });
        return;
      }

      // docs/146 — user-driven rebase is explicit re-engagement; reset the
      // auto-resolve attempt budget so a previous exhaustion doesn't bleed
      // into the user's new attempt.
      deps.prStatusPoller?.autoConflictResolveManager?.resetForUserActivity(sessionId);

      try {
        const git = createGitManager(dir);

        // Drive the entire flow asynchronously: emit WS events as it progresses
        // (rebase_started, rebase_conflicts, rebase_complete) and run the agent
        // resolution loop on conflicts. The HTTP response only signals that the
        // flow was started — the client tracks state via WS events.
        const flowPromise = runRebaseFlow(
          {
            git,
            githubAuthManager: deps.githubAuthManager,
            runner,
            sessionManager: deps.sessionManager,
            chatHistoryManager: deps.chatHistoryManager,
            usageManager: deps.usageManager,
            agentFactory: deps.agentFactory,
            sseBroadcast: deps.sseBroadcast,
            // docs/221 — manual "Sync with <base>" records a persisted card; the
            // automatic conflict-resolve-on-idle path leaves this unset.
            recordSyncCard: true,
            // planning#369 — the driver notifies the poller itself after a push
            // that landed, so the "Merge conflicts" chip clears in seconds
            // instead of surviving up to a slow tick (or forever, with the
            // polling gate closed). See `RebaseDriverDeps.prStatusPoller`.
            prStatusPoller: deps.prStatusPoller,
          },
          baseBranch,
        );

        // Don't await: respond immediately, but log async failures.
        flowPromise.catch((err: unknown) => {
          console.error(`[rebase] flow failed for session ${sessionId}:`, err);
          // Emit aborted (with the reason) so the UI both clears its progress
          // state and surfaces the failure — without `reason` the old code
          // silently bounced the banner from "in_progress" back to "idle" and
          // the user had no way to tell what went wrong.
          runner.emitMessage({ type: "rebase_aborted", sessionId: runner.sessionId, reason: getErrorMessage(err) });
        });

        return { status: "started" };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rebase failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/git/rebase/abort — abort an in-progress rebase
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/git/rebase/abort",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        // Kill the agent if it's mid-resolution — otherwise the rebase driver
        // would resume and try to call `git rebase --continue` against a tree
        // that's already been aborted.
        const runner = deps.runnerRegistry.get(request.params.id);
        const agent = runner?.getAgent();
        if (agent) {
          agent.kill();
          // planning#338 — while a rebase FLOW holds the session, this agent is a
          // resolution turn the driver is awaiting. Clearing the slot below
          // makes the container relay drop its terminal events as stale, so
          // without an explicit settle the awaited turn never resolves and the
          // flow's session hold wedges every later message in the queue.
          // `superseded` settles it as interrupted; the driver then rejects,
          // its own abort no-ops against ours, and its `finally` releases the
          // hold + queue. Guarded on the flag: for an ordinary (non-flow)
          // agent, the kill's own `done` teardown is the correct path.
          if (runner?.systemTurnInProgress) agent.emit("superseded");
          if (runner) {
            runner.setAgent(null);
            runner.running = false;
          }
        }

        const git = createGitManager(dir);
        // planning#338 — the settle above lets the driver's abort race ours; whichever
        // runs second sees "no rebase in progress". That is success, not failure:
        // only surface an error when the rebase genuinely survived the abort.
        try {
          await rebaseAbort(git);
        } catch (abortErr) {
          const stillInProgress = await git.isRebaseInProgress().catch(() => true);
          if (stillInProgress) throw abortErr;
        }
        if (runner) {
          runner.emitMessage({ type: "rebase_aborted", sessionId: runner.sessionId });
        }
        return { status: "aborted" };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Rebase abort failed: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/auto-resolve/retry — docs/146
  // Reset the auto-resolve attempt budget AND immediately fire a fresh
  // handleTransition with the cached mergeable state. Without the
  // synchronous fire, the user would click "Retry" and stare at a stale
  // banner for up to 15s while the next poll caught up.
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/auto-resolve/retry",
    async (request, reply) => {
      const sessionId = request.params.id;
      const manager = deps.prStatusPoller?.autoConflictResolveManager;
      if (!manager) {
        reply.code(404).send({ error: "Auto-resolve is not configured for this orchestrator" });
        return;
      }
      const state = manager.get(sessionId);
      if (state?.status === "running") {
        reply.code(409).send({ error: "auto-resolve already in flight" });
        return;
      }

      manager.resetForUserActivity(sessionId);

      const mergeable = manager.getLastKnownMergeable(sessionId);
      const baseBranch = manager.getBaseBranch(sessionId);
      const session = sessionManager.get(sessionId);
      const summary = deps.prStatusPoller?.getStatus(sessionId);
      // Need a non-empty headSha for the manager's head-SHA-change reset to
      // work correctly on the next retry. Fall back to the last known PR
      // headBranch's HEAD by reading the session-local checkout — if neither
      // is available, an empty string is safe (the manager's step-7 SHA
      // change check ignores empties).
      const headSha = summary?.headBranch
        ? "" // Manager treats "" as "no change since last seen"; preserves existing state.
        : "";

      if (mergeable && baseBranch && session) {
        // Synchronously kick the manager so the user doesn't wait for the
        // next poll. Fire-and-forget — handleTransition's `await runner
        // .verifyRunningState()` is HTTP roundtrip and we don't want to
        // block the response.
        const pollSummary = summary ?? {
          sessionId,
          prNumber: 0,
          prUrl: "",
          prTitle: "",
          prBody: "",
          prState: "open" as const,
          baseBranch,
          headBranch: session.branch ?? "",
          insertions: 0,
          deletions: 0,
          checks: { state: "none" as const, total: 0, passed: 0, failed: 0, pending: 0 },
          mergeable,
          reviewDecision: "none" as const,
          autoMergeEnabled: false,
        };
        manager.handleTransition(sessionId, pollSummary, baseBranch, headSha).catch((err: unknown) => {
          console.error(`[auto-resolve] retry handleTransition error for ${sessionId}:`, err);
        });
      }
      return { status: "retry_scheduled" };
    },
  );
}
