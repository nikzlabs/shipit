/**
 * Issue tracker routes (docs/170 — inline tracker Issues tab; SHI-80).
 *
 * These are global `/api/...` routes, not `/api/sessions/:id/...`, because
 * Linear is deployment-wide. GitHub Issues, however, are **per-repo**, so the
 * read routes accept an optional `?sessionId` and resolve that session's GitHub
 * remote + token into a `GitHubTrackerContext` for the registry. Linear ignores
 * the session entirely (its binding is the workspace team). Read-only +
 * connect/bind for Linear; write-back and the GitHub `/shipit` push trigger
 * remain out of scope (SHI-43 / docs/156).
 */

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  listTrackers,
  listIssuesForTracker,
  getIssueForTracker,
  listIssueCommentsForTracker,
  addIssueCommentForTracker,
  createIssueForTracker,
  commentOnIssueForTracker,
  updateIssueForTracker,
  setIssueStatusForTracker,
  setIssueAssigneeForTracker,
  connectLinear,
  getLinearTeams,
  setLinearTeam,
  disconnectLinear,
  ServiceError,
  type IssueWriteOutcome,
} from "./services/index.js";
import type { GitHubTrackerContext } from "./trackers/index.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { TrackerId, TrackerIssue, IssueWriteCard, IssueRefCard } from "../shared/types.js";
import { parseGitHubRemote } from "./git-utils.js";
import { getErrorMessage } from "./validation.js";
import { emitChatCard } from "./chat-card-persistence.js";

/**
 * Resolve the GitHub tracker context for a request: ShipIt's existing GitHub
 * token plus the repo derived from a session's remote. Either piece may be null
 * (GitHub not connected, no session, or a non-GitHub remote) — the adapter then
 * reports unconfigured. Exported so the undo WS handler resolves it the same
 * way the routes do.
 */
export function resolveGitHubTrackerContext(
  githubAuthManager: GitHubAuthManager,
  sessionManager: SessionManager,
  sessionId?: string,
): GitHubTrackerContext {
  const token = githubAuthManager.getToken();
  const remoteUrl = sessionId ? sessionManager.get(sessionId)?.remoteUrl : undefined;
  const parsed = remoteUrl ? parseGitHubRemote(remoteUrl) : null;
  return { token, repo: parsed ? { owner: parsed.owner, repo: parsed.repo } : null };
}

/**
 * Whether a `TrackerIssue.status.type` represents a finished issue. Both GitHub
 * (closed → "completed") and Linear ("completed"/"canceled") normalize onto the
 * same vocabulary, so a `--state closed` filter is tracker-neutral.
 */
function isDoneStatus(type?: string): boolean {
  return type === "completed" || type === "canceled";
}

