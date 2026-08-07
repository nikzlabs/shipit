/**
 * Issue tracker routes (docs/170 — inline tracker Issues tab; planning#82).
 *
 * These are global `/api/...` routes, not `/api/sessions/:id/...`, because they
 * predate per-session tracker scoping. Since docs/248 that scoping is what they
 * actually need: **every** tracker is declared in the session repository's
 * `shipit.yaml`, so the read routes take an optional `?sessionId` and resolve
 * that session's remote, token and declarations into a `GitHubTrackerContext`
 * for the registry — Linear included, since a Linear tracker is a declaration
 * now and not a deployment-wide binding. A request with no `sessionId` therefore
 * sees no declarations at all, which is correct rather than degraded: with no
 * session there is no repository to have declared anything.
 */

import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
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
  createLabelForTracker,
  updateLabelForTracker,
  commentOnIssueForTracker,
  editCommentForTracker,
  updateIssueForTracker,
  setIssueStatusForTracker,
  setIssueAssigneeForTracker,
  connectLinear,
  getLinearTeams,
  disconnectLinear,
  listTrackerDestinations,
  ServiceError,
  type IssueWriteOutcome,
  type LabelWrite,
} from "./services/index.js";
import type { GitHubTrackerContext } from "./trackers/index.js";
import type { GitHubAuthManager } from "./github-auth.js";
import type { SessionManager } from "./sessions.js";
import type { TrackerId, TrackerIssue, IssueWriteCard, IssueRefCard } from "../shared/types.js";
import { parseGitHubRemote } from "./git-utils.js";
import { resolveShipitConfig, type DeclaredTracker } from "../shared/shipit-config.js";
import { isGitHubTracker } from "../shared/tracker-id.js";
import { resolveDestinationByName } from "../shared/issue-ref-resolution.js";
import { getErrorMessage } from "./validation.js";
import { emitChatCard } from "./chat-card-persistence.js";

/**
 * Resolve the GitHub tracker context for a request: ShipIt's existing GitHub
 * token, the repo derived from a session's remote, and the additional trackers
 * that session's repository declares in its `shipit.yaml` (docs/248). Any piece
 * may be null/empty (GitHub not connected, no session, a non-GitHub remote, no
 * declarations) — the adapter then reports unconfigured. Exported so the undo WS
 * handler resolves it the same way the routes do.
 */
export function resolveGitHubTrackerContext(
  githubAuthManager: GitHubAuthManager,
  sessionManager: SessionManager,
  sessionId?: string,
): GitHubTrackerContext {
  const token = githubAuthManager.getToken();
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  const parsed = session?.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
  const { trackers, warnings } = readDeclaredTrackers(session?.workspaceDir);
  return {
    token,
    repo: parsed ? { owner: parsed.owner, repo: parsed.repo } : null,
    declared: trackers,
    warnings,
  };
}

/**
 * docs/248 — read `issues.trackers` from the session workspace's `shipit.yaml`.
 *
 * Read fresh per request rather than cached: the file is committed, so editing
 * it must change which tabs appear on the next request without a restart, and a
 * cache keyed by session would go stale exactly when the user is iterating on
 * the declaration. The read is a single small local file.
 *
 * Never throws. `resolveShipitConfig` raises on a malformed *document* (bad
 * YAML, a bad `release` block), and an issue-list request is the wrong place to
 * surface that — the session's own config diagnostics already report it. Failing
 * here would break the Issues tab for a repo whose problem is elsewhere in the
 * file, so a parse failure degrades to "no declared trackers".
 */
function readDeclaredTrackers(
  workspaceDir: string | undefined,
): { trackers: DeclaredTracker[]; warnings: string[] } {
  if (!workspaceDir) return { trackers: [], warnings: [] };
  try {
    const config = resolveShipitConfig(workspaceDir);
    // Only the declaration-shaped warnings are carried forward (req 8) — the
    // agent asked about trackers, not about a stale `agent.memory` key.
    return {
      trackers: config.issues.trackers,
      warnings: config.warnings.filter((w) => w.includes("issues.")),
    };
  } catch (err) {
    // A malformed *document* (bad YAML, a bad `release` block) degrades to "no
    // declared trackers" rather than breaking the Issues tab for a problem
    // elsewhere in the file — but say so, so the agent isn't left thinking the
    // repository simply declares nothing.
    return {
      trackers: [],
      warnings: [`shipit.yaml could not be parsed, so no tracker declarations were read: ${getErrorMessage(err)}`],
    };
  }
}

