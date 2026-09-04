/**
 * GitHub API routes.
 * Handles: GitHub repos search, PR status, PR CRUD, CI fix, auto-merge,
 * merge-method, GitHub token, GitHub logout.
 */

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
import { activeTurnIdFor, settleAgentMerge } from "./services/agent-merge-settlement.js";
import { parseGitHubRemote, repoId } from "./git-utils.js";
import { resolvePrTarget, gitCredentialAllowed, mergeDisposition, agentMergeOwnership } from "./pr-target.js";
import { recordWitnessedPrCreate } from "./services/pr-provenance.js";
import type { FastifyReply } from "fastify";
import type { SessionInfo } from "../shared/types.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import { assessMergeAutoPublish } from "./release-autopublish-check.js";
import { onWorkspaceRewritten } from "./workspace-rewrite.js";

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
/** Read a string-valued property off an unknown value, or undefined. */
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
    // The Phase-1 fields (`branch`, `version-source-path`) aren't on `ReleaseConfig`
    // yet, so read them off the value as `unknown` via a runtime guard rather than a
    // type assertion (a structural assertion would be flagged as unnecessary).
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
    // A broken/absent shipit.yaml just means "use the defaults".
    return {};
  }
}

/**
 * docs/279 — refuse an agent-facing GitHub broker call for a sandbox whose
 * `git` capability is off, and say so. Returns true when it answered the
 * request, so the handler's next statement is `return`.
 *
 * docs/211 gated only `POST .../git/credential` — the route that hands out a
 * TOKEN — on the reasoning that without a token the agent cannot reach GitHub.
 * That reasoning does not hold for the brokered verbs beside it: `gh pr create`,
 * `gh pr merge`, comment, ready, close, reopen and the Actions reads all run
 * SERVER-side with the orchestrator's own credential and never hand the agent a
 * token, so a token-less container could still act on GitHub through them.
 *
 * It was survivable while the grant was fixed at creation — a sandbox created
 * with GitHub access off had a container wired for it from the start, and the
 * question "what happens when it is revoked?" could not arise. Making the set
 * editable is what raises it, and requirement 2 answers it: a change the live
 * container can honour applies straight away. A revoke that leaves fifteen
 * brokered verbs open is not a revoke.
 *
 * Deliberately applied to the READS as well (`pr/list`, `pr/view`, the Actions
 * routes): they read through the user's credential and can reach private repos,
 * so "GitHub access" not covering them would be a surprising carve-out.
 *
 * A no-op for every non-sandbox session — `gitCredentialAllowed` denies only a
 * sandbox with `git` explicitly off — so this changes nothing for repo-bound or
 * ops sessions. 403 rather than 404: the session exists, the capability does not.
 */
function gitBrokerDenied(
  session: Pick<SessionInfo, "kind" | "capabilities"> | undefined,
  reply: FastifyReply,
): boolean {
  // An absent session is not this guard's business — the handler's own 404 (or
  // its deliberate `session ?? { remoteUrl: "" }` fallback) still decides.
  if (!session || gitCredentialAllowed(session)) return false;
  reply.code(403).send({ error: "GitHub access is not granted for this sandbox session" });
  return true;
}

/** Bounds for `-L/--limit`, matching what the Actions list already clamps to. */
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;

