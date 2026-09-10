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
import { pluginFeedbackRepos, type PluginFeedbackRepo } from "../shared/plugin-feedback.js";
import { readActiveGeneration } from "./plugin-generations.js";
import { destinationKey } from "../shared/plugin-repos.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import { isGitHubTracker } from "../shared/tracker-id.js";
import { resolveDestinationByName } from "../shared/issue-ref-resolution.js";
import { getErrorMessage } from "./validation.js";
import { emitChatCard } from "./chat-card-persistence.js";

export function resolveGitHubTrackerContext(
  githubAuthManager: GitHubAuthManager,
  sessionManager: SessionManager,
  sessionId?: string,
): GitHubTrackerContext {
  const token = githubAuthManager.getToken();
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  const parsed = session?.remoteUrl ? parseGitHubRemote(session.remoteUrl) : null;
  const { trackers, plugins, warnings } = readDeclaredTrackers(session?.workspaceDir);
  return {
    token,
    repo: parsed ? { owner: parsed.owner, repo: parsed.repo } : null,
    declared: trackers,
    pluginRepos: plugins,
    warnings,
  };
}

function readDeclaredTrackers(
  workspaceDir: string | undefined,
): { trackers: DeclaredTracker[]; plugins: PluginFeedbackRepo[]; warnings: string[] } {
  if (!workspaceDir) return { trackers: [], plugins: [], warnings: [] };
  try {
    const config = resolveShipitConfig(workspaceDir);
    return {
      trackers: config.issues.trackers,
      plugins: withRunningCommits(workspaceDir, pluginFeedbackRepos(config.plugins)),
      warnings: config.warnings.filter(
        (w) => w.includes("issues.") || w.includes("plugins.repos"),
      ),
    };
  } catch (err) {
    return {
      trackers: [],
      plugins: [],
      warnings: [`shipit.yaml could not be parsed, so no tracker declarations were read: ${getErrorMessage(err)}`],
    };
  }
}

function withRunningCommits(
  workspaceDir: string,
  repos: PluginFeedbackRepo[],
): PluginFeedbackRepo[] {
  if (repos.length === 0) return repos;
  let stateDir: string;
  try {
    stateDir = sessionStateDirForWorkspace(workspaceDir);
  } catch {
    return repos;
  }
  return repos.map((repo) => {
    // Names can be repointed; match the destination before using its commit.
    const generation = readActiveGeneration(
      stateDir,
      repo.name,
      destinationKey({ kind: "github", owner: repo.owner, repo: repo.repo }),
    );
    if (!generation) return repo;
    return { ...repo, ref: generation.ref, commit: generation.commit };
  });
}

