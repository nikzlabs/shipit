/**
 * Linear tracker adapter (docs/170).
 *
 * Lists issues for a bound Linear team via Linear's GraphQL API, sorted by
 * priority. v1 auth is the simplest read-only path: a Linear personal API key
 * stored in `CredentialStore` (mirrors the GitHub token pattern in
 * `github-auth.ts`). We deliberately do NOT build the full per-deployment
 * Linear OAuth app registration / webhook machinery here — that belongs to the
 * push trigger (docs/156), not this read surface.
 *
 * Built against Linear's GraphQL API as documented 2026-06. Personal API keys
 * authenticate with the raw key in the `Authorization` header (no `Bearer`
 * prefix — that form is for OAuth access tokens).
 */

import type {
  TrackerInfo,
  TrackerIssue,
  TrackerComment,
  IssuePriority,
  IssuePriorityLevel,
} from "../../../shared/types.js";
import {
  TrackerResolutionError,
  type ListIssuesOptions,
  type SetAssigneeOptions,
  type Tracker,
} from "../tracker.js";

/** The six normalized Linear workflow-state types. */
const LINEAR_STATE_TYPES = new Set([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
]);

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export type FetchImpl = typeof fetch;

export interface LinearTrackerConfig {
  token: string | null;
  team: { id: string; key: string; name: string } | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
}

/** Linear priority field: 0 None, 1 Urgent, 2 High, 3 Medium, 4 Low. */
function mapLinearPriority(priority: number, label?: string): IssuePriority {
  const byNumber: Record<number, { level: IssuePriorityLevel; sortOrder: number; label: string }> = {
    1: { level: "urgent", sortOrder: 0, label: "Urgent" },
    2: { level: "high", sortOrder: 1, label: "High" },
    3: { level: "medium", sortOrder: 2, label: "Medium" },
    4: { level: "low", sortOrder: 3, label: "Low" },
    0: { level: "none", sortOrder: 4, label: "No priority" },
  };
  const mapped = byNumber[priority] ?? byNumber[0];
  return { ...mapped, label: label?.trim() || mapped.label };
}

interface LinearStateNode {
  id: string;
  name: string;
  type?: string | null;
  position?: number | null;
}

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  priority: number;
  priorityLabel?: string | null;
  state?: { name: string; type?: string } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  /** Only fetched by `getIssue` (the team's workflow states) — drives `availableStatuses`. */
  team?: { states?: { nodes: LinearStateNode[] } | null } | null;
}

function toTrackerIssue(node: LinearIssueNode): TrackerIssue {
  const assigneeName = node.assignee?.displayName ?? node.assignee?.name ?? undefined;
  const states = node.team?.states?.nodes
    ?.slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => ({ name: s.name, ...(s.type ? { type: s.type } : {}) }));
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    ...(node.description ? { description: node.description } : {}),
    priority: mapLinearPriority(node.priority, node.priorityLabel ?? undefined),
    ...(node.state ? { status: { name: node.state.name, ...(node.state.type ? { type: node.state.type } : {}) } } : {}),
    ...(assigneeName
      ? { assignee: { name: assigneeName, ...(node.assignee?.avatarUrl ? { avatarUrl: node.assignee.avatarUrl } : {}) } }
      : {}),
    ...(node.assignee?.id ? { assigneeId: node.assignee.id } : {}),
    ...(states && states.length > 0 ? { availableStatuses: states } : {}),
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  description
  priority
  priorityLabel
  state { name type }
  assignee { id name displayName avatarUrl }
`;

/** `getIssue` additionally pulls the team's workflow states for `availableStatuses`. */
const ISSUE_FIELDS_WITH_STATES = `
  ${ISSUE_FIELDS}
  team { states(first: 100) { nodes { id name type position } } }