/**
 * Parse a `?limit=` query parameter for the list reads.
 *
 * A supplied-but-nonsense value is refused rather than dropped. The Actions
 * list used to drop it (`Number.isFinite` guarding a spread), so `-L abc` and
 * `-L -5` both ran with the default limit and exited 0 — the caller was told a
 * number they did not ask for. Only an ABSENT parameter stays absent, and the
 * service then picks its own default; `?limit=` was supplied.
 *
 * The digits-only test matches the shim's `parseLimit` deliberately. These
 * routes are `containerAccessible`, so this is a trust boundary in its own
 * right — a bare `Number()` would accept `1e2`, `0x10` and `1.0` here while the
 * shim rejected them, which is two different answers to the same question.
 */
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

  // ---- GitHub reads ----

  // GET /api/sessions/:id/pr/status — PR status
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
      // The only `resolvePrTarget` call site that lacked this, so a bad
      // `--repo` would have surfaced here as a 500 rather than the 400 every
      // other PR verb answers.
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
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

        // docs/287 — provenance, for a pull request this call actually opened.
        recordWitnessedPrCreate(sessionManager, request.params.id, result);

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
        // docs/287 — this route always CREATES (it has no discovery path), so a
        // success is a witnessed create and records provenance.
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
          // Pass session + runner context so the service can flush any
          // pending working-tree changes (commit + cancel pending auto-push)
          // before pushing. The agent calls `gh pr create` mid-turn, before
          // the normal end-of-turn `postTurnCommit` has fired — without the
          // flush, those edits wouldn't appear on the PR.
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          ...(deps.cancelAutoPush ? { cancelAutoPush: deps.cancelAutoPush } : {}),
          chatHistory: deps.chatHistoryManager,
        });
        // docs/287 — provenance. Skipped for a pull request that was already
        // open on the branch, and for one `--repo` opened somewhere else.
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
        // docs/214 cold-start guard: for a `release-branch` repo, warn at propose
        // time when merging into the maintenance branch won't auto-publish yet
        // (no / legacy workflow on the branch) — a merge would otherwise look
        // successful while silently producing no tag and no Release. rc's go via
        // the tag path, so they're exempt.
        if (rel.mechanism === "release-branch" && !plan.prerelease) {
          const branch = rel.branch ?? "stable";
          await git.fetch("origin");
          const assessment = await assessMergeAutoPublish(git, branch);
          if (assessment.warning) plan.warning = assessment.warning;
        }
        // Reflect a `proposed` card (informational for final releases; the rc
        // path's confirm gate also reads it). Requires a GitHub remote to poll.
        if (deps.releaseStatusPoller && remoteUrl) {
          // Carry the mechanism so the proposed card's "Confirm & publish"
          // wording matches the repo (release-branch vs tag-triggered). Mirrors
          // the marker path in release-flow.ts; absent → card defaults to
          // tag-triggered. (docs/214)
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
        // nikzlabs/shipit#2429 — `prepare` re-materializes the worktree from the
        // orchestrator (a `checkout -B` onto the release branch, plus the
        // cherry-picks or the `--from` merge-override), so it can leave the live
        // session on a tree whose lockfile the container never installed. Gated
        // on the target being the session's OWN clone: `resolvePrTarget` sends a
        // `--repo`/`--cwd` release at a different one, whose dependencies are
        // not this session's to reinstall.
        //
        // In a `finally`, because `prepareRelease` REWRITES THE TREE BEFORE most
        // of the ways it can fail: the content-free guard, the no-op-bump 500,
        // the force-push, `agentCreatePr`'s own errors and the two release-PR
        // guards all throw after `createBranchFrom` has already checked out the
        // release branch and applied the payload. Notifying only on success left
        // exactly those failures — the routinely-hit ones — with the container
        // still on its pre-prepare `shipit.yaml`, compose file and node_modules,
        // which is the condition `workspace-rewrite.ts` exists to prevent.
        //
        // Gated on `treeRewritten` rather than fired unconditionally, because
        // the notification is NOT free: `reevaluateWorkspaceConfig` can rerun
        // service setup or queue a Compose reconcile (which clears the service
        // map, poller and log followers), and `notifyWorkspaceRewritten` opens
        // the install gate, tearing down install-gated preview services before
        // the content-key marker is checked. Firing that after an auth failure,
        // a dirty tree or a prerelease tag — none of which touch the worktree —
        // would disrupt a live session for no reason. `prepareRelease` reports
        // the one moment that matters, so this asks it instead of guessing.
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

        // docs/214 — surface the release PR as the session's inline PR lifecycle
        // card so the user can merge it from inside ShipIt (CLAUDE.md §1/§2). The
        // release PR's head is `release/<version>`, not `session.branch`, so the
        // PR poller can't match it until the session adopts that branch. Guard to
        // the session's OWN repo: a sandbox `--repo` clone's PR lives in a
        // different repo than the one the poller polls for this session, so
        // repointing the branch there would point the poller at a phantom branch.
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

        // docs/214 cold-start guard: a bump PR can merge cleanly yet auto-publish
        // nothing when the maintenance branch lacks the merge-triggered workflow
        // (GitHub evaluates the workflow as it exists on the pushed branch). Read
        // the branch's workflow *after* prepare's fetch — which also reflects a
        // `--bootstrap` that just seeded the branch off `main` — and attach an
        // actionable warning so the merge never looks successful while it no-ops.
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
      // planning#81) over the long-lived PAT, shrinking the blast radius of an
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

  // GET /api/sessions/:id/pr/list?state=open — list PRs for the session's repo
  app.get<{ Params: { id: string }; Querystring: { state?: string; limit?: string; cwd?: string; repo?: string } }>(
    "/api/sessions/:id/pr/list",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        const session = sessionManager.get(request.params.id);
        if (gitBrokerDenied(session, reply)) return;
        // Absent still means `open` — in-container callers rely on that. But an
        // explicitly-supplied unknown value is refused by name rather than
        // degrading to the default: the old fallback turned `?state=merged`
        // into a list of OPEN PRs, which reads like a valid answer.
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

  // GET /api/sessions/:id/pr/view — view PR details (current branch's PR by default)
  // GET /api/sessions/:id/pr/view?number=N — view a specific PR
  // GET /api/sessions/:id/pr/view?comments=true — also read the PR's
  //   conversation (issue comments, reviews, inline review threads). Opt-in
  //   because it costs a second round-trip; the merge-polling path
  //   (`--json state`) never asks for it. docs/255.
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

  // ---- GitHub Actions (back `gh run` / `gh workflow`) ----
  //
  // Repo-aware (cwd/repo) like the PR ops above, and container-accessible so the
  // gh shim can broker them. Reads, plus one write — `actions/runs/rerun`, which
  // re-executes an already-committed workflow on the session's own branch. There
  // is deliberately no route to *dispatch* a workflow, or to cancel or delete a
  // run: those choose new code or destroy state, and stay human/CI actions.

  // GET /api/sessions/:id/actions/runs — list workflow runs
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

  // GET /api/sessions/:id/actions/runs/view — view one run (id optional → latest)
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

  // POST /api/sessions/:id/actions/runs/rerun — re-run an existing run.
  //
  // The one Actions write in this group. Deliberately NOT paired with dispatch /
  // cancel / delete: re-running re-executes already-committed workflow content
  // against an existing commit, which the agent already triggers on every turn
  // via auto-push. The service enforces the own-branch guardrail.
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
        // Re-validate rather than trust the shim's check: this route is reachable
        // from the container directly. Decimal digits only — `Number()` alone
        // would accept "1e3"/"0x2a"/1.5/true and address a different run.
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

  // GET /api/sessions/:id/actions/workflows — list workflow definitions
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

  // GET /api/sessions/:id/actions/workflows/view — view one workflow + recent runs
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

  // POST /api/sessions/:id/pr/merge — merge pull request
  app.post<{ Params: { id: string }; Body: { method?: string } }>(
    "/api/sessions/:id/pr/merge",
    async (request, reply) => {
      const dir = resolveSessionDir(sessionManager, request.params.id, reply);
      if (!dir) return;
      try {
        // Block merge while the agent is still working. Auto-commit fires after
        // the turn ends (see post-turn.ts), so merging now could ship a PR
        // whose later commits land on a branch with a closed PR — orphaned
        // work. The client also disables the button, but a stale tab or
        // race could still POST here, so enforce on the server too.
        //
        // docs/266 — `agentBusy`, widened from bare `running`. The window this
        // guard exists to close does not end when `running` clears: the commit,
        // the debounced auto-push it arms, and a backgrounded review consult all
        // run past that point and all still produce commits to push. Same
        // predicate the managed auto-merge loop now uses, for the same reason.
        const runner = deps.runnerRegistry.get(request.params.id);
        if (runner?.agentBusy) {
          reply.code(409).send({ error: "Agent still working — wait for it to finish before merging" });
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
          // Case (a) only blocks while the grace window is still open. Past
          // its deadline the empty check set is terminal ("no CI applies to
          // this PR"), which is exactly when the client shows the merge
          // button — so the two must agree or the button 400s forever.
          // `graceUntil` is absent on summaries predating docs/230; treat
          // those as still-in-grace, matching the old behavior.
          const grace = prStatus.checks.graceUntil;
          if (
            prStatus.checks.state === "pending"
            && prStatus.checks.total === 0
            && (grace === undefined || Date.now() < grace)
          ) {
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

        // Would this merge ship what the session actually produced? Every gate
        // above asks about the state GitHub holds; none of them can see that
        // the state GitHub holds is simply OLD. ShipIt pushes on a debounce and
        // never force-pushes, so a rejected or still-pending push leaves the
        // branch on GitHub frozen at its last successful push while the session
        // carries the rest — and the pull request looks perfectly mergeable.
        //
        // Resolved here against the LIVE remote rather than trusted from the
        // poller summary: the summary is what the client gates on, and a stale
        // tab is exactly the caller this route exists to catch. `ahead` pushes
        // and answers "not yet" (the new head's checks have not run);
        // `diverged` refuses. Anything unknowable proceeds — see
        // `services/branch-sync.ts`, which also resolves WHICH branch to read
        // (the workspace's current one, the same branch `mergePullRequest`
        // below resolves its pull request from).
        const verdict = await guardMergeSync(git);
        if (verdict.action === "hold") {
          // A push may have landed, so let the poller re-read the branch —
          // otherwise the card keeps the old head until the next tick and the
          // user's second click is gated on stale checks.
          if (poller && session?.remoteUrl) {
            await poller.forceRefreshSession(request.params.id).catch(() => {});
          }
          return { success: false, message: verdict.message };
        }

        // docs/266 — this route can end in an ARMING rather than a merge (checks
        // still running). A live session's arming stays on ShipIt's managed
        // loop, where the busy gate holds it; GitHub native would merge the PR
        // during a later turn with no idea one was running.
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

  // POST /api/sessions/:id/pr/:number/merge — agent-driven merge, backing
  // `gh pr merge`. Two grants reach it, one per session kind: a sandbox's
  // `dangerousGitHubOps` capability (docs/224) and, for a repo-bound session,
  // the repository's `allow_agent_merge` plus the ownership tuple (docs/287).
  //
  // Deliberately separate from the UI merge route above: it merges an explicit
  // PR number (repo-aware via cwd/repo), and it does NOT apply that route's
  // "block while the agent is running" guard — the agent calls this mid-turn, so
  // its own runner is always running. The check/review guardrails live in
  // `agentMergePullRequest` (the poller doesn't track sandbox PRs).
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
      // docs/224 — gate the dangerous verb. Distinct messages so the agent knows
      // whether this is a "wrong session kind" (use the PR card), "not opted in"
      // for this sandbox, or "not granted in this repository" (docs/287).
      //
      // The grant is read here, from ShipIt's own repository record, and is
      // never derived from anything inside the workspace: the agent can write
      // `shipit.yaml`, so a permission declared there would be one it could give
      // itself. A session with no remote resolves to no identity and no grant.
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
      // docs/287 req 5 — a repo-bound merge may only touch the pull request this
      // session opened. Checked BEFORE `resolvePrTarget`, because that call is
      // what a `--repo` override would retarget: validating after it would check
      // this session's repository and then act on a different one.
      //
      // Sandbox merges skip this entirely (req 12): a sandbox has no session
      // remote, no ShipIt-recorded branch and no provenance, and its own
      // `dangerousGitHubOps` grant already decided.
      const repoBound = session.kind !== "sandbox";
      // The poller keys everything by `owner/repo`. Absent for a sandbox, whose
      // repository is whatever it cloned — and which has no grace hook anyway.
      const parsedRemote = session.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
      const mergeRepoKey = parsedRemote ? `${parsedRemote.owner}/${parsedRemote.repo}` : null;
      // docs/287 req 9 — the claim is repo-bound only. A sandbox's pull request
      // is not the session's own, has no provenance, and no session state to
      // settle into, so there is nothing for a claim to protect.
      const claimRepoId = repoBound ? repoId(session.remoteUrl ?? "") : null;
      // A repo-bound merge without a claim store cannot be recorded, and a merge
      // ShipIt cannot record is one it will not perform. `route-registry.ts`
      // always supplies one; this refuses rather than failing open on a
      // hand-built or degraded server (cross-agent review finding).
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
      let turnId: string | null = "n/a";
      // One try from here on: the ownership check, the flush and the sync guard
      // all touch git, and a throw from any of them is the same "could not
      // establish that this merge is safe" answer as one from the merge itself.
      try {
      if (repoBound) {
        // A workspace that cannot be READ is its own answer, kept apart from the
        // branch comparison below: `null` there means "on no named branch", and
        // reporting an evicted or broken workspace as a detached HEAD would send
        // the agent to check out a branch in a directory it cannot open.
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
        // req 9 — the merge is turn-owned, and the route proves it rather than
        // assuming it. This endpoint is `containerAccessible` and the worker
        // injects only a session id, so without this a process inside the
        // container could merge after its turn ended, or during a later one,
        // attaching its flush, its claim and its transcript record to the wrong
        // turn. `running` alone is a mutable boolean that says SOMETHING is
        // running; the recorded identity is what says it is still this one.
        //
        // Placed AFTER the ownership checks and before the first mutation: the
        // ownership refusals are the agent's likeliest mistakes and deserve
        // their specific message, while everything below this line changes
        // state and is what the turn requirement exists to own.
        turnId = claimDeps ? activeTurnIdFor(deps.runnerRegistry, request.params.id) : "n/a";
        if (claimDeps && !turnId) {
          reply.code(409).send({
            error:
              "Not merged — `gh pr merge` runs as part of a turn, and this session has no turn "
              + "running. Merge from the PR lifecycle card in the ShipIt UI instead.",
          });
          return;
        }

        // docs/287 reqs 14 + 15 — the agent works INSIDE the turn and ShipIt's
        // auto-commit runs after it, so without this the merge would ship the
        // branch as it stood BEFORE this turn's edits and report success. The
        // sandbox path never showed this because a sandbox has no ShipIt
        // auto-commit; extending to repo-bound sessions is what exposes it.
        //
        // Only two outcomes may proceed. The other four each mean "this turn's
        // work is not on the branch", and merging on any of them ships a branch
        // missing the work the merge was asked to land.
        const flush = await flushPendingTurnCommit(createGitManager(dir), {
          sessionId: request.params.id,
          runnerRegistry: deps.runnerRegistry,
          chatHistory: deps.chatHistoryManager,
        });
        if (flush.kind !== "committed" && flush.kind !== "nothing-to-commit") {
          reply.code(422).send({ error: mergeFlushRefusal(flush) });
          return;
        }

        // docs/287 req 17 — and now the branch has to actually be on GitHub.
        // `ahead` is repaired by pushing rather than refused, but the merge
        // still does not proceed: the push moved the head, so every check the
        // gate is about to read describes the previous commit.
        const verdict = await guardMergeSync(createGitManager(dir));
        if (verdict.action === "hold") {
          // The debounced auto-push may be dropped ONLY when a synchronous push
          // replaced it. It is session-keyed in `services/auto-push-scheduler.ts`
          // and lives for the process, so cancelling one that nothing replaced
          // strands the commit with no retry and no error.
          if (verdict.pushed) deps.cancelAutoPush?.(request.params.id);
          reply.code(409).send({
            error: verdict.pushed
              ? `${verdict.message} (Merge again once the checks on the new head report.)`
              : verdict.message,
          });
          return;
        }
      }
        const { gitDir, remoteUrl } = resolvePrTarget(session, dir, request.body ?? {});
        const git = createGitManager(gitDir);
        // req 14 — the pull request's head must be the commit this workspace is
        // on. A repo-bound session that cannot answer WHICH commit that is has
        // not passed the check, so the failure is REPORTED rather than turned
        // into an absent value: the gate used to read `null` as "a sandbox,
        // which owns its own git and has nothing to compare", so a failed read
        // here silently bought a merge with no local comparison at all
        // (cross-agent review finding).
        let localHead: { kind: "head"; sha: string } | { kind: "unreadable"; reason: string } | undefined;
        if (repoBound) {
          try {
            const sha = await git.getHeadHash();
            // `getHeadHash` answers null for an unborn or unreadable HEAD, which
            // is the same "cannot confirm which commit this is" as a throw.
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
          // Read after the flush and push above, so it is the commit those two
          // just produced.
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
          ...(claimDeps && claimRepoId && turnId
            ? {
              // docs/287 req 9 — the durable claim, written synchronously in the
              // instant before the REST call, and resolved by exactly one of the
              // three outcome hooks.
              beforeMerge: (expectedSha: string) => {
                // req 1 — the permission is withdrawable AT ANY TIME, and the
                // decision to merge was taken before a commit, a push and two
                // GitHub round trips. Re-read from ShipIt's own record, the same
                // source the first check used.
                const live = sessionManager.get(request.params.id);
                if (!live) return "Not merged — this session no longer exists.";
                if (mergeDisposition(live, deps.repoStore.allowsAgentMerge(live.remoteUrl ?? "")) !== "allowed") {
                  return "Not merged — the permission to merge in this repository was withdrawn while "
                    + "ShipIt was preparing the merge. Nothing was merged.";
                }
                // And the pull request must still be the one this session owns:
                // a re-arm, an unarchive or a repointed `origin` during the same
                // window clears the provenance this merge was authorised by.
                if (live.prNumber !== num || live.prRepoId !== claimRepoId) {
                  return `Not merged — PR #${num} is no longer the pull request ShipIt opened for `
                    + "this session. Nothing was merged.";
                }
                if (!claimDeps.claims.claim({
                  sessionId: request.params.id,
                  repoId: claimRepoId,
                  prNumber: num,
                  expectedSha,
                  turnId: turnId ?? "n/a",
                })) {
                  // Single-flight: a row is already outstanding for this session.
                  return "Not merged — an earlier merge on this session has not been resolved yet, and "
                    + "ShipIt will not start a second one over it. It resolves that attempt at the end "
                    + "of the turn; try again after that.";
                }
                return null;
              },
              onMerged: async (expectedSha: string) => {
                const claim = claimDeps.claims.get(request.params.id);
                if (claim?.expectedSha !== expectedSha) return "settled";
                claimDeps.claims.markSettling(request.params.id, expectedSha);
                const outcome = await settleAgentMerge(
                  claimDeps, { ...claim, state: "settling" }, { witnessed: true },
                );
                return outcome.result === "settled" ? "settled" : "deferred";
              },
              // A definitive refusal merged nothing — but `releaseUnmerged`
              // refuses to drop a row that has reached `settling`, which is a
              // concurrent request's merge that DID happen.
              onRefused: (expectedSha: string) => {
                claimDeps.claims.releaseUnmerged(request.params.id, expectedSha);
                return Promise.resolve();
              },
              // Deliberately does NOT release: the merge may have happened, and
              // the row is the only evidence reconciliation has to resolve it.
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

  // POST /api/sessions/:id/pr/description — generate PR description via LLM
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