// A clone creates its directory before checkout finishes; diskTier tracks readiness.
function areDeclarationsPending(
  sessionManager: SessionManager,
  sessionId: string | undefined,
): boolean {
  const session = sessionId ? sessionManager.get(sessionId) : undefined;
  if (!session?.workspaceDir) return false;
  return session.diskTier === "evicted" || !fs.existsSync(session.workspaceDir);
}

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

  function emitIssueReadCard(sessionId: string, trackerId: string, issue: TrackerIssue): void {
    const runner = deps.runnerRegistry.get(sessionId);
    if (!runner) return;
    const carded = runner.recordedCards.some(
      (c) =>
        c.message.issueRef?.tracker === trackerId &&
        c.message.issueRef?.identifier === issue.identifier,
    );
    if (carded) return;
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

  app.get<{ Querystring: { sessionId?: string } }>("/api/trackers", async (request) => {
    // Sample readiness first so a concurrent restore cannot mark an empty read as final.
    const pending = areDeclarationsPending(sessionManager, request.query.sessionId);
    const github = resolveGitHubContext(request.query.sessionId);
    return {
      trackers: listTrackers(credentialStore, trackerFetchImpl, github),
      ...(pending ? { declarationsPending: true } : {}),
    };
  });

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

  app.post("/api/trackers/linear/disconnect", async () => {
    disconnectLinear(credentialStore);
    return { ok: true };
  });

  function rejectUnnamedCreateDestination(trackerId: string): string | null {
    if (trackerId !== "github") return null;
    return (
      "A create must name the tracker it files into: `github` is this session's own repository, " +
      "which it reaches without being named. Pass a declared tracker's name instead — for a public " +
      "code repository the unnamed destination is the public repo. Declare one in shipit.yaml under " +
      "`issues.trackers` if none fits."
    );
  }

  function declaredNameFor(sessionId: string, trackerId: string): string | undefined {
    const github = resolveGitHubContext(sessionId);
    const { destinations } = listTrackerDestinations(credentialStore, trackerFetchImpl, github);
    return destinations.find((d) => d.id === trackerId)?.name;
  }

  // Writes use trackerId; undo resolves trackerName. They must agree at write time.
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

  // Deduplicate content across turn retries: resumed CLI calls have no stable tool ID.
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
    const mismatch = rejectMismatchedTrackerName(sessionId, trackerId, trackerName);
    if (mismatch) {
      reply.code(400).send({ error: mismatch });
      return;
    }
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
    for (const creation of outcome.labelCreations ?? []) {
      emitLabelCard(runner, sessionId, trackerId, "label", creation, trackerName);
    }
    const card: IssueWriteCard = {
      cardId: `issue-write-${randomUUID()}`,
      tracker: trackerId as TrackerId,
      ...(trackerName ? { trackerName } : {}),
      issueId: issueId || outcome.issue.id,
      identifier: outcome.issue.identifier,
      title: outcome.issue.title,
      ...(outcome.issue.url ? { url: outcome.issue.url } : {}),
      verb: outcome.verb,
      summary: outcome.summary,
      ...(outcome.content ? { content: outcome.content } : {}),
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
    const result = {
      ok: true,
      cardId: card.cardId,
      summary: card.summary,
      identifier: card.identifier,
      ...(card.url ? { url: card.url } : {}),
      labels: (outcome.issue.labels ?? []).map((l) => l.name),
      priority: outcome.issue.priority.label,
      ...(outcome.issue.parentIdentifier ? { parent: outcome.issue.parentIdentifier } : {}),
      ...(outcome.labelCreations && outcome.labelCreations.length > 0
        ? { createdLabels: outcome.labelCreations.map((c) => c.label.name) }
        : {}),
    };
    recentWrites.set(dedupKey, { at: now, result });
    return result;
  }

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
      const parentToSet = parent ?? undefined;
      const dedup = { verb: "create", content: JSON.stringify({ title, body: body ?? "", labels: labels ?? [], priority: priority ?? null, parent: parentToSet ?? null, createMissingLabels: createMissingLabels === true }) };
      return handleWrite(request.params.sessionId, tracker, trackerName, "", reply, "Failed to create issue", dedup, (github) =>
        // The name distinguishes plugin feedback from issues in the same repository.
        createIssueForTracker(credentialStore, tracker, title, body ?? "", { labels, priority, parent: parentToSet, createMissingLabels: createMissingLabels === true, ...(trackerName ? { trackerName } : {}) }, trackerFetchImpl, github),
      );
    },
  );

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
        ...(description !== undefined ? { description } : {}),
      };
      const dedup = {
        verb: "label-edit",
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
      const dedup = { verb: "comment-edit", content: JSON.stringify({ commentId, body }) };
      return handleWrite(request.params.sessionId, tracker, trackerName, id, reply, "Failed to edit comment", dedup, (github) =>
        editCommentForTracker(credentialStore, tracker, id, commentId, body, trackerFetchImpl, github),
      );
    },
  );

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

  app.post<{ Params: { sessionId: string }; Body: { tracker?: string; trackerName?: string; id?: string; assignee?: string | null } }>(
    "/api/sessions/:sessionId/issue/assign",
    { config: { containerAccessible: true } },
    async (request, reply) => {
      const { tracker, trackerName, id } = request.body ?? {};
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
