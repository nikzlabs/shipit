import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import { emitChatCard, persistCardTransition } from "./chat-card-persistence.js";
import type { RepoSessionProposalCard } from "../shared/types.js";
import { validateRepoSessionProposal } from "../shared/repo-session-proposal-validation.js";
import { repoId, repoIdFromOwnerRepo } from "./git-utils.js";
import { ensureBareCache } from "./repo-git.js";
import {
  createClaimSessionService,
  ensureRepoReady,
  listRepos,
  spawnChildSession,
  ServiceError,
} from "./services/index.js";
import { getErrorMessage } from "./validation.js";
import type { SessionRunnerInterface } from "./session-runner.js";

/**
 * Resolve what the agent typed to a repository IDENTITY, then build every URL
 * from that identity rather than from the input.
 *
 * The input is never used as a clone URL. `parseGitHubRemote` is unanchored, so
 * `https://attacker.example/github.com/acme/api.git` reads as `acme/api` — a card
 * that displays and authorizes one repository while cloning from another host.
 * `repoId` is the anchored parser, and it also folds https/ssh/case together so
 * the own-repository guard cannot be stepped around by respelling the remote.
 */
function resolveTarget(repo: string): { owner: string; name: string; id: string; cloneUrl: string } | null {
  const trimmed = repo.trim().replace(/\/+$/, "");
  const shorthand = /^([a-zA-Z0-9_.-]+)\/([a-zA-Z0-9_.-]+)$/.exec(trimmed);
  const id = shorthand
    ? repoIdFromOwnerRepo(shorthand[1], shorthand[2].replace(/\.git$/i, ""))
    : repoId(trimmed);
  if (!id) return null;

  const [owner, name] = id.slice("github:".length).split("/");
  if (!owner || !name) return null;
  return { owner, name, id, cloneUrl: `https://github.com/${owner}/${name}.git` };
}