/**
 * Whether the answer to "what does this repository declare?" is *not yet
 * knowable* for this session — as opposed to "it declares nothing".
 *
 * `readDeclaredTrackers` degrades a missing checkout to zero declarations, and
 * the two are indistinguishable in the response. They are not the same thing: a
 * disk-evicted session (docs/161) keeps its `workspaceDir` in the session row
 * while the directory itself is gone, and activation re-clones it from the bare
 * cache *asynchronously* (`finishRestore`). The browser's tracker fetch races
 * that re-clone and reliably wins, so a session switch to an evicted session
 * cached "declares nothing" — and since the client refetches only on the next
 * session change or Issues-tab open, every inline `planning#147` badge in the
 * transcript stayed plain text until the user opened the tab.
 *
 * Saying so lets the client retry instead of caching the empty answer.
 *
 * **The directory existing is not the test.** `restoreSessionWorkspace` deletes
 * the remnant and clones into the same path (`services/session.ts`), and
 * `git clone` creates the target directory long before the checkout lands — so
 * `existsSync` goes true within milliseconds while `shipit.yaml` is still absent
 * (mid-clone) or on the wrong branch (cloned, not yet checked out). A client
 * retrying on that signal would stop on the first retry and cache the empty
 * answer anyway, which is the bug it was added to fix. The authoritative signal
 * is the **disk tier**: eviction sets `evicted` (`tier-escalation.ts`) and only
 * the very end of a successful restore sets it back to `hot`, after the branch
 * checkout and the LFS materialization.
 *
 * So pending means: this session has a workspace path, and either the tier says
 * a restore is still owed or the path isn't on disk at all (a genuine fs loss,
 * or the instant before the re-clone starts). `light` keeps its checkout and is
 * not pending. A session with no workspace at all (standalone/sandbox) declares
 * nothing, permanently; neither it nor an unknown session id is pending.
 */
