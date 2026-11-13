import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";
import { emitNoticePostTurn } from "./chat-card-persistence.js";
import { postTurnCommit } from "./ws-handlers/post-turn.js";
import { gitRemoteCredentialResolver } from "./services/github.js";
import type { ChatHistoryManager } from "./chat-history.js";
import type { SessionRunnerInterface } from "./session-runner.js";
import type { GitManager } from "../shared/git.js";

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
  buildPostRebaseFailureNotice,
  buildSyncFailureNotice,
  postRebaseFailureOf,
  rebaseLeftoverText,
  summarizeGitError,
} from "./services/index.js";
import { deliverRebaseFollowup } from "./services/rebase-followup.js";
import { indexLockStateOf } from "./services/stale-index-lock.js";
import { runExplicitBranchReset } from "./branch-reset-flow.js";
import { getErrorMessage } from "./validation.js";
import { restoreLfsAfterTreeRewrite } from "./git-lfs.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";

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
      sseBroadcast: deps.sseBroadcast,
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

export async function reportSyncFailure(deps: {
  runner: Pick<SessionRunnerInterface, "emitMessage">;
  chatHistoryManager: ChatHistoryManager;
  git: Pick<GitManager, "rebaseInProgressState">;
  sessionId: string;
  baseBranch: string;
  err: unknown;
}): Promise<void> {
  const message = getErrorMessage(deps.err);
  const postRebase = postRebaseFailureOf(deps.err);
  // The abort after a failed rebase swallows its own failure, so check what it left.
  const rebaseInProgress = await deps.git.rebaseInProgressState().catch(() => null);
  // The banner drops its Abort button on this event, so it has to carry the recovery itself.
  const leftover = rebaseLeftoverText(rebaseInProgress);
  const summary = summarizeGitError(message);
  deps.runner.emitMessage({
    type: "rebase_aborted",
    sessionId: deps.sessionId,
    // The banner would title it "Rebase failed"; after a rebase that completed, only the notice speaks.
    ...(postRebase ? {} : { reason: leftover ? `${summary} ${leftover}` : summary }),
  });
  // Persist failures not already recorded by the driver; WS events do not survive reload.
  if (syncFailureAlreadyExplained(deps.err)) return;
  try {
    emitNoticePostTurn(
      (msg) => deps.runner.emitMessage(msg),
      deps.chatHistoryManager,
      deps.sessionId,
      postRebase
        ? buildPostRebaseFailureNotice(deps.baseBranch, postRebase, message)
        : buildSyncFailureNotice(deps.baseBranch, message, rebaseInProgress, indexLockStateOf(deps.err)),
      "warn",
    );
  } catch (noticeErr) {
    console.error("[rebase] sync-failure notice failed:", getErrorMessage(noticeErr));
  }
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
      const outcome = await runExplicitBranchReset(
        {
          sessionManager,
          createGitManager,
          runnerRegistry: deps.runnerRegistry,
          chatHistoryManager: deps.chatHistoryManager,
          ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
          sseBroadcast: deps.sseBroadcast,
        },
        { sessionId, sessionDir: dir, ...(force ? { force: { reason } } : {}) },
      );
      return outcome;
    },
  );

  // What `buildAgentRunParams` gives a new agent process, for the hook of one that is already up.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/branch/destructive-git-guard",
    { config: { containerAccessible: true } },
    (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      return { guarded: Boolean(session.mergedHeadSha) };
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
            userStarted: true,
            prStatusPoller: deps.prStatusPoller,
            agentMergeClaims: deps.agentMergeClaims,
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

        void (async () => {
          try {
            const outcome = await flowPromise;
            // The flow's `finally` has run: the session hold is released and LFS restored.
            if (outcome.status === "conflicts_resolved" && outcome.followup) {
              deliverRebaseFollowup(
                { runner, sessionManager: deps.sessionManager },
                outcome.followup,
              );
            }
          } catch (err: unknown) {
            console.error(`[rebase] flow failed for session ${sessionId}:`, err);
            await reportSyncFailure({
              runner,
              chatHistoryManager: deps.chatHistoryManager,
              git,
              sessionId,
              baseBranch,
              err,
            });
          }
        })();

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
          if (runner?.sessionHold) agent.emit("superseded");
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
        // docs/322 — the user's click, so a question the agent is waiting on does not hold it.
        manager.handleTransition(sessionId, pollSummary, baseBranch, headSha, undefined, { byUser: true })
          .catch((err: unknown) => {
            console.error(`[auto-resolve] retry handleTransition error for ${sessionId}:`, err);
          });
      }
      return { status: "retry_scheduled" };
    },
  );
}
