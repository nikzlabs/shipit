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
  IssueLabel,
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

/**
 * The canonical, slug-free form of a Linear issue URL: `…/issue/<IDENTIFIER>`.
 * Linear's API returns the URL with a title-derived slug appended
 * (`…/issue/SHI-28/redesign-the-auth-flow`). We strip that slug everywhere a
 * `TrackerIssue.url` is produced, for two reasons:
 *
 *  - It can leak the issue title into URLs the agent writes back into committed
 *    artifacts — a doc's `issue:` frontmatter pointer, a PR body — where only
 *    the issue number belongs.
 *  - It IS the convention documented for `issue:` pointers ("Linear must be a
 *    full URL without the title slug"), and the shape `parseIssueRef` already
 *    treats as canonical.
 *
 * The slug-free URL still resolves — Linear redirects `…/issue/SHI-28` to the
 * full slug URL — so nothing downstream breaks. A URL that doesn't match the
 * expected Linear shape is returned unchanged.
 */
export function stripLinearUrlSlug(url: string): string {
  const match = /^(https?:\/\/linear\.app\/[^/]+\/issue\/[A-Za-z]+-\d+)(?:\/.*)?$/i.exec(url);
  return match ? match[1] : url;
}

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
  color?: string | null;
  position?: number | null;
}

/** The five normalized priority levels Linear's numeric field maps onto. */
const LINEAR_PRIORITY_BY_LEVEL: Record<IssuePriorityLevel, number> = {
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
  none: 0,
};

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  updatedAt?: string | null;
  priority: number;
  priorityLabel?: string | null;
  /** Parent issue when this is a sub-issue (docs/206) — drives nested rendering. */
  parent?: { id: string; identifier: string } | null;
  labels?: { nodes: { name: string; color?: string | null }[] } | null;
  state?: { name: string; type?: string; color?: string } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  /** Only fetched by `getIssue` (the team's workflow states) — drives `availableStatuses`. */
  team?: { states?: { nodes: LinearStateNode[] } | null } | null;
}

function toTrackerIssue(node: LinearIssueNode): TrackerIssue {
  const assigneeName = node.assignee?.displayName ?? node.assignee?.name ?? undefined;
  const labels: IssueLabel[] = (node.labels?.nodes ?? [])
    .filter((l) => Boolean(l.name))
    .map((l) => ({ name: l.name, ...(l.color ? { color: l.color } : {}) }));
  const states = node.team?.states?.nodes
    ?.slice()
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => ({ name: s.name, ...(s.type ? { type: s.type } : {}), ...(s.color ? { color: s.color } : {}) }));
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: stripLinearUrlSlug(node.url),
    ...(node.description ? { description: node.description } : {}),
    ...(node.parent ? { parentId: node.parent.id, parentIdentifier: node.parent.identifier } : {}),
    ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
    priority: mapLinearPriority(node.priority, node.priorityLabel ?? undefined),
    ...(labels.length > 0 ? { labels } : {}),
    ...(node.state
      ? {
          status: {
            name: node.state.name,
            ...(node.state.type ? { type: node.state.type } : {}),
            ...(node.state.color ? { color: node.state.color } : {}),
          },
        }
      : {}),
    ...(assigneeName
      ? { assignee: { name: assigneeName, ...(node.assignee?.avatarUrl ? { avatarUrl: node.assignee.avatarUrl } : {}) } }
      : {}),
    ...(node.assignee?.id ? { assigneeId: node.assignee.id } : {}),
    ...(states && states.length > 0 ? { availableStatuses: states } : {}),
  };
}