export async function registerIssueRoutes(
  app: FastifyInstance,
  deps: ApiDeps,
): Promise<void> {
  const { credentialStore, trackerFetchImpl, sessionManager, githubAuthManager } = deps;

  const resolveGitHubContext = (sessionId?: string): GitHubTrackerContext =>
    resolveGitHubTrackerContext(githubAuthManager, sessionManager, sessionId);

  /**
   * Surface a read-only navigation card when the agent views an issue
   * (`shipit issue view`, docs/188). The read-path sibling of the write
   * provenance card — so any agent issue interaction, not just edits, leaves a
   * jump-to-issue affordance in the transcript. It has no lifecycle (no undo),
   * so the full payload rides on the persisted message and renders without a
   * client store.
   *
   * Best-effort: a `view` must still succeed and return the issue to the shim
   * even when no runner is attached (read fired outside an active turn) or the
   * issue was already carded this turn — so this never throws and silently
   * no-ops in those cases.
   */
  function emitIssueReadCard(sessionId: string, trackerId: string, issue: TrackerIssue): void {
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) return;
    // Per-turn dedup: the agent often re-views the same issue within a turn
    // (e.g. to re-check available statuses before a write). `recordedCards`
    // resets each turn, so one card per issue per turn is the right grain.
    const carded = runner.recordedCards.some(
      (c) =>
        c.message.issueRef?.tracker === trackerId &&
        c.message.issueRef?.identifier === issue.identifier,
    );
    if (carded) return;
    const card: IssueRefCard = {
      cardId: `issue-ref-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      identifier: issue.identifier,
      title: issue.title,
      ...(issue.url ? { url: issue.url } : {}),
      ...(issue.status?.name ? { status: issue.status.name } : {}),
      ...(issue.status?.type ? { statusType: issue.status.type } : {}),
      createdAt: new Date().toISOString(),
    };
    emitChatCard(
      runner,
      { type: "issue_ref_card", sessionId, card },
      { role: "assistant", text: "", issueRef: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
  }

  // GET /api/trackers — configured-tracker metadata (drives the sub-tabs).
  app.get<{ Querystring: { sessionId?: string } }>("/api/trackers", async (request) => {
    const github = resolveGitHubContext(request.query.sessionId);
    return { trackers: listTrackers(credentialStore, trackerFetchImpl, github) };
  });

  // GET /api/issues?tracker=linear[&includeDone=true][&sessionId=...] —
  // priority-sorted issue list for one tracker. `includeDone` widens the default
  // open working set to also include completed/"done" issues (canceled stays
  // excluded). `sessionId` scopes the GitHub tracker to that session's repo.
  app.get<{ Querystring: { tracker?: string; includeDone?: string; sessionId?: string } }>(
    "/api/issues",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "linear";
      const includeDone = request.query.includeDone === "true";
      const github = resolveGitHubContext(request.query.sessionId);
      try {
        return await listIssuesForTracker(credentialStore, trackerId, trackerFetchImpl, github, {
          includeDone,
        });
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list issues: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/issue?tracker=&id=[&sessionId=] — fetch one fully-hydrated issue
  // for the inline detail view (docs/189). The UI's own read path: unlike the
  // agent's session-scoped `issue/view`, it surfaces NO transcript card and is
  // global (Linear is workspace-wide; `sessionId` only scopes the GitHub tracker
  // to that session's repo, exactly like `GET /api/issues`). `id` is the
  // tracker-native lookup id — a Linear key/UUID or a bare GitHub issue number.
  app.get<{ Querystring: { tracker?: string; id?: string; sessionId?: string } }>(
    "/api/issue",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "linear";
      const github = resolveGitHubContext(request.query.sessionId);
      try {
        return await getIssueForTracker(
          credentialStore,
          trackerId,
          request.query.id ?? "",
          trackerFetchImpl,
          github,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read issue: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/issue/comments?tracker=&id=[&sessionId=] — the comment thread for
  // the inline detail view (docs/189 follow-up). Public read, like GET /api/issue:
  // Linear is workspace-wide; `sessionId` only scopes the GitHub tracker to the
  // session's repo. Emits no transcript card.
  app.get<{ Querystring: { tracker?: string; id?: string; sessionId?: string } }>(
    "/api/issue/comments",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "linear";
      const github = resolveGitHubContext(request.query.sessionId);
      try {
        return await listIssueCommentsForTracker(
          credentialStore,
          trackerId,
          request.query.id ?? "",
          trackerFetchImpl,
          github,
        );
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read comments: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/issue/comments { tracker, id, body, sessionId? } — a user posting a
  // comment from the inline detail view (docs/189 follow-up). Unlike the agent's
  // session-scoped comment write, this is the user's own action: it surfaces NO
  // provenance card and has no undo. Returns the created comment so the client
  // appends it to the open thread. `sessionId` only scopes the GitHub tracker.
  app.post<{ Body: { tracker?: string; id?: string; body?: string; sessionId?: string } }>(
    "/api/issue/comments",
    async (request, reply) => {
      const { tracker, id, body, sessionId } = request.body ?? {};
      if (!tracker || !id || !body?.trim()) {
        reply.code(400).send({ error: "tracker, id and body are required" });
        return;
      }
      const github = resolveGitHubContext(sessionId);
      try {
        return await addIssueCommentForTracker(credentialStore, tracker, id, body, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to post comment: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // Session-scoped agent read path (docs/175 — `shipit issue view/list`).
  //
  // These back the `shipit issue` shim subcommands. The worker injects the
  // trusted SESSION_ID; for GitHub the repo binding is re-derived from that
  // session's remote (never a `--repo`), exactly like the Issues tab. Linear
  // ignores the session (its binding is the workspace team). Read-only — there
  // is no write route here. Tracker tokens stay in the orchestrator's
  // CredentialStore and never enter the container.
  // ---------------------------------------------------------------------------

  // GET /api/sessions/:id/issue/view?tracker=&id= — fetch a single issue.
  app.get<{ Params: { id: string }; Querystring: { tracker?: string; id?: string } }>(
    "/api/sessions/:id/issue/view",
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const trackerId = request.query.tracker ?? "github";
      const github = resolveGitHubContext(request.params.id);
      try {
        const result = await getIssueForTracker(
          credentialStore,
          trackerId,
          request.query.id ?? "",
          trackerFetchImpl,
          github,
        );
        // Surface a jump-to-issue card in the transcript (docs/188). Best-effort
        // — never let a card failure mask the successful read.
        emitIssueReadCard(request.params.id, trackerId, result.issue);
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to read issue: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/issue/list?tracker=&state= — list issues for one
  // tracker. `state` selects the working set:
  //   - `open` (default): open issues only.
  //   - `all`: open + completed (the tracker's `includeDone`).
  //   - `closed`: completed issues only — we fetch `includeDone` (open + done)
  //     then post-filter to the done set, because `includeDone` alone means
  //     "open PLUS done" and would over-return open issues for a `closed` query.
  app.get<{ Params: { id: string }; Querystring: { tracker?: string; state?: string } }>(
    "/api/sessions/:id/issue/list",
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const trackerId = request.query.tracker ?? "github";
      const state = request.query.state;
      const includeDone = state === "all" || state === "closed";
      const github = resolveGitHubContext(request.params.id);
      try {
        const result = await listIssuesForTracker(credentialStore, trackerId, trackerFetchImpl, github, {
          includeDone,
        });
        if (state === "closed") {
          result.issues = result.issues.filter((i) => isDoneStatus(i.status?.type));
        }
        return result;
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list issues: ${getErrorMessage(err)}` });
      }
    },
  );

  // ---- Linear connect / binding (settings) ----

  // POST /api/trackers/linear/token — validate + store a Linear API token.
  app.post<{ Body: { token?: string } }>("/api/trackers/linear/token", async (request, reply) => {
    try {
      return await connectLinear(credentialStore, request.body?.token ?? "", trackerFetchImpl);
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to connect Linear: ${getErrorMessage(err)}` });
    }
  });

  // GET /api/trackers/linear/teams — list workspace teams for the team picker.
  app.get("/api/trackers/linear/teams", async (_request, reply) => {
    try {
      return { teams: await getLinearTeams(credentialStore, trackerFetchImpl) };
    } catch (err) {
      if (err instanceof ServiceError) {
        reply.code(err.statusCode).send({ error: err.message });
        return;
      }
      reply.code(500).send({ error: `Failed to list Linear teams: ${getErrorMessage(err)}` });
    }
  });

  // POST /api/trackers/linear/team — bind the Issues tab to a team.
  app.post<{ Body: { id?: string; key?: string; name?: string } }>(
    "/api/trackers/linear/team",
    async (request, reply) => {
      try {
        return { tracker: setLinearTeam(credentialStore, request.body) };
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to bind Linear team: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/trackers/linear/disconnect — clear token + team binding.
  app.post("/api/trackers/linear/disconnect", async () => {
    disconnectLinear(credentialStore);
    return { ok: true };
  });

  // ---- Session-scoped agent write surface (docs/177) -----------------------
  //
  // The read routes (`issue/view`, `issue/list`) are registered above (docs/175).
  // These are the do-then-surface WRITE routes: `shipit issue
  // create/comment/edit/status/assign` → worker `/agent-ops/issue/*` → here. The worker
  // injects the trusted SESSION_ID; GitHub resolves to the session's own repo,
  // Linear is workspace-wide. Tokens stay in `CredentialStore`; only the result
  // (and the undo snapshot, on the persisted card) returns to the container.

  function sendServiceError(reply: FastifyReply, err: unknown, fallback: string): void {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `${fallback}: ${getErrorMessage(err)}` });
  }

  /**
   * Shared write handler: run the brokered write, then emit + persist the
   * do-then-surface provenance card (with the undo snapshot) into the session's
   * transcript, and return a compact result to the shim. Requires an active
   * runner — the agent is mid-turn when it calls the shim, so one exists.
   */
  async function handleWrite(
    sessionId: string,
    trackerId: string,
    issueId: string,
    reply: FastifyReply,
    fallback: string,
    run: (github: GitHubTrackerContext) => Promise<IssueWriteOutcome>,
  ): Promise<unknown> {
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) {
      reply.code(409).send({ error: "Session is not active — open it to record the write." });
      return;
    }
    const github = resolveGitHubContext(sessionId);
    let outcome: IssueWriteOutcome;
    try {
      outcome = await run(github);
    } catch (err) {
      sendServiceError(reply, err, fallback);
      return;
    }
    // For a create the issue id isn't known until the tracker assigns it, so
    // fall back to the created issue's id (the undo target).
    const card: IssueWriteCard = {
      cardId: `issue-write-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      issueId: issueId || outcome.issue.id,
      identifier: outcome.issue.identifier,
      title: outcome.issue.title,
      ...(outcome.issue.url ? { url: outcome.issue.url } : {}),
      verb: outcome.verb,
      summary: outcome.summary,
      ...(outcome.content ? { content: outcome.content } : {}),
      // GitHub writes use the acting user's own token; Linear writes use the
      // deployment-wide PAT (attributed to the workspace, not the acting user).
      attribution: trackerId === "github" ? "user" : "workspace",
      undo: outcome.undo,
      undoState: "available",
      createdAt: new Date().toISOString(),
    };
    emitChatCard(
      runner,
      { type: "issue_write_card", sessionId, card },
      { role: "assistant", text: "", issueWrite: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
    // Surface the resolved labels + priority so `shipit issue ... --json` reflects
    // what was actually applied (SHI-92), not just the title/identifier.
    return {
      ok: true,
      cardId: card.cardId,
      summary: card.summary,
      identifier: card.identifier,
      ...(card.url ? { url: card.url } : {}),
      labels: outcome.issue.labels ?? [],
      priority: outcome.issue.priority.label,
    };
  }

  // POST /api/sessions/:sessionId/issue/create
  //   { tracker, title, body, labels?, priority? } (docs/187, SHI-92)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; title?: string; body?: string; labels?: string[]; priority?: string };
  }>(
    "/api/sessions/:sessionId/issue/create",
    async (request, reply) => {
      const { tracker, title, body, labels, priority } = request.body ?? {};
      if (!tracker || !title?.trim()) {
        reply.code(400).send({ error: "tracker and title are required" });
        return;
      }
      // The issue id is assigned by the tracker, so pass "" and let handleWrite
      // stamp the card's issueId from the created issue.
      return handleWrite(request.params.sessionId, tracker, "", reply, "Failed to create issue", (github) =>
        createIssueForTracker(credentialStore, tracker, title, body ?? "", { labels, priority }, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/comment { tracker, id, body }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; body?: string } }>(
    "/api/sessions/:sessionId/issue/comment",
    async (request, reply) => {
      const { tracker, id, body } = request.body ?? {};
      if (!tracker || !id || !body?.trim()) {
        reply.code(400).send({ error: "tracker, id and body are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to comment", (github) =>
        commentOnIssueForTracker(credentialStore, tracker, id, body, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/edit
  //   { tracker, id, title?, body?, labels?, priority? } (SHI-92)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; id?: string; title?: string; body?: string; labels?: string[]; priority?: string };
  }>(
    "/api/sessions/:sessionId/issue/edit",
    async (request, reply) => {
      const { tracker, id, title, body, labels, priority } = request.body ?? {};
      const hasLabels = labels !== undefined && labels.length > 0;
      if (!tracker || !id || (title === undefined && body === undefined && !hasLabels && priority === undefined)) {
        reply.code(400).send({ error: "tracker, id and at least one of title/body/label/priority are required" });
        return;
      }
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { description: body } : {}),
        ...(hasLabels ? { labels } : {}),
        ...(priority !== undefined ? { priority } : {}),
      };
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to edit issue", (github) =>
        updateIssueForTracker(credentialStore, tracker, id, patch, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/status { tracker, id, status }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; status?: string } }>(
    "/api/sessions/:sessionId/issue/status",
    async (request, reply) => {
      const { tracker, id, status } = request.body ?? {};
      if (!tracker || !id || !status?.trim()) {
        reply.code(400).send({ error: "tracker, id and status are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to set status", (github) =>
        setIssueStatusForTracker(credentialStore, tracker, id, status, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/assign { tracker, id, assignee | null }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; assignee?: string | null } }>(
    "/api/sessions/:sessionId/issue/assign",
    async (request, reply) => {
      const { tracker, id } = request.body ?? {};
      // `assignee: null` is meaningful (--none → unassign); only undefined is missing.
      const assignee = request.body?.assignee ?? null;
      if (!tracker || !id) {
        reply.code(400).send({ error: "tracker and id are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to set assignee", (github) =>
        setIssueAssigneeForTracker(credentialStore, tracker, id, assignee, trackerFetchImpl, github),
      );
    },
  );
}
