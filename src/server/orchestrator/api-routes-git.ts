import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { BranchAutoResetCard, PrStatusSummary, WsServerMessage } from "../shared/types.js";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitChatCard, emitNoticePostTurn } from "./chat-card-persistence.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import { gitRemoteCredentialResolver } from "./services/github.js";
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
  syncFailureAlreadyExplained,
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
import { restoreLfsAfterTreeRewrite } from "./git-lfs.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";

interface ExplicitResetPresentationDeps {
  runner: SessionRunnerInterface | undefined;
  chatHistoryManager: ChatHistoryManager;
  sessionId: string;
  prStatus: PrStatusSummary | null | undefined;
  // reArm clears the live PR snapshot; retain its identity for the reset card.
  fallbackPr?: { prNumber: number; prUrl: string } | undefined;
  outcome: ExplicitResetOutcome;
  reArmResetSession: () => Promise<void>;
}

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

// Pass the push callback through: postTurnCommit can throw after creating it.
// The driver must coordinate it with the sync's force-push even on failure.
async function savePendingWorkForSync(
  args: {
    deps: ApiDeps;
    runner: SessionRunnerInterface;
    sessionDir: string;
    sessionId: string;
    baseBranch: string;
  },
  deferPushArm: (arm: () => void) => void,
): Promise<{ commitHash: string | null }> {
  const { deps, runner, sessionDir, sessionId, baseBranch } = args;
  const commitHash = await postTurnCommit(
    {
      createGitManager: deps.createGitManager,
      chatHistoryManager: deps.chatHistoryManager,
      sessionManager: deps.sessionManager,
      scheduleAutoPush: (git, sid) => deps.scheduleAutoPush?.(git, sid),
    },
    {
      sessionDir,
      sessionId,
      emit: (msg) => runner.emitMessage(msg),
      turnSummary: `Save work before syncing with ${baseBranch}`,
      runner,
      deferPushArm,
    },
  );
  return { commitHash };
}

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

  app.post<{ Params: { id: string }; Body: { force?: boolean; reason?: string } }>(
    "/api/sessions/:id/branch/reset-to-base",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const sessionId = request.params.id;
      const prStatus = sessionManager.getPrStatus(sessionId);
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

      if (outcome.outcome === "reset") {
        onWorkspaceRewritten(deps.runnerRegistry.get(sessionId), "reset-to-base");
      }

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
        return await getTurnDiff(git, from, to, gitRemoteCredentialResolver(deps.githubAuthManager));
      } catch (err) {
        reply.code(500).send({ error: `Failed to get diff: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { base?: string } }>(
    "/api/sessions/:id/git/diff-vs-branch",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const baseBranch = request.query.base
        || repoDefaultBranch(deps.repoStore, sessionManager.get(request.params.id)?.remoteUrl);
      try {
        const git = createGitManager(dir);
        return await getDiffVsBranch(git, baseBranch, gitRemoteCredentialResolver(deps.githubAuthManager));
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to get diff: ${getErrorMessage(err)}` });
      }
    },
  );

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

  app.post<{ Params: { id: string }; Body: { commitHash: string } }>(
    "/api/sessions/:id/git/rollback",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await gitRollback(git, request.body.commitHash);
        // Orchestrator git disables LFS smudge; restore file contents after rewrites.
        await restoreLfsAfterTreeRewrite(dir, "Rollback", (message) =>
          console.warn(`[rollback] ${message}`),
        );
        onWorkspaceRewritten(deps.runnerRegistry.get(request.params.id), "rollback");
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

  app.post<{ Params: { id: string }; Body: { remote?: string; branch?: string } }>(
    "/api/sessions/:id/git/pull",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const pulled = await gitPull(git, deps.githubAuthManager, request.body?.remote, request.body?.branch);
        await restoreLfsAfterTreeRewrite(dir, "Pull", (message) =>
          console.warn(`[git-pull] ${message}`),
        );
        // A reported failure can follow a successful merge; refresh config regardless.
        onWorkspaceRewritten(deps.runnerRegistry.get(request.params.id), "git-pull");
        return pulled;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Pull failed: ${getErrorMessage(err)}` };
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { sourceSessionId: string } }>(
    "/api/sessions/:id/git/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const merged = await mergeSession(
          sessionManager, createGitManager, dir, request.body.sourceSessionId,
          gitRemoteCredentialResolver(deps.githubAuthManager),
        );
        onWorkspaceRewritten(deps.runnerRegistry.get(request.params.id), "session-merge");
        return merged;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to merge: ${getErrorMessage(err)}` });
      }
    },
  );

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

      deps.prStatusPoller?.autoConflictResolveManager?.resetForUserActivity(sessionId);

      try {
        const git = createGitManager(dir);

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
            recordSyncCard: true,
            prStatusPoller: deps.prStatusPoller,
            // Use runner.sessionDir exactly: the driver shares a mutex keyed by this string.
            commitPendingWork: (deferPushArm) => savePendingWorkForSync({
              deps,
              runner,
              sessionDir: runner.sessionDir,
              sessionId,
              baseBranch,
            }, deferPushArm),
          },
          baseBranch,
        );

        flowPromise.catch((err: unknown) => {
          console.error(`[rebase] flow failed for session ${sessionId}:`, err);
          runner.emitMessage({ type: "rebase_aborted", sessionId: runner.sessionId, reason: getErrorMessage(err) });
          // Persist failures not already recorded by the driver; WS events do not survive reload.
          if (syncFailureAlreadyExplained(err)) return;
          try {
            emitNoticePostTurn(
              (msg) => runner.emitMessage(msg),
              deps.chatHistoryManager,
              sessionId,
              `Sync with \`${baseBranch}\` failed: ${getErrorMessage(err)}. Your branch was not `
              + "changed by ShipIt; check the workspace state and try again.",
              "warn",
            );
          } catch (noticeErr) {
            console.error("[rebase] sync-failure notice failed:", getErrorMessage(noticeErr));
          }
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

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/git/rebase/abort",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const runner = deps.runnerRegistry.get(request.params.id);
        const agent = runner?.getAgent();
        if (agent) {
          agent.kill();
          // Settle the driver's wait before clearing the agent drops its terminal events.
          if (runner?.systemTurnInProgress) agent.emit("superseded");
          if (runner) {
            runner.setAgent(null);
            runner.running = false;
          }
        }

        const git = createGitManager(dir);
        // The driver's abort can win the race; an already-aborted rebase is success.
        try {
          await rebaseAbort(git);
        } catch (abortErr) {
          const stillInProgress = await git.isRebaseInProgress().catch(() => true);
          if (stillInProgress) throw abortErr;
        }
        await restoreLfsAfterTreeRewrite(dir, "Rebase abort", (message) =>
          console.warn(`[rebase-abort] ${message}`),
        );
        onWorkspaceRewritten(runner, "rebase-abort");
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
      const headSha = summary?.headBranch
        ? ""
        : "";

      if (mergeable && baseBranch && session) {
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