/** A Linear comment node (subset we consume) — author lives under `user`. */
interface LinearCommentNode {
  id: string;
  body: string;
  url?: string | null;
  createdAt?: string | null;
  user?: { name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
}

const COMMENT_FIELDS = `
  id
  body
  url
  createdAt
  user { name displayName avatarUrl }
`;

function toTrackerComment(node: LinearCommentNode): TrackerComment {
  const authorName = node.user?.displayName ?? node.user?.name ?? undefined;
  return {
    id: node.id,
    body: node.body,
    ...(node.url ? { url: node.url } : {}),
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
    ...(authorName
      ? { author: { name: authorName, ...(node.user?.avatarUrl ? { avatarUrl: node.user.avatarUrl } : {}) } }
      : {}),
  };
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  url
  description
  updatedAt
  priority
  priorityLabel
  parent { id identifier }
  labels { nodes { name color } }
  state { name type color }
  assignee { id name displayName avatarUrl }
`;

/** `getIssue` additionally pulls the team's workflow states for `availableStatuses`. */
const ISSUE_FIELDS_WITH_STATES = `
  ${ISSUE_FIELDS}
  team { states(first: 100) { nodes { id name type position color } } }
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
    throw new Error(`Linear request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
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

  async listStatuses(): Promise<{ name: string; type?: string; color?: string }[]> {
    if (!this.token || !this.team) {
      throw new Error("Linear is not configured (missing token or team binding)");
    }
    // The bound team's workflow states, in board order — the same set
    // `getIssue` attaches per-issue, fetched once here for the list editor.
    const data = await this.gql<{ team: { states: { nodes: LinearStateNode[] } } | null }>(
      `query TeamStates($teamId: String!) {
        team(id: $teamId) { states(first: 100) { nodes { id name type position color } } }
      }`,
      { teamId: this.team.id },
    );
    return (data.team?.states.nodes ?? [])
      .slice()
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((s) => ({ name: s.name, ...(s.type ? { type: s.type } : {}), ...(s.color ? { color: s.color } : {}) }));
  }

  async listLabels(): Promise<IssueLabel[]> {
    if (!this.token) {
      throw new Error("Linear is not configured (missing token)");
    }
    // Workspace `issueLabels` (incl. team-scoped ones), the same set
    // `resolveLabelIds` matches against, here paired with each label's color.
    const data = await this.gql<{ issueLabels: { nodes: { name: string; color?: string | null }[] } }>(
      `query IssueLabels { issueLabels(first: 250) { nodes { name color } } }`,
      {},
    );
    return data.issueLabels.nodes
      .filter((l) => Boolean(l.name))
      .map((l) => ({ name: l.name, ...(l.color ? { color: l.color } : {}) }));
  }

  async listComments(id: string): Promise<TrackerComment[]> {
    if (!this.token) {
      throw new Error("Linear is not configured (missing token)");
    }
    const data = await this.gql<{
      issue: { comments: { nodes: LinearCommentNode[] } } | null;
    }>(
      `query IssueComments($id: String!) {
        issue(id: $id) {
          comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
        }
      }`,
      { id },
    );
    return (data.issue?.comments.nodes ?? []).map(toTrackerComment);
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

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
    parent?: string;
  }): Promise<TrackerIssue> {
    if (!this.team) {
      throw new Error("Linear is not configured (missing team binding)");
    }
    const createInput: Record<string, unknown> = {
      teamId: this.team.id,
      title: input.title,
      description: input.body,
    };
    // Resolve label names → ids and the priority value → Linear's numeric field
    // BEFORE the mutation, so an unknown label/priority fails cleanly with the
    // candidate list and never half-creates the issue (SHI-92).
    if (input.labels && input.labels.length > 0) {
      createInput.labelIds = await this.resolveLabelIds(input.labels);
    }
    if (input.priority !== undefined) {
      createInput.priority = resolveLinearPriority(input.priority);
    }
    // Resolve the parent pointer (key/UUID) → the parent's UUID, which Linear's
    // `parentId` wants (SHI-206). A bad pointer throws before the create runs.
    if (input.parent !== undefined) {
      createInput.parentId = await this.resolveUuid(input.parent);
    }
    const data = await this.gql<{ issueCreate: { success: boolean; issue: LinearIssueNode | null } }>(
      `mutation IssueCreate($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue { ${ISSUE_FIELDS} }
        }
      }`,
      { input: createInput },
    );
    if (!data.issueCreate.success || !data.issueCreate.issue) {
      throw new Error("Linear rejected the issue create");
    }
    return toTrackerIssue(data.issueCreate.issue);
  }

  async createLabel(input: { name: string; color?: string; description?: string }): Promise<IssueLabel & { id: string }> {
    if (!this.team) {
      throw new Error("Linear is not configured (missing team binding)");
    }
    // Team-scoped, matching the adapter's binding — the created label shows up in
    // the same `issueLabels` set `resolveLabelIds` matches `--label` against.
    // Linear wants a `#rrggbb` color; tolerate a bare hex from the caller.
    const labelInput: Record<string, unknown> = { teamId: this.team.id, name: input.name };
    if (input.color) labelInput.color = input.color.startsWith("#") ? input.color : `#${input.color}`;
    if (input.description) labelInput.description = input.description;
    const data = await this.gql<{ issueLabelCreate: { success: boolean; issueLabel: { id: string; name: string; color?: string | null } | null } }>(
      `mutation LabelCreate($input: IssueLabelCreateInput!) {
        issueLabelCreate(input: $input) {
          success
          issueLabel { id name color }
        }
      }`,
      { input: labelInput },
    );
    const label = data.issueLabelCreate.issueLabel;
    if (!data.issueLabelCreate.success || !label) {
      throw new Error("Linear rejected the label create");
    }
    return { id: label.id, name: label.name, ...(label.color ? { color: label.color } : {}) };
  }