`;

/** Run a GraphQL query against Linear and return the typed `data` payload. */
async function linearGraphql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  fetchImpl: FetchImpl,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(LINEAR_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`Linear request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Linear rejected the API token (401/403). Re-connect Linear with a valid API key.");
  }
  if (!res.ok) {
    throw new Error(`Linear API returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("Linear GraphQL response had no data");
  }
  return body.data;
}

/**
 * Fetch the workspace's teams. Standalone (not part of the `Tracker` interface)
 * because it's a setup helper — the settings UI uses it to populate the team
 * picker once a token is pasted, before any team binding exists.
 */
export async function listLinearTeams(
  token: string,
  fetchImpl: FetchImpl = fetch,
): Promise<{ id: string; key: string; name: string }[]> {
  const data = await linearGraphql<{ teams: { nodes: { id: string; key: string; name: string }[] } }>(
    token,
    `query Teams { teams(first: 100) { nodes { id key name } } }`,
    {},
    fetchImpl,
  );
  return data.teams.nodes;
}

export class LinearTracker implements Tracker {
  readonly id = "linear" as const;
  readonly label = "Linear";

  private token: string | null;
  private team: { id: string; key: string; name: string } | null;
  private fetchImpl: FetchImpl;

  constructor(config: LinearTrackerConfig) {
    this.token = config.token;
    this.team = config.team;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.team);
  }

  info(): TrackerInfo {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      ...(this.team ? { binding: { key: this.team.key, name: this.team.name } } : {}),
    };
  }

  async listIssues(options?: ListIssuesOptions): Promise<TrackerIssue[]> {
    if (!this.token || !this.team) {
      throw new Error("Linear is not configured (missing token or team binding)");
    }
    // Open working set by default (drop completed + canceled). When the caller
    // opts into done issues we keep only "canceled" excluded — "done" means
    // finished, not abandoned. Ordered by `updatedAt` so the `first: 100` window
    // favors recently-touched issues (incl. recently-completed ones) rather than
    // letting stale history crowd the list.
    const excludedTypes = options?.includeDone ? ["canceled"] : ["completed", "canceled"];
    const data = await linearGraphql<{ team: { issues: { nodes: LinearIssueNode[] } } | null }>(
      this.token,
      `query TeamIssues($teamId: String!, $excludedTypes: [String!]!) {
        team(id: $teamId) {
          issues(
            first: 100
            orderBy: updatedAt
            filter: { state: { type: { nin: $excludedTypes } } }
          ) {
            nodes { ${ISSUE_FIELDS} }
          }
        }
      }`,
      { teamId: this.team.id, excludedTypes },
      this.fetchImpl,
    );
    const nodes = data.team?.issues.nodes ?? [];
    return nodes
      .map(toTrackerIssue)
      .sort((a, b) => a.priority.sortOrder - b.priority.sortOrder || a.identifier.localeCompare(b.identifier));
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    if (!this.token) {
      throw new Error("Linear is not configured (missing token)");
    }
    const data = await linearGraphql<{ issue: LinearIssueNode | null }>(
      this.token,
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS_WITH_STATES} } }`,
      { id },
      this.fetchImpl,
    );
    return data.issue ? toTrackerIssue(data.issue) : null;
  }

  // ---- Writes (docs/177) ----------------------------------------------------

  /** Resolve a key (`SHI-28`) or UUID to the issue's UUID — mutations want it. */
  private async resolveUuid(id: string): Promise<string> {
    const data = await this.gql<{ issue: { id: string } | null }>(
      `query IssueId($id: String!) { issue(id: $id) { id } }`,
      { id },
    );
    if (!data.issue) throw new Error(`Linear issue not found: ${id}`);
    return data.issue.id;
  }

  async addComment(id: string, body: string): Promise<TrackerComment> {
    const issueId = await this.resolveUuid(id);
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; url?: string | null; body: string } | null };
    }>(
      `mutation AddComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { id url body }
        }
      }`,
      { issueId, body },
    );
    const comment = data.commentCreate.comment;
    if (!data.commentCreate.success || !comment) {
      throw new Error("Linear rejected the comment");
    }
    return { id: comment.id, body: comment.body, ...(comment.url ? { url: comment.url } : {}) };
  }

  async deleteComment(commentId: string): Promise<void> {
    const data = await this.gql<{ commentDelete: { success: boolean } }>(
      `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId },
    );
    if (!data.commentDelete.success) throw new Error("Linear rejected the comment delete");
  }

  async updateIssue(id: string, patch: { title?: string; description?: string }): Promise<TrackerIssue> {
    const issueId = await this.resolveUuid(id);
    const input: Record<string, unknown> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.description = patch.description;
    return this.runIssueUpdate(issueId, input);
  }

  async setStatus(id: string, status: string): Promise<TrackerIssue> {
    const issue = await this.gql<{ issue: (LinearIssueNode & { team?: { states?: { nodes: LinearStateNode[] } | null } | null }) | null }>(
      `query IssueStates($id: String!) {
        issue(id: $id) { id team { states(first: 100) { nodes { id name type position } } } }
      }`,
      { id },
    );
    if (!issue.issue) throw new Error(`Linear issue not found: ${id}`);
    const states = (issue.issue.team?.states?.nodes ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const stateId = resolveLinearStateId(status, states);
    return this.runIssueUpdate(issue.issue.id, { stateId });
  }

  async setAssignee(id: string, assignee: string | null, opts?: SetAssigneeOptions): Promise<TrackerIssue> {
    const issueId = await this.resolveUuid(id);
    let assigneeId: string | null;
    if (assignee === null) {
      assigneeId = null;
    } else if (opts?.raw) {
      assigneeId = assignee;
    } else {
      assigneeId = await this.resolveAssigneeId(assignee);
    }
    return this.runIssueUpdate(issueId, { assigneeId });
  }

  /** Run an `issueUpdate` and return the refreshed issue. */
  private async runIssueUpdate(issueId: string, input: Record<string, unknown>): Promise<TrackerIssue> {
    const data = await this.gql<{ issueUpdate: { success: boolean; issue: LinearIssueNode | null } }>(
      `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue { ${ISSUE_FIELDS_WITH_STATES} }
        }
      }`,
      { id: issueId, input },
    );
    if (!data.issueUpdate.success || !data.issueUpdate.issue) {
      throw new Error("Linear rejected the issue update");
    }
    return toTrackerIssue(data.issueUpdate.issue);
  }

  /** Resolve `"me"` / displayName / email / name → an `assigneeId`. */
  private async resolveAssigneeId(assignee: string): Promise<string> {
    const handle = assignee.trim();
    if (handle.toLowerCase() === "me") {
      const data = await this.gql<{ viewer: { id: string } }>(`query Viewer { viewer { id } }`, {});
      return data.viewer.id;
    }
    const data = await this.gql<{ users: { nodes: { id: string; name: string; displayName: string; email?: string | null }[] } }>(
      `query Users { users(first: 250) { nodes { id name displayName email } } }`,
      {},
    );
    const needle = handle.toLowerCase();
    const matches = data.users.nodes.filter(
      (u) =>
        u.displayName?.toLowerCase() === needle ||
        u.name?.toLowerCase() === needle ||
        u.email?.toLowerCase() === needle,
    );
    if (matches.length === 1) return matches[0].id;
    if (matches.length === 0) {
      throw new TrackerResolutionError(
        `No Linear user matches "${assignee}".`,
        "assignee",
        data.users.nodes.map((u) => u.displayName || u.name).slice(0, 25),
      );
    }
    throw new TrackerResolutionError(
      `"${assignee}" is ambiguous — it matches multiple Linear users.`,
      "assignee",
      matches.map((u) => `${u.displayName} <${u.email ?? u.name}>`),
    );
  }

  /** Thin wrapper binding the token + fetchImpl for the write helpers above. */
  private gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new Error("Linear is not configured (missing token)");
    return linearGraphql<T>(this.token, query, variables, this.fetchImpl);
  }
}

/**
 * Resolve a `setStatus` argument to a concrete Linear `stateId`. Accepts a
 * native state name (case-insensitive exact match) or a normalized type
 * (`started`, `completed`, …). When several states share the requested type
 * the earliest by board position wins (the team's first state of that type);
 * the agent can override with a precise native name. An unmatched value throws
 * {@link TrackerResolutionError} listing the team's state names.
 */
export function resolveLinearStateId(status: string, states: LinearStateNode[]): string {
  const wanted = status.trim().toLowerCase();
  const byName = states.find((s) => s.name.toLowerCase() === wanted);
  if (byName) return byName.id;
  if (LINEAR_STATE_TYPES.has(wanted)) {
    const byType = states.find((s) => (s.type ?? "").toLowerCase() === wanted);
    if (byType) return byType.id;
  }
  throw new TrackerResolutionError(
    `Unknown status "${status}" for this Linear team.`,
    "status",
    states.map((s) => s.name),
  );
}