export async function registerProposeRepoSessionRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const graduationDeps = {
    sessionManager: deps.sessionManager,
    runnerRegistry: deps.runnerRegistry,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    ...(deps.prStatusPoller ? { prStatusPoller: deps.prStatusPoller } : {}),
    sseBroadcast: deps.sseBroadcast,
    ...(deps.ensureAgentTokenFresh ? { ensureAgentTokenFresh: deps.ensureAgentTokenFresh } : {}),
    providerAccountManager: deps.providerAccountManager,
    ...(deps.credentialsDir ? { credentialsDir: deps.credentialsDir } : {}),
    credentialStore: deps.credentialStore,
    chatHistoryManager: deps.chatHistoryManager,
    usageManager: deps.usageManager,
  };

  // Share the claim service: its per-repo lock lives in the instance's closure.
  const claimSessionService = deps.claimSessionService ?? createClaimSessionService({
    sessionManager: deps.sessionManager,
    repoStore: deps.repoStore,
    createGitManager: deps.createGitManager,
    createRepoGit: deps.createRepoGit,
    githubAuthManager: deps.githubAuthManager,
    getSharedRepoDir: deps.getSharedRepoDir,
    createSessionDirFull: deps.createSessionDirFull,
    sseBroadcast: deps.sseBroadcast,
    ...(deps.warmSessionForRepo ? { warmSessionForRepo: deps.warmSessionForRepo } : {}),
    ...(deps.waitForWarmSession ? { waitForWarmSession: deps.waitForWarmSession } : {}),
    ...(deps.shouldSkipClaimFetch ? { shouldSkipClaimFetch: deps.shouldSkipClaimFetch } : {}),
    ...(deps.containerManager ? { containerManager: deps.containerManager } : {}),
    ...(deps.egressAllowlistStore ? { egressAllowlistStore: deps.egressAllowlistStore } : {}),
  });

  app.post<{
    Params: { sessionId: string };
    Body: { repo?: unknown; title?: unknown; prompt?: unknown };
  }>(
    "/api/sessions/:sessionId/propose-repo-session",
    { config: { containerAccessible: true } },
    async (request, reply: FastifyReply) => {
      const { sessionId } = request.params;

      const validated = validateRepoSessionProposal(request.body ?? {});
      if ("error" in validated) {
        reply.code(400).send({ error: validated.error });
        return;
      }

      const session = deps.sessionManager.get(sessionId);
      if (!session) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }

      const target = resolveTarget(validated.repo);
      if (!target) {
        reply.code(400).send({
          error:
            `Could not read "${validated.repo}" as a GitHub repository. `
            + "Use `owner/repo`, or a github.com clone URL.",
        });
        return;
      }
      const repoLabel = `${target.owner}/${target.name}`;

      if (session.remoteUrl && repoId(session.remoteUrl) === target.id) {
        reply.code(400).send({
          error:
            `${repoLabel} is the repository this session is already on. `
            + "Propose a session only for work that belongs somewhere else; do this work here.",
        });
        return;
      }

      // Checked now, so a repository the agent got wrong fails back to the AGENT,
      // which can correct itself this turn, rather than under the user's click.
      const access = await deps.githubAuthManager.checkRepoWriteAccess(target.owner, target.name);
      if (!access.reachable) {
        // Reachability, not write access: requirement 8 makes any repository the
        // user's token can reach a valid target. A read-only one is still a valid
        // checkout; only a name the account cannot SEE is a name to fix.
        reply.code(403).send({
          error:
            `ShipIt's GitHub connection cannot reach ${repoLabel}: ${access.reason ?? "not reachable"}. `
            + "Check the repository name, or tell the user that the connected GitHub account "
            + "cannot see this repository.",
        });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);
      if (!runner) {
        reply.code(409).send({ error: "Session is not active — open it to propose a session." });
        return;
      }

      const known = deps.repoStore.list().find((r) => repoId(r.url) === target.id);

      const card: RepoSessionProposalCard = {
        cardId: `repo-session-${randomUUID()}`,
        repo: repoLabel,
        repoUrl: known?.url ?? target.cloneUrl,
        registered: Boolean(known),
        ...(access.canWrite ? {} : { readOnly: true }),
        title: validated.title,
        prompt: validated.prompt,
        createdAt: new Date().toISOString(),
      };

      emitChatCard(
        runner,
        { type: "repo_session_proposal_card", sessionId, card },
        { role: "assistant", text: "", repoSessionProposal: card },
        { chatHistoryManager: deps.chatHistoryManager, sessionId },
      );

      return { ok: true, cardId: card.cardId, repo: card.repo, registered: card.registered };
    },
  );

  // Claimed synchronously: the persisted `starting` state is written behind an
  // await, so two fast clicks would both read `undefined` and start two sessions.
  const startsInFlight = new Set<string>();

  // The user's click. Not container-accessible: the agent proposes, the user starts.
  app.post<{ Params: { sessionId: string; cardId: string } }>(
    "/api/sessions/:sessionId/repo-session-proposals/:cardId/start",
    async (request, reply: FastifyReply) => {
      const { sessionId, cardId } = request.params;

      if (startsInFlight.has(cardId)) {
        reply.code(409).send({ error: "That session is already starting." });
        return;
      }

      const card = deps.chatHistoryManager.findRepoSessionProposalCard(sessionId, cardId);
      if (!card) {
        reply.code(404).send({ error: "That proposal is no longer in this session's history." });
        return;
      }
      // A persisted `starting` with nothing in flight here is a crashed
      // predecessor's leftover, not a live start — let the retry through, or the
      // card is stuck on a spinner forever.
      if (card.state === "started") {
        reply.code(409).send({
          error: "That session was already started.",
          startedSessionId: card.startedSessionId,
        });
        return;
      }

      const runner = deps.runnerRegistry.get(sessionId);

      const patch = (fields: Partial<RepoSessionProposalCard>): void => {
        if (runner) {
          runner.emitMessage({
            type: "repo_session_proposal_update",
            sessionId,
            cardId,
            state: fields.state ?? "starting",
            ...(fields.startedSessionId ? { startedSessionId: fields.startedSessionId } : {}),
            ...(fields.startedAt ? { startedAt: fields.startedAt } : {}),
            ...(fields.errorMessage ? { errorMessage: fields.errorMessage } : {}),
          });
        }
        persistRepoSessionProposalTransition(deps, runner, sessionId, cardId, fields);
      };

      startsInFlight.add(cardId);
      patch({ state: "starting", errorMessage: undefined });

      try {
        // The repository may be one ShipIt has never cloned; a claim needs it ready.
        const readyUrl = await ensureRepoReady(card.repoUrl, {
          repoStore: deps.repoStore,
          getSharedRepoDir: deps.getSharedRepoDir,
          ensureBareCache: (cacheDir, url) => ensureBareCache(cacheDir, url, deps.createRepoGit),
        });

        // A repository added here reaches the browser only through this broadcast;
        // without it the new session appears under an orphan host group until reload.
        if (!card.registered) {
          deps.sseBroadcast("repo_status", { url: readyUrl, status: "ready" });
          deps.sseBroadcast("repo_list", { repos: listRepos(deps.repoStore) });
        }

        // Detached: the new session must not nest under this one, because a nested
        // session reads as belonging to this repository (docs/303 req 6).
        const result = await spawnChildSession(
          deps.sessionManager,
          deps.runnerRegistry,
          claimSessionService,
          sessionId,
          {
            prompt: card.prompt,
            title: card.title,
            detached: true,
            repoUrlOverride: readyUrl,
            // The card showed the user this prompt; a role inherited from THIS
            // session would append its standing instructions to it and start the
            // target on work the user never saw (e.g. a reviewer told not to edit).
            target: { kind: "inherit", overrides: {}, noRole: true },
          },
          deps.defaultAgentId,
          deps.credentialsDir,
          deps.credentialStore,
          deps.providerAccountManager,
          graduationDeps,
        );

        const startedAt = new Date().toISOString();
        patch({ state: "started", startedSessionId: result.sessionId, startedAt });
        return { ok: true, startedSessionId: result.sessionId, startedAt };
      } catch (err) {
        const message = err instanceof ServiceError
          ? err.message
          : `Could not start a session on ${card.repo}: ${getErrorMessage(err)}`;
        patch({ state: "failed", errorMessage: message });
        reply.code(err instanceof ServiceError ? err.statusCode : 500).send({ error: message });
        return;
      } finally {
        startsInFlight.delete(cardId);
      }
    },
  );
}

function persistRepoSessionProposalTransition(
  deps: ApiDeps,
  runner: SessionRunnerInterface | undefined,
  sessionId: string,
  cardId: string,
  patch: Partial<RepoSessionProposalCard>,
): void {
  const write = () => deps.chatHistoryManager.updateRepoSessionProposalCard(sessionId, cardId, patch);
  if (!runner) {
    write();
    return;
  }
  persistCardTransition(
    runner,
    { chatHistoryManager: deps.chatHistoryManager, sessionId },
    (m) => m.repoSessionProposal?.cardId === cardId,
    (m) => ({ ...m, repoSessionProposal: { ...m.repoSessionProposal!, ...patch } }),
    write,
  );
}