function areDeclarationsPending(
  sessionManager: SessionManager,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session?.workspaceDir) return false;
  return session.diskTier === "evicted" || !fs.existsSync(session.workspaceDir);
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
    // req 16 — record the declared NAME alongside the destination, so clicking
    // the card later re-resolves through whatever that name points at now. The
    // name is derived here rather than passed in because every caller (shim and
    // UI alike) already addressed a destination this session can reach, and req 6
    // makes the id → name mapping unique.
    const trackerName = declaredNameFor(sessionId, trackerId);
    const card: IssueRefCard = {
      cardId: `issue-ref-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      ...(trackerName ? { trackerName } : {}),
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

  // GET /api/trackers — configured-tracker metadata (drives the sub-tabs) plus,
  // when the session's checkout isn't on disk yet, the flag that says the empty
  // declaration set is a "not yet" rather than an answer (see
  // `areDeclarationsPending`). Omitted when false so the response shape is
  // unchanged for every session whose workspace is present.
  app.get<{ Querystring: { sessionId?: string } }>("/api/trackers", async (request) => {
    // Readiness is sampled BEFORE the declarations are read, never after: a
    // restore that completes between the two reads would otherwise pair an empty
    // read with a ready verdict — the one combination the client caches forever.
    // Sampling first can only err towards "pending", which costs a retry.
    const pending = areDeclarationsPending(sessionManager, request.query.sessionId);
    const github = resolveGitHubContext(request.query.sessionId);
    return {
      trackers: listTrackers(credentialStore, trackerFetchImpl, github),
      ...(pending ? { declarationsPending: true } : {}),
    };
  });

  // GET /api/issues?tracker=linear[&includeDone=true][&sessionId=...] —
  // priority-sorted issue list for one tracker. `includeDone` widens the default
  // open working set to also include completed/"done" issues (canceled stays
  // excluded). `sessionId` scopes the GitHub tracker to that session's repo.
  app.get<{ Querystring: { tracker?: string; includeDone?: string; sessionId?: string } }>(
    "/api/issues",
    async (request, reply) => {
      const trackerId = request.query.tracker ?? "github";
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
      const trackerId = request.query.tracker ?? "github";
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
      const trackerId = request.query.tracker ?? "github";
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
      const trackerId = request.query.tracker ?? "github";
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

  // GET /api/sessions/:id/issue/trackers — the destinations this session can
  // reach plus the declaration warnings its shipit.yaml produced (docs/248
  // reqs 8, 10). The `shipit issue` shim calls this first and resolves a
  // reference (`planning#42`, `SHI-304`, `owner/repo#42`) against exactly the
  // set the orchestrator would, so a resolution failure is reported in CLI
  // output with the declared names in hand (req 19) instead of coming back as
  // an opaque 404 from a write it should never have attempted.
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/issue/trackers",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      if (!sessionManager.get(request.params.id)) {
        reply.code(404).send({ error: "Session not found" });
        return;
      }
      const github = resolveGitHubContext(request.params.id);
      return listTrackerDestinations(credentialStore, trackerFetchImpl, github);
    },
  );

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
  // instead of guessing and tripping the create/edit rejection (planning#201). The
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
  // target without first `view`-ing an issue (planning#201). Same session-scoping +
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
  // thread (planning#139). The read-only sibling of the comment WRITE route below:
  // brokered through the orchestrator so the tracker token never enters the
  // container, container-accessible + own-session scoped by the planning#131 guard.
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

  // GET /api/trackers/linear/teams — the team keys this credential can reach, so
  // Settings can show what a `kind: linear` declaration may name. docs/248 req 4:
  // a lookup for writing a declaration, not a picker that binds anything.
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

  // POST /api/trackers/linear/disconnect — clear the stored credential.
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

  /**
   * docs/248 req 13 — a create ALWAYS names its destination. The shim enforces
   * this by requiring `--tracker <name>`, but `/agent-ops/issue/*` is reachable
   * from the session container by anything the agent runs (a `curl` bypasses the
   * shim entirely), so the rule needs a server-side backstop or it is only a
   * convention. The bare `"github"` id is precisely "the destination nobody
   * named": for a public code repository that is the *public* repo, which is the
   * disclosure this requirement exists to make impossible.
   *
   * Returns an error message when the create must be refused, or null to proceed.
   * Mirrors the same shim-plus-backstop pattern `--priority` and `--parent` use.
   */
  function rejectUnnamedCreateDestination(trackerId: string): string | null {
    if (trackerId !== "github") return null;
    return (
      "A create must name the tracker it files into: `github` is this session's own repository, " +
      "which it reaches without being named. Pass a declared tracker's name instead — for a public " +
      "code repository the unnamed destination is the public repo. Declare one in shipit.yaml under " +
      "`issues.trackers` if none fits."
    );
  }

  /**
   * The write body carries `tracker` (the destination the write executes
   * against) and `trackerName` (the declared name it was addressed through).
   * The shim derives both from ONE resolution, so they always agree — but this
   * endpoint is container-accessible and the two fields arrive as independent,
   * caller-supplied strings.
   *
   * They must be checked against each other, because they are consumed by
   * different operations at different times: the write goes to `tracker`, while
   * `undoIssueWrite` resolves through the recorded `trackerName` FIRST so that a
   * re-pointed name re-targets the undo (req 16). A body pairing
   * `tracker: github:acme/a` with `trackerName: beta` (declared as `acme/b`)
   * therefore writes to A and, on Undo, applies A's recorded snapshot to B's
   * issue of the same number — an operation touching a destination the caller
   * never named, which is the one thing this feature exists to prevent.
   *
   * Checked at WRITE time only. At undo time the pair is deliberately allowed to
   * have drifted apart: that drift IS req 16's re-point.
   */
  /** The declared name of a destination this session can reach, if it has one. */
  function declaredNameFor(sessionId: string, trackerId: string): string | undefined {
    const github = resolveGitHubContext(sessionId);
    const { destinations } = listTrackerDestinations(credentialStore, trackerFetchImpl, github);
    return destinations.find((d) => d.id === trackerId)?.name;
  }

  function rejectMismatchedTrackerName(
    sessionId: string,
    trackerId: string,
    trackerName: string | undefined,
  ): string | null {
    if (!trackerName) return null;
    const github = resolveGitHubContext(sessionId);
    const { destinations } = listTrackerDestinations(credentialStore, trackerFetchImpl, github);
    const found = resolveDestinationByName(destinations, trackerName);
    if (!found.ok) return found.message;
    if (found.destination.id !== trackerId) {
      return (
        `\`${trackerName}\` is declared as \`${found.destination.id}\`, but this write names ` +
        `\`${trackerId}\`. ShipIt does not record a write against a destination other than the ` +
        `one it was addressed through.`
      );
    }
    return null;
  }

  function sendServiceError(reply: FastifyReply, err: unknown, fallback: string): void {
    if (err instanceof ServiceError) {
      reply.code(err.statusCode).send({ error: err.message });
      return;
    }
    reply.code(500).send({ error: `${fallback}: ${getErrorMessage(err)}` });
  }

  // ---- Write idempotency (planning#114) ----------------------------------------
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
   * Emit + persist the provenance card for one label creation (planning#232) — used
   * by the standalone `label create` route and by `--create-missing-labels` on
   * create/edit (one card per minted label, so a flag-driven creation is as
   * visible and undoable as an explicit one). The card reuses the issue-write
   * stack with verb `label`: the label name rides in `identifier`, there is no
   * issue, so `issueId`/`title` stay empty and the client renders it non-
   * navigable. Undo deletes the label if it's still unused.
   */
  function emitLabelCard(
    runner: NonNullable<ReturnType<typeof deps.runnerRegistry.get>>,
    sessionId: string,
    trackerId: string,
    verb: "label" | "label-edit",
    write: LabelWrite,
    trackerName?: string,
  ): IssueWriteCard {
    const card: IssueWriteCard = {
      cardId: `issue-write-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      ...(trackerName ? { trackerName } : {}),
      issueId: "",
      // The label's name as it now stands — for an edit that is the NEW name,
      // and the card's second line carries the one it replaced.
      identifier: write.label.name,
      title: "",
      verb,
      summary: write.summary,
      ...("content" in write && write.content ? { content: write.content } : {}),
      attribution: isGitHubTracker(trackerId) ? "user" : "workspace",
      undo: write.undo,
      undoState: "available",
      createdAt: new Date().toISOString(),
    };
    emitChatCard(
      runner,
      { type: "issue_write_card", sessionId, card },
      { role: "assistant", text: "", issueWrite: card },
      { chatHistoryManager: deps.chatHistoryManager, sessionId },
    );
    return card;
  }

  /**
   * Shared handler for the two label writes (`label create`, `label edit`) —
   * the same brokered-write-then-surface-a-card flow `handleWrite` runs, minus
   * the issue: a label write targets tracker CONFIG, so there is no
   * `TrackerIssue` to stamp onto the card and no issue id for the dedup key's
   * `issueId` slot.
   *
   * That slot instead names **the label being written**: empty for a create (the
   * label does not exist yet, so the name lives in the hashed content alongside
   * the color and description) and the target's name for an edit (the object
   * being mutated, exactly as the slot holds the issue for every issue verb).
   * Keying an edit on the name is what keeps two edits to *different* labels
   * from collapsing into one — the same trap `comment edit` avoided by riding
   * the comment id in its hashed content (planning#88) — while a replay of the same
   * edit stays absorbed (planning#114).
   */
  async function handleLabelWrite(
    sessionId: string,
    trackerId: string,
    trackerName: string | undefined,
    verb: "label" | "label-edit",
    dedup: { verb: string; target: string; content: string },
    reply: FastifyReply,
    fallback: string,
    run: (github: GitHubTrackerContext) => Promise<LabelWrite>,
  ): Promise<unknown> {
    // Same name/destination coherence check `handleWrite` applies — these routes
    // mint their own card (with its own Undo) without going through it.
    const mismatch = rejectMismatchedTrackerName(sessionId, trackerId, trackerName);
    if (mismatch) {
      reply.code(400).send({ error: mismatch });
      return;
    }
    // Writing a tracker's label set mutates its configuration, so req 13's
    // name-your-destination rule applies as it does to `issue create` — same
    // backstop, same reasoning.
    const unnamed = rejectUnnamedCreateDestination(trackerId);
    if (unnamed) {
      reply.code(400).send({ error: unnamed });
      return;
    }
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) {
      reply.code(409).send({ error: "Session is not active — open it to record the write." });
      return;
    }
    const now = Date.now();
    pruneWrites(now);
    const dedupKey = `${sessionId}::${trackerId}::${dedup.verb}::${dedup.target}::${createHash("sha256")
      .update(dedup.content)
      .digest("hex")}`;
    const cached = recentWrites.get(dedupKey);
    if (cached && now - cached.at <= WRITE_DEDUP_WINDOW_MS) {
      cached.at = now;
      return cached.result;
    }
    const github = resolveGitHubContext(sessionId);
    let write: LabelWrite;
    try {
      write = await run(github);
    } catch (err) {
      sendServiceError(reply, err, fallback);
      return;
    }
    const card = emitLabelCard(runner, sessionId, trackerId, verb, write, trackerName);
    const result = {
      ok: true,
      cardId: card.cardId,
      summary: write.summary,
      label: write.label,
    };
    recentWrites.set(dedupKey, { at: now, result });
    return result;
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
    trackerName: string | undefined,
    issueId: string,
    reply: FastifyReply,
    fallback: string,
    dedup: { verb: string; content: string },
    run: (github: GitHubTrackerContext) => Promise<IssueWriteOutcome>,
  ): Promise<unknown> {
    // Coherence of the request body first: an incoherent pair is a malformed
    // request whatever the session's runner state, and rejecting it here means a
    // bad write never even reaches the runner lookup. Same position as
    // `rejectUnnamedCreateDestination`, which its routes apply before this call.
    const mismatch = rejectMismatchedTrackerName(sessionId, trackerId, trackerName);
    if (mismatch) {
      reply.code(400).send({ error: mismatch });
      return;
    }
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
    // Labels minted by --create-missing-labels each get their own card, BEFORE
    // the main write card — the creation happened first (planning#232).
    for (const creation of outcome.labelCreations ?? []) {
      emitLabelCard(runner, sessionId, trackerId, "label", creation, trackerName);
    }
    // For a create the issue id isn't known until the tracker assigns it, so
    // fall back to the created issue's id (the undo target).
    const card: IssueWriteCard = {
      cardId: `issue-write-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      // docs/248 — record the NAME the write was addressed by alongside the
      // destination it reached. Undo prefers the name so a re-point re-targets
      // it (req 16) and falls back to the destination so an undeclared target
      // stays undoable (req 11).
      ...(trackerName ? { trackerName } : {}),
      issueId: issueId || outcome.issue.id,
      identifier: outcome.issue.identifier,
      title: outcome.issue.title,
      ...(outcome.issue.url ? { url: outcome.issue.url } : {}),
      verb: outcome.verb,
      summary: outcome.summary,
      ...(outcome.content ? { content: outcome.content } : {}),
      // GitHub writes use the acting user's own token; Linear writes use the
      // deployment-wide PAT (attributed to the workspace, not the acting user).
      attribution: isGitHubTracker(trackerId) ? "user" : "workspace",
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
    // what was actually applied (planning#94), not just the title/identifier.
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
      // Reflect the resolved parent (planning#208) so `--json` shows the nesting that
      // was applied; absent when the issue is top-level.
      ...(outcome.issue.parentIdentifier ? { parent: outcome.issue.parentIdentifier } : {}),
      // Labels minted on the fly by --create-missing-labels (planning#232), so the
      // shim can report exactly what was created vs merely applied.
      ...(outcome.labelCreations && outcome.labelCreations.length > 0
        ? { createdLabels: outcome.labelCreations.map((c) => c.label.name) }
        : {}),
    };
    recentWrites.set(dedupKey, { at: now, result });
    return result;
  }

  // POST /api/sessions/:sessionId/issue/create
  //   { tracker, title, body, labels?, priority?, createMissingLabels? } (docs/187, planning#94, planning#232)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; trackerName?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean };
  }>(
    "/api/sessions/:sessionId/issue/create",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, title, body, labels, priority, parent, createMissingLabels } = request.body ?? {};
      if (!tracker || !title?.trim()) {
        reply.code(400).send({ error: "tracker and title are required" });
        return;
      }
      const unnamed = rejectUnnamedCreateDestination(tracker);
      if (unnamed) {
        reply.code(400).send({ error: unnamed });
        return;
      }
      // Create can only SET a parent (a new issue has no prior relation to
      // detach), so a `null`/detach sentinel is a no-op here — fold to undefined.
      const parentToSet = parent ?? undefined;
      // The issue id is assigned by the tracker, so pass "" and let handleWrite
      // stamp the card's issueId from the created issue.
      const dedup = { verb: "create", content: JSON.stringify({ title, body: body ?? "", labels: labels ?? [], priority: priority ?? null, parent: parentToSet ?? null, createMissingLabels: createMissingLabels === true }) };
      return handleWrite(request.params.sessionId, tracker, trackerName, "", reply, "Failed to create issue", dedup, (github) =>
        createIssueForTracker(credentialStore, tracker, title, body ?? "", { labels, priority, parent: parentToSet, createMissingLabels: createMissingLabels === true }, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/label/create { tracker, name, color?, description? }
  //   (planning#232) — mint a tracker label so `--label` can apply it. Do-then-surface
  //   like every other write: created immediately, provenance card with Undo
  //   (undo deletes the label if it's still unused). The one write that targets
  //   tracker CONFIG rather than an issue, so it bypasses handleWrite (no
  //   TrackerIssue in the outcome) but shares its runner/dedup/card machinery.
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; trackerName?: string; name?: string; color?: string; description?: string };
  }>(
    "/api/sessions/:sessionId/issue/label/create",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, name, color, description } = request.body ?? {};
      if (!tracker || !name?.trim()) {
        reply.code(400).send({ error: "tracker and name are required" });
        return;
      }
      const dedup = {
        verb: "label-create",
        target: "",
        content: JSON.stringify({ name, color: color ?? null, description: description ?? null }),
      };
      return handleLabelWrite(
        request.params.sessionId,
        tracker,
        trackerName,
        "label",
        dedup,
        reply,
        "Failed to create label",
        (github) =>
          createLabelForTracker(
            credentialStore,
            tracker,
            name,
            { ...(color ? { color } : {}), ...(description ? { description } : {}) },
            trackerFetchImpl,
            github,
          ),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/label/edit
  //   { tracker, name, newName?, color?, description? } (planning#88) — correct a label
  //   that already exists with the wrong color, casing or description. The
  //   counterpart to `label/create`, which refuses an existing name: without an
  //   edit verb a wrongly-minted label was permanently wrong through ShipIt.
  //   Undo restores the prior values of exactly the fields this write changed.
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; trackerName?: string; name?: string; newName?: string; color?: string; description?: string };
  }>(
    "/api/sessions/:sessionId/issue/label/edit",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, name, newName, color, description } = request.body ?? {};
      if (!tracker || !name?.trim()) {
        reply.code(400).send({ error: "tracker and name are required" });
        return;
      }
      if (newName === undefined && color === undefined && description === undefined) {
        reply.code(400).send({ error: "at least one of newName/color/description is required" });
        return;
      }
      const patch = {
        ...(newName !== undefined ? { name: newName } : {}),
        ...(color !== undefined ? { color } : {}),
        // `description: ""` is meaningful (clear it), so forward on presence.
        ...(description !== undefined ? { description } : {}),
      };
      const dedup = {
        verb: "label-edit",
        // The label being edited occupies the issueId slot: it is the object
        // this write mutates, so two edits to different labels stay distinct.
        target: name.trim(),
        content: JSON.stringify(patch),
      };
      return handleLabelWrite(
        request.params.sessionId,
        tracker,
        trackerName,
        "label-edit",
        dedup,
        reply,
        "Failed to edit label",
        (github) => updateLabelForTracker(credentialStore, tracker, name, patch, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/comment { tracker, id, body }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; trackerName?: string; id?: string; body?: string } }>(
    "/api/sessions/:sessionId/issue/comment",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id, body } = request.body ?? {};
      if (!tracker || !id || !body?.trim()) {
        reply.code(400).send({ error: "tracker, id and body are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to comment", { verb: "comment", content: body }, (github) =>
        commentOnIssueForTracker(credentialStore, tracker, id, body, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/comment/edit { tracker, id, commentId, body }
  //   (planning#88) — rewrite a comment the agent posted. `id` (the issue) is named
  //   alongside `commentId` because a comment id is backend-global; the adapter
  //   checks the pairing and refuses a comment ShipIt did not author.
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; trackerName?: string; id?: string; commentId?: string; body?: string };
  }>(
    "/api/sessions/:sessionId/issue/comment/edit",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id, commentId, body } = request.body ?? {};
      if (!tracker || !id || !commentId || !body?.trim()) {
        reply.code(400).send({ error: "tracker, id, commentId and body are required" });
        return;
      }
      // The dedup key's `issueId` slot is the ISSUE (it is also the card's undo
      // target), so the comment id has to ride in the hashed content or two
      // edits to different comments on the same issue would collapse into one
      // — the second silently dropped, with the first's card returned as if it
      // had succeeded. Hashing `{commentId, body}` keeps replay-of-the-same-edit
      // absorbed (planning#114) while keeping distinct comments distinct.
      const dedup = { verb: "comment-edit", content: JSON.stringify({ commentId, body }) };
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to edit comment", dedup, (github) =>
        editCommentForTracker(credentialStore, tracker, id, commentId, body, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/edit
  //   { tracker, id, title?, body?, labels?, priority?, createMissingLabels? } (planning#94, planning#232)
  app.post<{
    Params: { sessionId: string };
    Body: { tracker?: string; trackerName?: string; id?: string; title?: string; body?: string; labels?: string[]; priority?: string; parent?: string | null; createMissingLabels?: boolean };
  }>(
    "/api/sessions/:sessionId/issue/edit",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id, title, body, labels, priority, parent, createMissingLabels } = request.body ?? {};
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
      const dedupContent = JSON.stringify({ ...patch, createMissingLabels: createMissingLabels === true });
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to edit issue", { verb: "edit", content: dedupContent }, (github) =>
        updateIssueForTracker(credentialStore, tracker, id, patch, trackerFetchImpl, github, {
          createMissingLabels: createMissingLabels === true,
        }),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/status { tracker, id, status }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; trackerName?: string; id?: string; status?: string } }>(
    "/api/sessions/:sessionId/issue/status",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id, status } = request.body ?? {};
      if (!tracker || !id || !status?.trim()) {
        reply.code(400).send({ error: "tracker, id and status are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to set status", { verb: "status", content: status }, (github) =>
        setIssueStatusForTracker(credentialStore, tracker, id, status, trackerFetchImpl, github),
      );
    },
  );

  // POST /api/sessions/:sessionId/issue/assign { tracker, id, assignee | null }
  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; trackerName?: string; id?: string; assignee?: string | null } }>(
    "/api/sessions/:sessionId/issue/assign",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id } = request.body ?? {};
      // `assignee: null` is meaningful (--none → unassign); only undefined is missing.
      const assignee = request.body?.assignee ?? null;
      if (!tracker || !id) {
        reply.code(400).send({ error: "tracker and id are required" });
        return;
      }
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to set assignee", { verb: "assign", content: String(assignee) }, (github) =>
        setIssueAssigneeForTracker(credentialStore, tracker, id, assignee, trackerFetchImpl, github),
      );
    },
  );
}
