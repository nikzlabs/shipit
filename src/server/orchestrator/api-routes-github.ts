import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  flushPendingTurnCommit,
  getPrStatus,
  getRepoScopedGitCredential,
  searchGitHubRepos,
  listGitHubOrgs,
  createPullRequest,
  quickCreatePr,
  agentCreatePr,
  planRelease,
  buildPlanProposeInput,
  prepareRelease,
  adoptReleaseBranch,
  editPullRequest,
  commentOnPullRequest,
  addIssueComment,
  markPrReady,
  closePullRequest,
  reopenPullRequest,
  viewPullRequest,
  listPullRequests,
  listWorkflowRuns,
  viewWorkflowRun,
  rerunWorkflowRun,
  listWorkflows,
  viewWorkflow,
  mergePullRequest,
  agentMergePullRequest,
  generatePrDescription,
  setGitHubToken,
  gitHubLogout,
  triggerCIFix,
  toggleAutoMerge,
  activatePendingAutoMergeForPr,
  updateMergeMethod,
  replyToReviewThread,
  resolveReviewThread,
  submitReviewComments,
  unresolveReviewThread,
  ServiceError,
} from "./services/index.js";
import { PR_LIST_STATES, type PrListState } from "./github-auth-prs.js";
import { getErrorMessage } from "./validation.js";
import { guardMergeSync } from "./services/branch-sync.js";
import { mergeFlushRefusal } from "./services/merge-gate.js";
import { captureTurn, settleAgentMerge, type TurnToken } from "./services/agent-merge-settlement.js";
import { parseGitHubRemote, repoId } from "./git-utils.js";
import { mergeMethodFor } from "./agent-merge-claims.js";
import { resolvePrTarget, gitCredentialAllowed, mergeDisposition, agentMergeOwnership } from "./pr-target.js";
import { recordWitnessedPrCreate } from "./services/pr-provenance.js";
import type { FastifyReply } from "fastify";
import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { assessMergeAutoPublish } from "./release-autopublish-check.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";

function readStringProp(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function readReleaseConfig(dir: string): { branch?: string; versionSourcePath?: string; mechanism?: string } {
  try {
    const config = resolveShipitConfig(dir);
    const release: unknown = config.release;
    const branch = readStringProp(release, "branch");
    const versionSourcePath = readStringProp(release, "versionSourcePath");
    const mechanism = readStringProp(release, "mechanism");
    return {
      ...(branch ? { branch } : {}),
      ...(versionSourcePath ? { versionSourcePath } : {}),
      ...(mechanism ? { mechanism } : {}),
    };
  } catch {
    return {};
  }
}

// Brokered reads also use the user's credentials, so they need the same grant.
function gitBrokerDenied(
  session: Pick<SessionInfo, "kind" | "capabilities"> | undefined,
  reply: FastifyReply,
): boolean {
  if (!session || gitCredentialAllowed(session)) return false;
  reply.code(403).send({ error: "GitHub access is not granted for this sandbox session" });
  return true;
}

const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

function parseLimitParam(
  raw: string | undefined,
): { ok: true; limit: number | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, limit: undefined };
  const n = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(n) || n < LIMIT_MIN || n > LIMIT_MAX) {
    return {
      ok: false,
      error: `Invalid limit "${raw}". Expected a whole number between ${LIMIT_MIN} and ${LIMIT_MAX}.`,
    };
  }
  return { ok: true, limit: n };
}

