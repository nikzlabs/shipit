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

import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ApiDeps } from "./api-routes.js";
import {
  listTrackers,
  listIssuesForTracker,
  listLabelsForTracker,
  listStatusesForTracker,
  getIssueForTracker,
  listIssueCommentsForTracker,
  addIssueCommentForTracker,
  userSetIssueStatus,
  userSetIssuePriority,
  userSetIssueLabels,
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

  // GET /api/issue/labels?tracker=linear[&sessionId=...] — the tracker's full set
  // of available labels (name + color). The foundation for a label filter facet /
  // on-page editor, and the same fetch that yields the real chip colors. Public
  // read, like `GET /api/issues`: Linear is workspace-wide; `sessionId` only
  // scopes the GitHub tracker to that session's repo.
  app.get<{ Querystring: { tracker?: string; sessionId?: string } }>(
    "/api/issue/labels",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "linear";
      const github = resolveGitHubContext(request.query.sessionId);
      try {
        return await listLabelsForTracker(credentialStore, trackerId, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list labels: ${getErrorMessage(err)}` });
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

  // POST /api/issue/status { tracker, id, status, sessionId? } — a user setting
  // an issue's status from the inline list/detail editor (docs/191). The
  // status-setting sibling of `POST /api/issue/comments`: the user's own direct
  // action, so it surfaces NO provenance card and has no undo. Returns the
  // updated issue so the client patches the row + detail in place. `sessionId`
  // only scopes the GitHub tracker to that session's repo.
  app.post<{ Body: { tracker?: string; id?: string; status?: string; sessionId?: string } }>(
    "/api/issue/status",
    async (request, reply) => {
      const { tracker, id, status, sessionId } = request.body ?? {};
      if (!tracker || !id || !status?.trim()) {
        reply.code(400).send({ error: "tracker, id and status are required" });
        return;
      }
      const github = resolveGitHubContext(sessionId);
      try {
        return await userSetIssueStatus(credentialStore, tracker, id, status, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set status: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/issue/priority { tracker, id, priority, sessionId? } — a user
  // setting an issue's priority from the inline editor (docs/191). Linear-only:
  // GitHub has no priority field and the service returns a 422 (the UI hides the
  // control for GitHub). Same no-card, returns-the-issue contract as status.
  app.post<{ Body: { tracker?: string; id?: string; priority?: string; sessionId?: string } }>(
    "/api/issue/priority",
    async (request, reply) => {
      const { tracker, id, priority, sessionId } = request.body ?? {};
      if (!tracker || !id || !priority?.trim()) {
        reply.code(400).send({ error: "tracker, id and priority are required" });
        return;
      }
      const github = resolveGitHubContext(sessionId);
      try {
        return await userSetIssuePriority(credentialStore, tracker, id, priority, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set priority: ${getErrorMessage(err)}` });
      }
    },
  );

  // POST /api/issue/labels { tracker, id, labels, sessionId? } — a user replacing
  // an issue's full label set from the on-page editor. `labels` is the COMPLETE
  // desired set (a wholesale replace, not a delta); `[]` clears all labels. Both
  // trackers support it; an undefined name surfaces as a 422. Same no-card,
  // returns-the-issue contract as status/priority. (Distinct from the GET on the
  // same path, which lists the tracker's pickable label set.)
  app.post<{ Body: { tracker?: string; id?: string; labels?: string[]; sessionId?: string } }>(
    "/api/issue/labels",
    async (request, reply) => {
      const { tracker, id, labels, sessionId } = request.body ?? {};
      if (!tracker || !id || !Array.isArray(labels)) {
        reply.code(400).send({ error: "tracker, id and a labels array are required" });
        return;
      }
      const github = resolveGitHubContext(sessionId);
      try {
        return await userSetIssueLabels(credentialStore, tracker, id, labels, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to set labels: ${getErrorMessage(err)}` });
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
    { config: { containerAccessible: true } },
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
    { config: { containerAccessible: true } },
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

  // GET /api/sessions/:id/issue/labels?tracker= — the tracker's pickable label
  // set (name + color), so the agent can discover valid `--label` values up front
  // instead of guessing and tripping the create/edit rejection (SHI-199). The
  // session-scoped sibling of the UI's `GET /api/issue/labels`: GitHub binds to
  // this session's repo, Linear is workspace-wide. A discovery read — emits NO
  // transcript card (label config isn't an issue the user would navigate to).
  app.get<{ Params: { id: string }; Querystring: { tracker?: string } }>(
    "/api/sessions/:id/issue/labels",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const trackerId = request.query.tracker ?? "github";
      const github = resolveGitHubContext(request.params.id);
      try {
        return await listLabelsForTracker(credentialStore, trackerId, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list labels: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/issue/statuses?tracker= — the tracker's assignable
  // statuses (name + type + color), so the agent can pick a valid `issue status`
  // target without first `view`-ing an issue (SHI-199). Same session-scoping +
  // no-card contract as the labels route above.
  app.get<{ Params: { id: string }; Querystring: { tracker?: string } }>(
    "/api/sessions/:id/issue/statuses",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const trackerId = request.query.tracker ?? "github";
      const github = resolveGitHubContext(request.params.id);
      try {
        return await listStatusesForTracker(credentialStore, trackerId, trackerFetchImpl, github);
      } catch (err) {
        if (err instanceof ServiceError) {
          reply.code(err.statusCode).send({ error: err.message });
          return;
        }
        reply.code(500).send({ error: `Failed to list statuses: ${getErrorMessage(err)}` });
      }
    },
  );

  // GET /api/sessions/:id/issue/comments?tracker=&id= — read an issue's comment
  // thread (SHI-137). The read-only sibling of the comment WRITE route below:
  // brokered through the orchestrator so the tracker token never enters the
  // container, container-accessible + own-session scoped by the SHI-129 guard.
  // It emits NO transcript card — the agent reaches comments via
  // `shipit issue view --comments`, whose `view` leg already surfaced the
  // jump-to-issue card, so a second card here would just duplicate it.
  app.get<{ Params: { id: string }; Querystring: { tracker?: string; id?: string } }>(
    "/api/sessions/:id/issue/comments",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const trackerId = request.query.tracker ?? "github";
      const github = resolveGitHubContext(request.params.id);
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

  // ---- Write idempotency (SHI-112) ----------------------------------------
  //
  // The `shipit issue {comment,edit,status,assign,create}` write relay is
  // re-driven verbatim when a crashed turn (exit 137 / OOM) is retried or the
  // agent's CLI session is resumed: the tail `shipit issue …` shim re-executes
  // as a brand-new subprocess and POSTs a fresh, identical request here. Without
  // a guard each replay performs a SECOND real tracker write and mints a SECOND
  // provenance card — the production symptom was ~12 duplicate comments on one
  // issue from a single retry loop (cards minutes apart, no model reasoning
  // between them).
  //
  // The read path dedups via `runner.recordedCards`, but that is reset at every
  // turn start (`resetRunnerTurnState`), so it cannot span the resume/retry
  // boundary — the duplicates land in *different* turns. We can't key on a
  // stable `toolUseId` either: the shim is a plain Bash-invoked CLI with no
  // tool-use id, and `--resume` re-mints tool ids on replay. So we dedup on the
  // write's *content* — `(sessionId, tracker, verb, issueId, hash(content))` —
  // within a sliding time window. A byte-identical write seen again inside the
  // window short-circuits: NO second tracker write, NO second card; we return
  // the original result so the shim still sees `ok: true`. A genuinely distinct
  // write (different content) gets its own write + card. The window slides on
  // each hit so a continuous retry storm is fully absorbed however long it runs,
  // while a deliberate re-post after the window quiesces correctly goes through.
  const WRITE_DEDUP_WINDOW_MS = 10 * 60_000;
  interface WriteDedupEntry {
    at: number;
    result: unknown;
  }
  const recentWrites = new Map<string, WriteDedupEntry>();

  function pruneWrites(now: number): void {
    for (const [key, entry] of recentWrites) {
      if (now - entry.at > WRITE_DEDUP_WINDOW_MS) recentWrites.delete(key);
    }
  }

  /**
   * Shared write handler: run the brokered write, then emit + persist the
   * do-then-surface provenance card (with the undo snapshot) into the session's
   * transcript, and return a compact result to the shim. Requires an active
   * runner — the agent is mid-turn when it calls the shim, so one exists.
   *
   * `dedup` carries the operation verb plus the normalized request content so a
   * replayed/retried identical write is short-circuited (see `recentWrites`).
   */
  async function handleWrite(
    sessionId: string,
    trackerId: string,
    issueId: string,
    reply: FastifyReply,
    fallback: string,
    dedup: { verb: string; content: string },
    run: (github: GitHubTrackerContext) => Promise<IssueWriteOutcome>,
  ): Promise<unknown> {
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) {
      reply.code(409).send({ error: "Session is not active — open it to record the write." });
      return;
    }
    const now = Date.now();
    pruneWrites(now);
    const dedupKey = `${sessionId}::${trackerId}::${dedup.verb}::${issueId}::${createHash("sha256")
      .update(dedup.content)
      .digest("hex")}`;
    const cached = recentWrites.get(dedupKey);
    if (cached && now - cached.at <= WRITE_DEDUP_WINDOW_MS) {
      // Replay/retry of an identical write — surface the original result without
      // re-writing the tracker or minting a second card. Slide the window so a
      // sustained retry loop stays absorbed.
      cached.at = now;
      return cached.result;
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
    const result = {
      ok: true,
      cardId: card.cardId,
      summary: card.summary,
      identifier: card.identifier,
      ...(card.url ? { url: card.url } : {}),
      // The shim's `--json` expects label names (a `string[]`), so flatten the
      // colored read shape back to names here.
      labels: (outcome.issue.labels ?? []).map((l) => l.name),
      priority: outcome.issue.priority.label,
      // Reflect the resolved parent (SHI-206) so `--json` shows the nesting that
      // was applied; absent when the issue is top-level.
      ...(outcome.issue.parentIdentifier ? { parent: outcome.issue.parentIdentifier } : {}),
    };
    recentWrites.set(dedupKey, { at: now, result });
    return result;
  }

  // POST /api/sessions/:sessionId/issue/create
  //   { tracker, title, body, labels?, priority? } (docs/187, SHI-92)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null };
  }>(
    "/api/sessions/:sessionId/issue/create",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, title, body, labels, priority, parent } = request.body ?? {};
      if (!tracker || !title?.trim()) {
        reply.code(400).send({ error: "tracker and title are required" });
        return;
      }
      // Create can only SET a parent (a new issue has no prior relation to
      // detach), so a `null`/detach sentinel is a no-op here — fold to undefined.
      const parentToSet = parent ?? undefined;
      // The issue id is assigned by the tracker, so pass "" and let handleWrite
      // stamp the card's issueId from the created issue.
      const dedup = { verb: "create", content: JSON.stringify({ title, body: body ?? "", labels: labels ?? [], priority: priority ?? null, parent: parentToSet ?? null }) };
      return handleWrite(request.params.sessionId, tracker, "", reply, "Failed to create issue", dedup, (github) =>
        createIssueForTracker(credentialStore, tracker, title, body ?? "", { labels, priority, parent: parentToSet }, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/comment { tracker, id, body }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; body?: string } }>(
    "/api/sessions/:sessionId/issue/comment",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, id, body } = request.body ?? {};
      if (!tracker || !id || !body?.trim()) {
        reply.code(400).send({ error: "tracker, id and body are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to comment", { verb: "comment", content: body }, (github) =>
        commentOnIssueForTracker(credentialStore, tracker, id, body, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/edit
  //   { tracker, id, title?, body?, labels?, priority? } (SHI-92)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; id?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null };
  }>(
    "/api/sessions/:sessionId/issue/edit",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, id, title, body, labels, priority, parent } = request.body ?? {};
      const hasLabels = labels !== undefined && labels.length > 0;
      if (!tracker || !id || (title === undefined && body === undefined && !hasLabels && priority === undefined && parent === undefined)) {
        reply.code(400).send({ error: "tracker, id and at least one of title/body/label/priority/parent are required" });
        return;
      }
      const patch = {
        ...(title !== undefined ? { title } : {}),
        ...(body !== undefined ? { description: body } : {}),
        ...(hasLabels ? { labels } : {}),
        ...(priority !== undefined ? { priority } : {}),
        // `parent: null` is meaningful (detach) — forward when the key is present.
        ...(parent !== undefined ? { parent } : {}),
      };
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to edit issue", { verb: "edit", content: JSON.stringify(patch) }, (github) =>
        updateIssueForTracker(credentialStore, tracker, id, patch, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/status { tracker, id, status }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; status?: string } }>(
    "/api/sessions/:sessionId/issue/status",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, id, status } = request.body ?? {};
      if (!tracker || !id || !status?.trim()) {
        reply.code(400).send({ error: "tracker, id and status are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to set status", { verb: "status", content: status }, (github) =>
        setIssueStatusForTracker(credentialStore, tracker, id, status, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/assign { tracker, id, assignee | null }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; id?: string; assignee?: string | null } }>(
    "/api/sessions/:sessionId/issue/assign",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, id } = request.body ?? {};
      // `assignee: null` is meaningful (--none → unassign); only undefined is missing.
      const assignee = request.body?.assignee ?? null;
      if (!tracker || !id) {
        reply.code(400).send({ error: "tracker and id are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, id, reply, "Failed to set assignee", { verb: "assign", content: String(assignee) }, (github) =>
        setIssueAssigneeForTracker(credentialStore, tracker, id, assignee, trackerFetchImpl, github),
      );
    },
  );
}
