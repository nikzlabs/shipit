/**
 * GitHub API routes.
 * Handles: GitHub repos search, PR status, PR CRUD, CI fix, auto-merge,
 * merge-method, GitHub token, GitHub logout.
 */

import type { FastifyInstance } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { resolveSessionDir } from "./api-routes.js";

import {
  getPrStatus,
  getRepoScopedGitCredential,
  searchGitHubRepos,
  listGitHubOrgs,
  createPullRequest,
  quickCreatePr,
  agentCreatePr,
  planRelease,
  prepareRelease,
  editPullRequest,
  commentOnPullRequest,
  addIssueComment,
  markPrReady,
  closePullRequest,
  reopenPullRequest,
  viewPullRequest,
  listPullRequests,
  mergePullRequest,
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
import { getErrorMessage } from "./validation.js";
import { parseGitHubRemote } from "./git-utils.js";
import { resolvePrTarget, gitCredentialAllowed } from "./pr-target.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";

/**
 * docs/214 — read the release-branch fields from a workspace's shipit.yaml.
 *
 * `release.branch` (the maintenance branch) and `release.version-source-path`
 * (monorepo) are added by Phase 1 (`shipit-config.ts`). Until that lands on
 * main these fields aren't on `ReleaseConfig`, so we read them through a narrow
 * cast: the runtime parser simply leaves them `undefined` (the documented
 * defaults — `branch` → "stable", path → auto-detect), and once Phase 1
 * populates them the same access returns the real values with no change here.
 */
function readReleaseConfig(dir: string): { branch?: string; versionSourcePath?: string } {
  try {
    const config = resolveShipitConfig(dir);
    const release = config.release as
      | { branch?: string; versionSourcePath?: string }
      | undefined;
    return {
      ...(release?.branch ? { branch: release.branch } : {}),
      ...(release?.versionSourcePath ? { versionSourcePath: release.versionSourcePath } : {}),
    };
  } catch {
    // A broken/absent shipit.yaml just means "use the defaults".
    return {};
  }
}

export async function registerGitHubRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { sessionManager, createGitManager } = deps;

  // ---- GitHub reads ----

  // GET /api/sessions/:id/pr/status — PR status
  app.get<{ Params: { id: string }; Querystring: { cwd?: string; repo?: string } }>("/api/sessions/:id/pr/status", { config: { containerAccessible: true } }, async (request, reply) => {
    const dir = resolveSessionDir(sessionManager, request.params.id, reply);
    if (!dir) return;
    try {
      const session = sessionManager.get(request.params.id);
      const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
      const git = createGitManager(gitDir);
      return { pr: await getPrStatus(deps.githubAuthManager, git, remoteUrl) };
    } catch (err) {
      reply.code(500).send({ error: `Failed to get PR status: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/github/repos — search GitHub repos
  app.get<{ Querystring: { q?: string } }>("/api/github/repos", async (request) => {
    const query = request.query.q ?? "";
    return { repos: await searchGitHubRepos(deps.githubAuthManager, query) };
  });

  // GET /api/github/orgs — list the user's organizations (new-repo owner picker)
  app.get("/api/github/orgs", async () => {
    return { orgs: await listGitHubOrgs(deps.githubAuthManager) };
  });

  // ---- PR mutations ----

  // POST /api/sessions/:id/pr/quick — one-click PR creation
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

        // Track the new PR in the poller
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

  // POST /api/sessions/:id/pr — create pull request
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

  // POST /api/sessions/:id/pr/agent-create — agent-driven PR create (used by gh shim)
  app.post<{
    Params: { id: string };
    Body: {
      title?: string;
      body?: string;
      base?: string;
      draft?: boolean;
      fill?: boolean;
      labels?: string[];
      // docs/211 — repo-aware brokering: the cwd `gh` ran in and an optional
      // `--repo` override, so a sandbox PR targets the right clone.
      cwd?: string;
      repo?: string;
    };
  }>(
    "/api/sessions/:id/pr/agent-create",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
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
          // Pass session + runner context so the service can flush any
          // pending working-tree changes (commit + cancel pending auto-push)
          // before pushing. The agent calls `gh pr create` mid-turn, before
          // the normal end-of-turn `postTurnCommit` has fired — without the
          // flush, those edits wouldn't appear on the PR.
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          chatHistory: deps.chatHistoryManager,
        });
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

  // ---- Release (docs/214) ----
  //
  // The deterministic release mechanics behind `shipit release {plan,prepare}`.
  // Both are containerAccessible (the shim relays through the worker broker).
  // `plan` is read-only and reflects a `proposed` card; `prepare` opens the bump
  // PR (final release) or cuts the rc tag (prerelease), driving the release
  // poller directly so the agent is out of the state-reporting loop.

  // POST /api/sessions/:id/release/plan
  app.post<{
    Params: { id: string };
    Body: { bump?: string; prerelease?: boolean; versionSourcePath?: string; cwd?: string; repo?: string };
  }>(
    "/api/sessions/:id/release/plan",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const session = sessionManager.get(request.params.id);
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
        });
        // Reflect a `proposed` card (informational for final releases; the rc
        // path's confirm gate also reads it). Requires a GitHub remote to poll.
        if (deps.releaseStatusPoller && remoteUrl) {
          deps.releaseStatusPoller.propose(request.params.id, remoteUrl, {
            version: plan.version,
            tag: plan.tag,
            prerelease: plan.prerelease,
            ...(plan.bumpType !== "explicit" ? { bumpType: plan.bumpType } : {}),
            versionSource: plan.versionSource,
          });
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

  // POST /api/sessions/:id/release/prepare
  app.post<{
    Params: { id: string };
    Body: {
      bump?: string;
      prerelease?: boolean;
      pick?: string[];
      from?: string;
      releaseBranch?: string;
      bootstrap?: boolean;
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
        const result = await prepareRelease(git, deps.githubAuthManager, {
          dir: gitDir,
          bump: request.body?.bump,
          prerelease: request.body?.prerelease,
          pick: request.body?.pick,
          from: request.body?.from,
          releaseBranch: request.body?.releaseBranch ?? rel.branch ?? "stable",
          bootstrap: request.body?.bootstrap,
          confirm: request.body?.confirm,
          versionSourcePath: request.body?.versionSourcePath ?? rel.versionSourcePath,
          notes: request.body?.notes,
          remoteUrl,
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          chatHistory: deps.chatHistoryManager,
        });

        // Drive the release poller directly off the result (server-side, no
        // agent-echoed marker — docs/214).
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

  // POST /api/sessions/:id/git/credential — broker a git credential to the
  // in-container `shipit-git-credential` helper (docs/088 finding #5). The
  // GitHub PAT is never written into the container's gitconfig; the helper
  // asks for it at git-time over localhost and the token is returned only via
  // the worker→helper→git stdout channel. Scoped to github.com by the service.
  app.post<{ Params: { id: string }; Body: { host?: string; protocol?: string } }>(
    "/api/sessions/:id/git/credential",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      // Session-scoping: only an existing session may broker a credential.
      const session = sessionManager.get(request.params.id);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      // docs/211 — capability gate at the broker (defense in depth). A sandbox
      // session with GitHub access OFF gets no token, regardless of how the
      // container's git was wired. Repo-bound / ops sessions are unaffected.
      // 403 is treated as "no credential" by the helper, so git falls back to
      // anonymous access rather than hard-failing.
      if (!gitCredentialAllowed(session)) {
        reply.code(403).send({ error: "GitHub access is not granted for this sandbox session" });
        return;
      }
      // Resolve the session's repo so the broker can prefer a short-lived,
      // single-repo-scoped GitHub App installation token (docs/172 Gap 2-R /
      // SHI-79) over the long-lived PAT, shrinking the blast radius of an
      // extracted credential. Falls back to the PAT when no App is configured
      // or the repo can't be identified.
      const repo = session.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
      const cred = await getRepoScopedGitCredential(deps.githubAuthManager, {
        host: request.body?.host,
        owner: repo?.owner,
        repo: repo?.repo,
      });
      if (!cred) {
        // No credential available for this host — tell the helper so git falls
        // back to anonymous / its other helpers rather than blocking.
        reply.code(404).send({ error: "No credential available for host" });
        return;
      }
      return cred;
    },
  );

  // PATCH /api/sessions/:id/pr/:number — edit an existing PR
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

  // GET /api/sessions/:id/pr/list?state=open — list PRs for the session's repo
  app.get<{ Params: { id: string }; Querystring: { state?: string; cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/list",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        const { gitDir, remoteUrl } = resolvePrTarget(session ?? { remoteUrl: "" }, dir, request.query);
        const git = createGitManager(gitDir);
        const stateRaw = request.query.state;
        const state: "open" | "closed" | "all" =
          stateRaw === "closed" || stateRaw === "all" ? stateRaw : "open";
        const prs = await listPullRequests(git, deps.githubAuthManager, {
          state,
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

  // GET /api/sessions/:id/pr/view — view PR details (current branch's PR by default)
  // GET /api/sessions/:id/pr/view?number=N — view a specific PR
  app.get<{ Params: { id: string }; Querystring: { number?: string; cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/view",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
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

  // POST /api/sessions/:id/pr/:number/comment — add a comment to a PR
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

  // POST /api/sessions/:id/pr/comments — add a PR-level (issue) comment to the
  // session's current-branch PR (docs/133 Phase 4 Conversation composer).
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

  // ---- PR review-thread sync (docs/102) ----
  //
  // Three mutations targeted at a single review thread by its GraphQL node id.
  // The session id is in the path so the route can resolve the session's PR
  // (and, in the future, verify the thread belongs to it). The next poll tick
  // (5s by default) reconciles the cached state on the client — no need to
  // optimistically rewrite store state on success.

  // POST /api/sessions/:id/pr/review — submit local line comments as one review
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

  // POST /api/sessions/:id/pr/threads/:threadId/reply — reply to a review thread
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

  // POST /api/sessions/:id/pr/threads/:threadId/resolve — mark thread resolved
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

  // POST /api/sessions/:id/pr/threads/:threadId/unresolve — reopen a thread
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

  // POST /api/sessions/:id/pr/:number/ready — mark draft as ready for review
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

  // POST /api/sessions/:id/pr/:number/close — close a PR
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

  // POST /api/sessions/:id/pr/:number/reopen — reopen a closed PR
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

  // POST /api/sessions/:id/pr/merge — merge pull request
  app.post<{ Params: { id: string }; Body: { method?: string } }>(
    "/api/sessions/:id/pr/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        // Block merge while the agent is mid-turn. Auto-commit fires after
        // the turn ends (see post-turn.ts), so merging now could ship a PR
        // whose later commits land on a branch with a closed PR — orphaned
        // work. The client also disables the button, but a stale tab or
        // race could still POST here, so enforce on the server too.
        const runner = deps.runnerRegistry.get(request.params.id);
        if (runner?.running) {
          reply.code(409).send({ error: "Agent turn in progress — wait for it to finish before merging" });
          return;
        }

        // Block merge if CI checks haven't registered yet. Two cases:
        //   (a) workflow files exist but no checks reported yet — poller has
        //       mutated state to "pending" with total === 0
        //   (b) the PR was just created and the poller hasn't run its first
        //       poll yet — getStatus returns undefined while the session is
        //       being tracked. We only enter this branch when the poller is
        //       tracking the session, which means a PR was just registered.
        const poller = deps.prStatusPoller;
        const session = sessionManager.get(request.params.id);
        if (poller && session?.remoteUrl) {
          const prStatus = poller.getStatus(request.params.id);
          if (!prStatus) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
          if (prStatus.checks.state === "pending" && prStatus.checks.total === 0) {
            return { success: false, message: "Waiting for CI checks to start" };
          }
          // Block merge when the base branch requires a review that hasn't been
          // satisfied. The client hides the button, but a stale tab could still
          // POST here — and a merge GitHub would reject is worth catching with a
          // clear message rather than a raw 405. docs/174.
          if (
            prStatus.reviewDecision === "review_required" ||
            prStatus.reviewDecision === "changes_requested"
          ) {
            return { success: false, message: "Waiting for required review approval" };
          }
        }

        const git = createGitManager(dir);
        const result = await mergePullRequest(git, deps.githubAuthManager, request.body?.method, session?.remoteUrl);
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

  // POST /api/sessions/:id/pr/description — generate PR description via LLM
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/pr/description",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const git = createGitManager(dir);
        return await generatePrDescription(git, deps.generateText, dir);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to generate description: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/sessions/:id/pr/fix-ci — manually trigger CI fix
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

  // docs/169 — the per-session POST /api/sessions/:id/pr/auto-fix toggle (which
  // controlled the on/off switch) was removed: auto-fix CI is now a global
  // account-level setting (PUT /api/settings { autoFixCi }).
  //
  // docs/186 — a DIFFERENT per-session control: a pause override on top of the
  // global setting. The global stays the master on/off; this suppresses the
  // auto-fix loop for a single session while the global is on. Persisted on the
  // session row and re-broadcast so every tab's PR menu reflects it.
  // POST /api/sessions/:id/pr/auto-fix-pause { paused: boolean }
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
      // Re-broadcast the session list so the PR menu's toggle reconciles across
      // tabs and survives a reload (the flag lives on the session record).
      deps.sseBroadcast("session_list", { sessions: sessionManager.list() });
      return { paused: request.body.paused };
    },
  );

  // POST /api/sessions/:id/pr/auto-merge — toggle auto-merge on/off
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

  // POST /api/sessions/:id/pr/merge-method — update preferred merge method
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

  // ---- GitHub auth mutations ----

  // POST /api/github/token — set GitHub token
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

  // POST /api/github/logout — logout from GitHub
  app.post(
    "/api/github/logout",
    async () => {
      return gitHubLogout(deps.githubAuthManager);
    },
  );

}