export async function registerGitHubRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager } = deps;

  app.get<{ Params: { id: string }; Querystring: { cwd?: string; repo?: string } }>("/api/sessions/:id/pr/status", { config: { containerAccessible: true } }, async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const session = sessionManager.get(request.params.id);
      if (gitBrokerDenied(session, reply)) return;
      const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
      const git = createGitManager(gitDir);
      return { pr: await getPrStatus(deps.githubAuthManager, git, remoteUrl) };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to get PR status: ${getErrorMessage(err)}` });
    }
  });

  app.get<{ Querystring: { q?: string } }>("/api/github/repos", async (request) => {
    const query = request.query.q ?? "";
    return { repos: await searchGitHubRepos(deps.githubAuthManager, query) };
  });

  app.get("/api/github/orgs", async () => {
    return { orgs: await listGitHubOrgs(deps.githubAuthManager) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/quick",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const result = await quickCreatePr(
          git,
          deps.githubAuthManager,
          deps.chatHistoryManager,
          deps.generateText,
          request.params.id,
          session.title,
          dir,
          session.remoteUrl,
        );

        recordWitnessedPrCreate(sessionManager, request.params.id, result);

        if (deps.prStatusPoller && session.remoteUrl) {
          deps.prStatusPoller.trackSession(request.params.id, session.remoteUrl);
          await activatePendingAutoMergeForPr(
            deps.githubAuthManager,
            deps.prStatusPoller,
            request.params.id,
            result.url,
            result.number,
          );
          void deps.prStatusPoller.forceRefreshSession(request.params.id);
        }

        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { title: string; body: string; base: string; draft?: boolean } }>(
    "/api/sessions/:id/pr",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        const result = await createPullRequest(
          git, deps.githubAuthManager,
          request.body.title, request.body.body, request.body.base, request.body.draft,
          session?.remoteUrl,
        );
        if (result.success && result.number !== undefined) {
          recordWitnessedPrCreate(sessionManager, request.params.id, {
            number: result.number,
            alreadyExisted: false,
            owner: result.owner,
            repo: result.repo,
          });
        }
        if (result.success && deps.prStatusPoller && session?.remoteUrl) {
          deps.prStatusPoller.trackSession(request.params.id, session.remoteUrl);
          void deps.prStatusPoller.forceRefreshSession(request.params.id);
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
      fill?: boolean;
      labels?: string[];
      cwd?: string;
      repo?: string;
    };
  }>(
    "/api/sessions/:id/pr/agent-create",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (gitBrokerDenied(session, reply)) return;
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const { gitDir, remoteUrl } = resolvePrTarget(session, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        const result = await agentCreatePr(git, deps.githubAuthManager, {
          title: request.body?.title,
          body: request.body?.body,
          base: request.body?.base,
          draft: request.body?.draft,
          fill: request.body?.fill,
          labels: request.body?.labels,
          sessionTitle: session.title,
          remoteUrl,
          // Mid-turn PR creation must commit pending edits before pushing.
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          ...(deps.cancelAutoPush ? { cancelAutoPush: deps.cancelAutoPush } : {}),
          chatHistory: deps.chatHistoryManager,
        });
        recordWitnessedPrCreate(sessionManager, request.params.id, result);
        if (deps.prStatusPoller && session.remoteUrl) {
          deps.prStatusPoller.trackSession(request.params.id, session.remoteUrl);
          await activatePendingAutoMergeForPr(
            deps.githubAuthManager,
            deps.prStatusPoller,
            request.params.id,
            result.url,
            result.number,
          );
          void deps.prStatusPoller.forceRefreshSession(request.params.id);
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to create PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { bump?: string; prerelease?: boolean; versionSourcePath?: string; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/release/plan",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (gitBrokerDenied(session, reply)) return;
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const { gitDir, remoteUrl } = resolvePrTarget(session, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        const rel = readReleaseConfig(gitDir);
        const plan = await planRelease(git, {
          dir: gitDir,
          bump: request.body?.bump,
          prerelease: request.body?.prerelease,
          versionSourcePath: request.body?.versionSourcePath ?? rel.versionSourcePath,
          mechanism: rel.mechanism,
          releaseBranch: rel.branch ?? "stable",
        });
        if (rel.mechanism === "release-branch" && !plan.prerelease) {
          const branch = rel.branch ?? "stable";
          await git.fetch("origin");
          const assessment = await assessMergeAutoPublish(git, branch);
          if (assessment.warning) plan.warning = assessment.warning;
        }
        if (deps.releaseStatusPoller && remoteUrl) {
          deps.releaseStatusPoller.propose(
            request.params.id,
            remoteUrl,
            buildPlanProposeInput(plan, rel.mechanism),
          );
        }
        return plan;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to plan release: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      bump?: string;
      prerelease?: boolean;
      pick?: string[];
      from?: string;
      releaseBranch?: string;
      bootstrap?: boolean;
      allowEmpty?: boolean;
      confirm?: boolean;
      versionSourcePath?: string;
      notes?: string;
      cwd?: string;
      repo?: string;
    };
  }>(
    "/api/sessions/:id/release/prepare",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (gitBrokerDenied(session, reply)) return;
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const { gitDir, remoteUrl } = resolvePrTarget(session, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        const rel = readReleaseConfig(gitDir);
        // Preparation can fail after rewriting the tree. Refresh even then,
        // but only for an actual rewrite of this session's clone.
        let treeRewritten = false;
        let result;
        try {
          result = await prepareRelease(git, deps.githubAuthManager, {
            onTreeRewrite: () => { treeRewritten = true; },
            dir: gitDir,
            bump: request.body?.bump,
            prerelease: request.body?.prerelease,
            pick: request.body?.pick,
            from: request.body?.from,
            releaseBranch: request.body?.releaseBranch ?? rel.branch ?? "stable",
            mechanism: rel.mechanism,
            bootstrap: request.body?.bootstrap,
            allowEmpty: request.body?.allowEmpty,
            confirm: request.body?.confirm,
            versionSourcePath: request.body?.versionSourcePath ?? rel.versionSourcePath,
            notes: request.body?.notes,
            remoteUrl,
            sessionId: request.params.id,
            runnerRegistry: deps.runnerRegistry,
            ...(deps.cancelAutoPush ? { cancelAutoPush: deps.cancelAutoPush } : {}),
            chatHistory: deps.chatHistoryManager,
          });
        } finally {
          if (gitDir === dir && treeRewritten) {
            onWorkspaceRewritten(deps.runnerRegistry.get(request.params.id), "release-prepare");
          }
        }

        const poller = deps.releaseStatusPoller;
        if (poller && remoteUrl) {
          if (result.kind === "pr-opened") {
            poller.markPrOpened(request.params.id, remoteUrl, {
              version: result.version,
              tag: result.tag,
              prerelease: false,
              prNumber: result.prNumber,
              prUrl: result.prUrl,
              releaseBranch: result.releaseBranch,
              ...(result.bumpType !== "explicit" ? { bumpType: result.bumpType } : {}),
              versionSource: result.versionSource,
              ...(request.body?.notes ? { notes: request.body.notes } : {}),
            });
          } else if (result.kind === "prerelease-proposed") {
            poller.propose(request.params.id, remoteUrl, {
              version: result.version,
              tag: result.tag,
              prerelease: true,
              versionSource: result.versionSource,
            });
          } else {
            poller.markTagged(request.params.id, remoteUrl, {
              tag: result.tag,
              version: result.version,
              prerelease: true,
              sha: result.sha,
            });
          }
        }

        // Adopt the release head so the session's PR poller can find it.
        if (result.kind === "pr-opened" && remoteUrl && remoteUrl === session.remoteUrl) {
          await adoptReleaseBranch({
            deps: {
              sessionManager,
              prStatusPoller: deps.prStatusPoller,
              sseBroadcast: deps.sseBroadcast,
            },
            sessionId: request.params.id,
            releaseHeadBranch: `release/${result.version}`,
          });
        }

        if (result.kind === "pr-opened") {
          const assessment = await assessMergeAutoPublish(git, result.releaseBranch);
          if (assessment.warning) result.warning = assessment.warning;
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to prepare release: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { host?: string; protocol?: string } }>(
    "/api/sessions/:id/git/credential",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (!gitCredentialAllowed(session)) {
        reply.code(403).send({ error: "GitHub access is not granted for this sandbox session" });
        return;
      }
      const repo = session.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
      const cred = await getRepoScopedGitCredential(deps.githubAuthManager, {
        host: request.body?.host,
        owner: repo?.owner,
        repo: repo?.repo,
      });
      if (!cred) {
        reply.code(404).send({ error: "No credential available for host" });
        return;
      }
      return cred;
    },
  );

  app.patch<{
    Params: { id: string; number: string };
    Body: { title?: string; body?: string; addLabels?: string[]; removeLabels?: string[]; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/pr/:number",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        return await editPullRequest(git, deps.githubAuthManager, {
          number: num,
          title: request.body?.title,
          body: request.body?.body,
          addLabels: request.body?.addLabels,
          removeLabels: request.body?.removeLabels,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to update PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { state?: string; limit?: string; cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/list",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const stateRaw = request.query.state;
        if (stateRaw !== undefined && !PR_LIST_STATES.includes(stateRaw as PrListState)) {
          reply.code(400).send({
            error: `Unknown state "${stateRaw}". Supported states: ${PR_LIST_STATES.join(", ")}`,
          });
          return;
        }
        const state: PrListState = (stateRaw as PrListState | undefined) ?? "open";
        const limit = parseLimitParam(request.query.limit);
        if (!limit.ok) {
          reply.code(400).send({ error: limit.error });
          return;
        }
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const prs = await listPullRequests(git, deps.githubAuthManager, {
          state,
          ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
          remoteUrl,
        });
        return { prs };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list PRs: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { number?: string; cwd?: string; repo?: string; comments?: string } }>(
    "/api/sessions/:id/pr/view",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        let num: number | undefined;
        if (request.query.number) {
          num = Number(request.query.number);
          if (!Number.isFinite(num) || num <= 0) {
            reply.code(400).send({ error: "Invalid PR number" });
            return;
          }
        }
        const pr = await viewPullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl,
          comments: request.query.comments === "true",
        });
        return { pr };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to view PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { workflow?: string; branch?: string; status?: string; limit?: string; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/actions/runs",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const limit = parseLimitParam(request.query.limit);
        if (!limit.ok) {
          reply.code(400).send({ error: limit.error });
          return;
        }
        const runs = await listWorkflowRuns(git, deps.githubAuthManager, {
          workflow: request.query.workflow,
          branch: request.query.branch,
          status: request.query.status,
          ...(limit.limit !== undefined ? { limit: limit.limit } : {}),
          remoteUrl,
        });
        return { runs };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list workflow runs: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { id?: string; log?: string; logFailed?: string; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/actions/runs/view",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      let runId: number | undefined;
      if (request.query.id) {
        runId = Number(request.query.id);
        if (!Number.isFinite(runId) || runId <= 0) {
          reply.code(400).send({ error: "Invalid run id" });
          return;
        }
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const result = await viewWorkflowRun(git, deps.githubAuthManager, {
          ...(typeof runId === "number" ? { runId } : {}),
          log: request.query.log === "true",
          logFailed: request.query.logFailed === "true",
          remoteUrl,
        });
        return result ?? { run: null };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to view workflow run: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { id?: string | number; failed?: boolean; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/actions/runs/rerun",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const body = request.body ?? {};
      let runId: number | undefined;
      if (body.id !== undefined && body.id !== "") {
        const raw = typeof body.id === "number" ? String(body.id) : body.id;
        if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          reply.code(400).send({ error: "Invalid run id" });
          return;
        }
        runId = Number(raw);
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, body);
        const git = createGitManager(gitDir);
        return await rerunWorkflowRun(git, deps.githubAuthManager, {
          ...(typeof runId === "number" ? { runId } : {}),
          onlyFailed: body.failed === true,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to re-run workflow run: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { cwd?: string; repo?: string } }>(
    "/api/sessions/:id/actions/workflows",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const workflows = await listWorkflows(git, deps.githubAuthManager, { remoteUrl });
        return { workflows };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list workflows: ${getErrorMessage(err)}` });
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { workflow?: string; cwd?: string; repo?: string } }>(
    "/api/sessions/:id/actions/workflows/view",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const result = await viewWorkflow(git, deps.githubAuthManager, {
          workflow: request.query.workflow ?? "",
          remoteUrl,
        });
        return result ?? { workflow: null };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to view workflow: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{
    Params: { id: string; number: string };
    Body: { body: string; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/pr/:number/comment",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        return await commentOnPullRequest(git, deps.githubAuthManager, request.body?.body ?? "", {
          number: num,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to comment: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    "/api/sessions/:id/pr/comments",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const body = request.body?.body ?? "";
      if (typeof body !== "string" || !body.trim()) {
        reply.code(400).send({ error: "Comment body is required" });
        return;
      }
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await addIssueComment(git, deps.githubAuthManager, body, {
          remoteUrl: session?.remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to comment: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { comments?: unknown } }>(
    "/api/sessions/:id/pr/review",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        const session = sessionManager.get(request.params.id);
        return await submitReviewComments(
          deps.githubAuthManager,
          git,
          request.body?.comments,
          session?.remoteUrl,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to submit review: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; threadId: string }; Body: { body: string } }>(
    "/api/sessions/:id/pr/threads/:threadId/reply",
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const body = request.body?.body ?? "";
      try {
        return await replyToReviewThread(
          deps.githubAuthManager,
          request.params.threadId,
          body,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reply to thread: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; threadId: string } }>(
    "/api/sessions/:id/pr/threads/:threadId/resolve",
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await resolveReviewThread(
          deps.githubAuthManager,
          request.params.threadId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to resolve thread: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; threadId: string } }>(
    "/api/sessions/:id/pr/threads/:threadId/unresolve",
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      try {
        return await unresolveReviewThread(
          deps.githubAuthManager,
          request.params.threadId,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reopen thread: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; number: string }; Body: { cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/:number/ready",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        return await markPrReady(git, deps.githubAuthManager, {
          number: num,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to mark PR ready: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; number: string }; Body: { cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/:number/close",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        return await closePullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to close PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string; number: string }; Body: { cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/:number/reopen",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        return await reopenPullRequest(git, deps.githubAuthManager, {
          number: num,
          remoteUrl,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to reopen PR: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { method?: string } }>(
    "/api/sessions/:id/pr/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        // agentBusy includes commits, pushes, and consults that outlive running.
        const runner = deps.runnerRegistry.get(request.params.id);
        if (runner?.agentBusy) {
          reply.code(409).send({ error: "Agent still working — wait for it to finish before merging" });
          return;
        }

        const poller = deps.prStatusPoller;
        const session = sessionManager.get(request.params.id);
        if (poller && session?.remoteUrl) {
          const prStatus = poller.getStatus(request.params.id);
          if (!prStatus) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
          const grace = prStatus.checks.graceUntil;
          if (
            prStatus.checks.state === "pending"
            && prStatus.checks.total === 0
            && (grace === undefined || Date.now() < grace)
          ) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
          if (
            prStatus.reviewDecision === "review_required" ||
            prStatus.reviewDecision === "changes_requested"
          ) {
            return { success: false, message: "Waiting for required review approval" };
          }
        }

        const git = createGitManager(dir);

        const verdict = await guardMergeSync(git);
        if (verdict.action === "hold") {
          if (poller && session?.remoteUrl) {
            await poller.forceRefreshSession(request.params.id).catch(() => {});
          }
          return { success: false, message: verdict.message };
        }

        // GitHub's native auto-merge cannot see a later turn's busy state.
        const preferManaged = poller?.hasLiveRunner(request.params.id) === true;
        const result = await mergePullRequest(
          git, deps.githubAuthManager, request.body?.method, session?.remoteUrl,
          { preferManaged, sessionId: request.params.id },
        );
        if (result.managed && poller) {
          poller.setAutoMergeEnabled(request.params.id, true);
          poller.setAutoMergeManaged(request.params.id, true, { managedReason: "session-live" });
        }
        if ((result.success || result.autoMergeEnabled) && poller && session?.remoteUrl) {
          if (result.success) {
            await poller.forceVerifySessionPrState(request.params.id);
          } else {
            await poller.forceRefreshSession(request.params.id);
          }
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Merge failed: ${getErrorMessage(err)}` };
      }
    },
  );

  app.post<{
    Params: { id: string; number: string };
    Body: { method?: string; auto?: boolean; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/pr/:number/merge",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (gitBrokerDenied(session, reply)) return;
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // Read permission from ShipIt's record; the agent can edit workspace config.
      const disposition = mergeDisposition(
        session,
        deps.repoStore.allowsAgentMerge(session.remoteUrl ?? ""),
      );
      if (disposition === "not-sandbox") {
        reply.code(403).send({
          error:
            "gh pr merge is only available in Sandbox sessions. In a repo-bound session, merge from the PR lifecycle card in the ShipIt UI.",
        });
        return;
      }
      if (disposition === "not-granted") {
        reply.code(403).send({
          error:
            "Merging PRs is not enabled for this sandbox. The user must turn on \"Allow merging PRs\" under GitHub access when creating the sandbox.",
        });
        return;
      }
      if (disposition === "not-granted-repo") {
        reply.code(403).send({
          error:
            "Agents cannot merge pull requests in this repository. The user turns this on in "
            + "Project Settings → Agent permissions. Until then, merge from the PR lifecycle card "
            + "in the ShipIt UI.",
        });
        return;
      }
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      const num = Number(request.params.number);
      if (!Number.isFinite(num) || num <= 0) {
        reply.code(400).send({ error: "Invalid PR number" });
        return;
      }
      const repoBound = session.kind !== "sandbox";
      const parsedRemote = session.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
      const mergeRepoKey = parsedRemote ? `${parsedRemote.owner}/${parsedRemote.repo}` : null;
      const claimRepoId = repoBound ? repoId(session.remoteUrl ?? "") : null;
      if (repoBound && !deps.agentMergeClaims) {
        reply.code(503).send({
          error:
            "Not merged — ShipIt cannot record an agent merge on this server, and will not perform "
            + "one it could not recover. Merge from the PR lifecycle card in the ShipIt UI.",
        });
        return;
      }
      const claimDeps = deps.agentMergeClaims && repoBound
        ? {
          claims: deps.agentMergeClaims,
          sessionManager,
          chatHistoryManager: deps.chatHistoryManager,
          ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
          ...(deps.runnerRegistry ? { runnerRegistry: deps.runnerRegistry } : {}),
        }
        : null;
      let turn: TurnToken | null = null;
      try {
      if (repoBound) {
        let currentBranch: string | null;
        try {
          currentBranch = await createGitManager(dir).currentBranchOrNull();
        } catch (err) {
          reply.code(409).send({
            error:
              "Not merged — ShipIt could not read this session's workspace to confirm the pull "
              + `request belongs to it: ${getErrorMessage(err)}`,
          });
          return;
        }
        const refusal = agentMergeOwnership({
          session,
          requestedNumber: num,
          currentBranch,
          repoOverride: request.body?.repo,
        });
        if (refusal) {
          reply.code(refusal.status).send({ error: refusal.error });
          return;
        }
        turn = captureTurn(deps.runnerRegistry, request.params.id);
        if (claimDeps && !turn) {
          reply.code(409).send({
            error:
              "Not merged — `gh pr merge` runs as part of a turn, and this session has no turn "
              + "running. Merge from the PR lifecycle card in the ShipIt UI instead.",
          });
          return;
        }

        const flush = await flushPendingTurnCommit(createGitManager(dir), {
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          chatHistory: deps.chatHistoryManager,
        });
        if (flush.kind !== "committed" && flush.kind !== "nothing-to-commit") {
          reply.code(422).send({ error: mergeFlushRefusal(flush) });
          return;
        }

        const verdict = await guardMergeSync(createGitManager(dir));
        if (verdict.action === "hold") {
          // Keep the scheduled retry unless the synchronous push succeeded.
          if (verdict.pushed) deps.cancelAutoPush?.(request.params.id);
          const armPastPush = request.body?.auto === true && verdict.pushed;
          if (!armPastPush) {
            reply.code(409).send({
              error: verdict.pushed
                ? `${verdict.message} (Merge again once the checks on the new head report.)`
                : verdict.message,
            });
            return;
          }
        }
      }
        const { gitDir, remoteUrl } = resolvePrTarget(session, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        let localHead: { kind: "head"; sha: string } | { kind: "unreadable"; reason: string } | undefined;
        if (repoBound) {
          try {
            const sha = await git.getHeadHash();
            localHead = sha
              ? { kind: "head", sha }
              : { kind: "unreadable", reason: "the workspace reported no current commit" };
          } catch (err) {
            localHead = { kind: "unreadable", reason: getErrorMessage(err) };
          }
        }
        const result = await agentMergePullRequest(git, deps.githubAuthManager, {
          number: num,
          sessionId: request.params.id,
          method: request.body?.method,
          auto: request.body?.auto,
          remoteUrl,
          repoBound,
          ...(localHead ? { localHead } : {}),
          ...(deps.prStatusPoller && session.remoteUrl && mergeRepoKey
            ? {
              graceSaysWait: async (headSha: string) =>
                deps.prStatusPoller!.awaitCiGraceDecision({
                  repoUrl: session.remoteUrl,
                  repoKey: mergeRepoKey,
                  prNumber: num,
                  headSha,
                  ...(session.branch ? { headBranch: session.branch } : {}),
                }),
            }
            : {}),
          ...(claimDeps && claimRepoId && turn
            ? {
              beforeMerge: (expectedSha: string) => {
                // Permission and PR ownership can change during the preceding awaits.
                const live = sessionManager.get(request.params.id);
                if (!live) return "Not merged — this session no longer exists.";
                if (mergeDisposition(live, deps.repoStore.allowsAgentMerge(live.remoteUrl ?? "")) !== "allowed") {
                  return "Not merged — the permission to merge in this repository was withdrawn while "
                    + "ShipIt was preparing the merge. Nothing was merged.";
                }
                if (live.prNumber !== num || live.prRepoId !== claimRepoId) {
                  return `Not merged — PR #${num} is no longer the pull request ShipIt opened for `
                    + "this session. Nothing was merged.";
                }
                if (!claimDeps.claims.claim({
                  sessionId: request.params.id,
                  repoId: claimRepoId,
                  prNumber: num,
                  expectedSha,
                  method: mergeMethodFor(request.body?.method),
                })) {
                  return "Not merged — an earlier merge on this session has not been resolved yet, and "
                    + "ShipIt will not start a second one over it. It resolves that attempt at the end "
                    + "of the turn; try again after that.";
                }
                return null;
              },
              onArm: (expectedSha: string) => {
                const live = sessionManager.get(request.params.id);
                if (!live) return "Not armed — this session no longer exists.";
                if (mergeDisposition(live, deps.repoStore.allowsAgentMerge(live.remoteUrl ?? "")) !== "allowed") {
                  return "Not armed — the permission to merge in this repository was withdrawn while "
                    + "ShipIt was preparing the request. Nothing was armed.";
                }
                if (live.prNumber !== num || live.prRepoId !== claimRepoId) {
                  return `Not armed — PR #${num} is no longer the pull request ShipIt opened for `
                    + "this session.";
                }
                if (!claimDeps.claims.arm({
                  sessionId: request.params.id,
                  repoId: claimRepoId,
                  prNumber: num,
                  expectedSha,
                  method: mergeMethodFor(request.body?.method),
                })) {
                  return "Not armed — a merge on this session has not been resolved yet, and ShipIt "
                    + "will not queue a second one behind it. It resolves that attempt at the end of "
                    + "the turn; try again after that.";
                }
                void deps.agentMergeExecutor?.tick();
                return null;
              },
              onMerged: async (expectedSha: string) => {
                const claim = claimDeps.claims.get(request.params.id);
                if (claim?.expectedSha !== expectedSha) return "settled";
                claimDeps.claims.markSettling(request.params.id, expectedSha);
                const outcome = await settleAgentMerge(
                  claimDeps, { ...claim, state: "settling" }, { witnessed: true, turn },
                );
                return outcome.result === "settled" ? "settled" : "deferred";
              },
              onRefused: (expectedSha: string) => {
                claimDeps.claims.releaseUnmerged(request.params.id, expectedSha);
                return Promise.resolve();
              },
              // Retain the claim so reconciliation can resolve the unknown outcome.
              onIndeterminate: () => Promise.resolve(),
            }
            : {}),
        });
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        return { success: false, message: `Merge failed: ${getErrorMessage(err)}` };
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/description",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await generatePrDescription(git, deps.generateText, dir, request.params.id);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to generate description: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/fix-ci",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        return await triggerCIFix(
          deps.githubAuthManager,
          deps.prStatusPoller,
          deps.runnerRegistry,
          request.params.id,
          deps.sessionManager,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Fix CI failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { paused: boolean } }>(
    "/api/sessions/:id/pr/auto-fix-pause",
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      if (typeof request.body?.paused !== "boolean") {
        reply.code(400).send({ error: "\"paused\" field is required (boolean)" });
        return;
      }
      sessionManager.setAutoFixCiPaused(request.params.id, request.body.paused);
      deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
      return { paused: request.body.paused };
    },
  );

  app.post<{ Params: { id: string }; Body: { enabled: boolean } }>(
    "/api/sessions/:id/pr/auto-merge",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        if (typeof request.body?.enabled !== "boolean") {
          reply.code(400).send({ error: "\"enabled\" field is required (boolean)" });
          return;
        }

        return await toggleAutoMerge(
          deps.githubAuthManager,
          deps.prStatusPoller,
          request.params.id,
          request.body.enabled,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Auto-merge toggle failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { method: string } }>(
    "/api/sessions/:id/pr/merge-method",
    async (request, reply) => {
      try {
        if (!deps.prStatusPoller) {
          reply.code(500).send({ error: "PR status poller not available" });
          return;
        }
        const method = request.body?.method;
        if (method !== "squash" && method !== "merge" && method !== "rebase") {
          reply.code(400).send({ error: "\"method\" must be \"squash\", \"merge\", or \"rebase\"" });
          return;
        }

        return await updateMergeMethod(
          deps.githubAuthManager,
          deps.prStatusPoller,
          request.params.id,
          method,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Merge method update failed: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post<{ Body: { token: string } }>(
    "/api/github/token",
    async (request, reply) => {
      try {
        const result = await setGitHubToken(deps.githubAuthManager, request.body.token, sessionManager);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set GitHub token: ${getErrorMessage(err)}` });
      }
    },
  );

  app.post(
    "/api/github/logout",
    async () => {
      return gitHubLogout(deps.githubAuthManager);
    },
  );

}