  async deleteUnusedLabel(id: string, name: string): Promise<void> {
    // Usage check first: undo must never strip a label off issues that adopted
    // it — one carrier is enough to refuse, so fetch a single node.
    const data = await this.gql<{ issueLabel: { issues: { nodes: { identifier: string }[] } } | null }>(
      `query LabelUsage($id: String!) {
        issueLabel(id: $id) { issues(first: 1) { nodes { identifier } } }
      }`,
      { id },
    );
    if (!data.issueLabel) return; // already gone — undo is idempotent
    const carrier = data.issueLabel.issues.nodes[0];
    if (carrier) {
      throw new Error(
        `Label "${name}" is now in use (e.g. on ${carrier.identifier}) — remove it from those issues before deleting it.`,
      );
    }
    const del = await this.gql<{ issueLabelDelete: { success: boolean } }>(
      `mutation LabelDelete($id: String!) { issueLabelDelete(id: $id) { success } }`,
      { id },
    );
    if (!del.issueLabelDelete.success) throw new Error("Linear rejected the label delete");
  }

  async addComment(id: string, body: string): Promise<TrackerComment> {
    const issueId = await this.resolveUuid(id);
    const data = await this.gql<{
      commentCreate: { success: boolean; comment: LinearCommentNode | null };
    }>(
      `mutation AddComment($issueId: String!, $body: String!) {
        commentCreate(input: { issueId: $issueId, body: $body }) {
          success
          comment { ${COMMENT_FIELDS} }
        }
      }`,
      { issueId, body },
    );
    const comment = data.commentCreate.comment;
    if (!data.commentCreate.success || !comment) {
      throw new Error("Linear rejected the comment");
    }
    return toTrackerComment(comment);
  }

  async deleteComment(commentId: string): Promise<void> {
    const data = await this.gql<{ commentDelete: { success: boolean } }>(
      `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId },
    );
    if (!data.commentDelete.success) throw new Error("Linear rejected the comment delete");
  }

  async updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  ): Promise<TrackerIssue> {
    const issueId = await this.resolveUuid(id);
    const input: Record<string, unknown> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.description = patch.description;
    // `labelIds` replaces Linear's label set wholesale — the service hands us the
    // already-merged set (SHI-92). Resolve names → ids first so a bad name aborts
    // before the mutation runs.
    if (patch.labels !== undefined) input.labelIds = await this.resolveLabelIds(patch.labels);
    if (patch.priority !== undefined) input.priority = resolveLinearPriority(patch.priority);
    // Reparent (SHI-206): `null` detaches into a top-level issue; a pointer/key
    // resolves to the parent's UUID. Resolve before the mutation so a bad pointer
    // aborts cleanly.
    if (patch.parent !== undefined) {
      input.parentId = patch.parent === null ? null : await this.resolveUuid(patch.parent);
    }
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

  /**
   * Resolve label display names → Linear `IssueLabel` ids. Labels are matched by
   * exact (case-insensitive) name against the workspace's labels; an unknown or
   * ambiguous name throws {@link TrackerResolutionError} (`kind: "label"`) with
   * the available label names, mirroring assignee resolution. We deliberately do
   * NOT create a missing label on demand — that would let a typo spawn a stray
   * label (SHI-92).
   */
  private async resolveLabelIds(names: string[]): Promise<string[]> {
    const data = await this.gql<{ issueLabels: { nodes: { id: string; name: string }[] } }>(
      `query IssueLabels { issueLabels(first: 250) { nodes { id name } } }`,
      {},
    );
    const available = data.issueLabels.nodes;
    const ids: string[] = [];
    for (const raw of names) {
      const needle = raw.trim().toLowerCase();
      const matches = available.filter((l) => l.name.toLowerCase() === needle);
      if (matches.length === 1) {
        if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
      } else if (matches.length === 0) {
        throw new TrackerResolutionError(
          `No Linear label matches "${raw}".`,
          "label",
          available.map((l) => l.name).slice(0, 50),
        );
      } else {
        throw new TrackerResolutionError(
          `"${raw}" is ambiguous — it matches multiple Linear labels.`,
          "label",
          matches.map((l) => l.name),
        );
      }
    }
    return ids;
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

/**
 * Resolve a `--priority` argument to Linear's numeric priority field (SHI-92).
 * Accepts a normalized level (`urgent|high|medium|low|none`) OR a native Linear
 * priority name (`Urgent`/`High`/`Medium`/`Low`/`None`/`No priority`), both
 * case-insensitively. An unmatched value throws {@link TrackerResolutionError}
 * (`kind: "priority"`) listing the accepted values.
 */
export function resolveLinearPriority(value: string): number {
  const wanted = value.trim().toLowerCase();
  if (wanted in LINEAR_PRIORITY_BY_LEVEL) {
    return LINEAR_PRIORITY_BY_LEVEL[wanted as IssuePriorityLevel];
  }
  // Native names, including Linear's "No priority" label for the 0 bucket.
  if (wanted === "no priority") return LINEAR_PRIORITY_BY_LEVEL.none;
  throw new TrackerResolutionError(
    `Unknown priority "${value}" for Linear.`,
    "priority",
    ["urgent", "high", "medium", "low", "none"],
  );
}
