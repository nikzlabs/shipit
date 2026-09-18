import type {
  TrackerId,
  TrackerInfo,
  TrackerIssue,
  TrackerComment,
  IssueLabel,
  IssuePriority,
  IssuePriorityLevel,
} from "../../../shared/types.js";
import { formatIssueReference } from "../../../shared/issue-ref.js";
import { linearTrackerId } from "../../../shared/tracker-id.js";
import { parseRetryAfterSeconds, waitPhrase } from "../throttle.js";
import {
  TrackerPermissionError,
  TrackerResolutionError,
  type ListIssuesOptions,
  type SetAssigneeOptions,
  type Tracker,
} from "../tracker.js";

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

// Avoid exposing issue titles in URLs copied to committed artifacts.
export function stripLinearUrlSlug(url: string): string {
  const match = /^(https?:\/\/linear\.app\/[^/]+\/issue\/[A-Za-z]+-\d+)(?:\/.*)?$/i.exec(url);
  return match ? match[1] : url;
}

export interface LinearTrackerConfig {
  token: string | null;
  teamKey: string | null;
  name?: string;
  label?: string;
  fetchImpl?: FetchImpl;
}

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
  createdAt?: string | null;
  priority: number;
  priorityLabel?: string | null;
  parent?: { id: string; identifier: string } | null;
  labels?: { nodes: { name: string; color?: string | null }[] } | null;
  state?: { name: string; type?: string; color?: string } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  team?: { key?: string | null; states?: { nodes: LinearStateNode[] } | null } | null;
}

function toTrackerIssue(node: LinearIssueNode, formatRef: (key: string) => string): TrackerIssue {
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
    identifier: formatRef(node.identifier),
    title: node.title,
    url: stripLinearUrlSlug(node.url),
    ...(node.description ? { description: node.description } : {}),
    ...(node.parent ? { parentId: node.parent.id, parentIdentifier: formatRef(node.parent.identifier) } : {}),
    ...(node.updatedAt ? { updatedAt: node.updatedAt } : {}),
    ...(node.createdAt ? { createdAt: node.createdAt } : {}),
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
  createdAt
  priority
  priorityLabel
  parent { id identifier }
  labels { nodes { name color } }
  state { name type color }
  assignee { id name displayName avatarUrl }
`;

const ISSUE_FIELDS_WITH_STATES = `
  ${ISSUE_FIELDS}
  team { key states(first: 100) { nodes { id name type position color } } }
`;

interface LinearGraphqlError {
  message: string;
  extensions?: { code?: string | null } | null;
}

function isRateLimitedError(err: LinearGraphqlError): boolean {
  return (err.extensions?.code ?? "").toUpperCase() === "RATELIMITED";
}

function isLinearRateLimited(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as { errors?: LinearGraphqlError[] };
    return (parsed.errors ?? []).some(isRateLimitedError);
  } catch {
    return false;
  }
}

function rateLimitMessage(status: number, retryAfterSeconds: number | null): string {
  return (
    `Linear is rate-limiting requests (${status}) — not an auth or access failure, so re-connecting the ` +
    `API key or checking the declared team will not help. Wait ${waitPhrase(retryAfterSeconds)} and retry.`
  );
}

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
        // Personal API keys use the raw key; Bearer is for OAuth tokens.
        Authorization: token,
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new Error(`Linear request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (res.status === 429) {
    throw new Error(rateLimitMessage(res.status, parseRetryAfterSeconds(res)));
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("Linear rejected the API token (401/403). Re-connect Linear with a valid API key.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (isLinearRateLimited(text)) {
      throw new Error(rateLimitMessage(res.status, parseRetryAfterSeconds(res)));
    }
    throw new Error(`Linear API returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: T; errors?: LinearGraphqlError[] };
  if (body.errors && body.errors.length > 0) {
    if (body.errors.some(isRateLimitedError)) {
      throw new Error(rateLimitMessage(res.status, parseRetryAfterSeconds(res)));
    }
    throw new Error(`Linear GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  if (!body.data) {
    throw new Error("Linear GraphQL response had no data");
  }
  return body.data;
}

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
  readonly id: TrackerId;
  readonly label: string;

  private token: string | null;
  private teamKey: string | null;
  private refName: string | undefined;
  private fetchImpl: FetchImpl;
  private teamId: string | null = null;

  constructor(config: LinearTrackerConfig) {
    this.token = config.token;
    this.teamKey = config.teamKey ? config.teamKey.toUpperCase() : null;
    this.refName = config.name;
    this.id = this.teamKey ? linearTrackerId(this.teamKey) : "linear";
    this.label = config.label ?? config.name ?? "Linear";
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.teamKey);
  }

  info(): TrackerInfo {
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      kind: "linear",
      ...(this.refName ? { name: this.refName } : {}),
      ...(this.teamKey ? { binding: { key: this.teamKey, name: this.teamKey } } : {}),
    };
  }

  private formatRef = (key: string): string =>
    formatIssueReference({
      trackerName: this.refName,
      kind: "linear",
      ...(this.teamKey ? { key: this.teamKey } : {}),
      issueId: key,
    });

  private async resolveTeamId(): Promise<string> {
    if (this.teamId) return this.teamId;
    if (!this.token || !this.teamKey) {
      throw new Error("Linear is not configured (missing token or declared team)");
    }
    const data = await this.gql<{ teams: { nodes: { id: string; key: string }[] } }>(
      `query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }, first: 2) { nodes { id key } } }`,
      { key: this.teamKey },
    );
    const match = data.teams.nodes.find((t) => t.key.toUpperCase() === this.teamKey);
    if (!match) {
      throw new Error(
        `Linear has no team \`${this.teamKey}\` reachable with the connected credential — the team ` +
          `either does not exist or is outside the token's workspace. Check the \`team:\` in this ` +
          `repository's shipit.yaml and the Linear token in ShipIt settings.`,
      );
    }
    this.teamId = match.id;
    return match.id;
  }

  async listIssues(options?: ListIssuesOptions): Promise<TrackerIssue[]> {
    if (!this.token || !this.teamKey) {
      throw new Error("Linear is not configured (missing token or declared team)");
    }
    const teamId = await this.resolveTeamId();
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
      { teamId, excludedTypes },
      this.fetchImpl,
    );
    const nodes = data.team?.issues.nodes ?? [];
    return nodes
      .map((n) => toTrackerIssue(n, this.formatRef))
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
    if (!data.issue) return null;
    this.assertOwnTeam(id, data.issue.team?.key ?? null);
    return toTrackerIssue(data.issue, this.formatRef);
  }

  async listStatuses(): Promise<{ name: string; type?: string; color?: string }[]> {
    if (!this.token || !this.teamKey) {
      throw new Error("Linear is not configured (missing token or declared team)");
    }
    const teamId = await this.resolveTeamId();
    const data = await this.gql<{ team: { states: { nodes: LinearStateNode[] } } | null }>(
      `query TeamStates($teamId: String!) {
        team(id: $teamId) { states(first: 100) { nodes { id name type position color } } }
      }`,
      { teamId },
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
      issue: { team?: { key?: string | null } | null; comments: { nodes: LinearCommentNode[] } } | null;
    }>(
      `query IssueComments($id: String!) {
        issue(id: $id) {
          team { key }
          comments(first: 100) { nodes { ${COMMENT_FIELDS} } }
        }
      }`,
      { id },
    );
    if (!data.issue) return [];
    this.assertOwnTeam(id, data.issue.team?.key ?? null);
    return data.issue.comments.nodes.map(toTrackerComment);
  }

  // Linear resolves ids across teams; enforce the declared team before mutation.
  private async resolveUuid(id: string): Promise<string> {
    const data = await this.gql<{ issue: { id: string; team?: { key?: string | null } | null } | null }>(
      `query IssueId($id: String!) { issue(id: $id) { id team { key } } }`,
      { id },
    );
    if (!data.issue) throw new Error(`Linear issue not found: ${id}`);
    this.assertOwnTeam(id, data.issue.team?.key ?? null);
    return data.issue.id;
  }

  private assertOwnTeam(id: string, teamKey: string | null): void {
    if (!this.teamKey) return;
    if (teamKey?.toUpperCase() === this.teamKey) return;
    throw new Error(
      `Linear issue \`${id}\` belongs to team \`${teamKey ?? "unknown"}\`, not to \`${this.teamKey}\` — the ` +
        `tracker this operation named. ShipIt does not act on a destination other than the one named.`,
    );
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
    parent?: string;
  }): Promise<TrackerIssue> {
    if (!this.teamKey) {
      throw new Error("Linear is not configured (missing declared team)");
    }
    const createInput: Record<string, unknown> = {
      teamId: await this.resolveTeamId(),
      title: input.title,
      description: input.body,
    };
    if (input.labels && input.labels.length > 0) {
      createInput.labelIds = await this.resolveLabelIds(input.labels);
    }
    if (input.priority !== undefined) {
      createInput.priority = resolveLinearPriority(input.priority);
    }
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
    return toTrackerIssue(data.issueCreate.issue, this.formatRef);
  }

  async createLabel(input: { name: string; color?: string; description?: string }): Promise<IssueLabel & { id: string }> {
    if (!this.teamKey) {
      throw new Error("Linear is not configured (missing declared team)");
    }
    const labelInput: Record<string, unknown> = { teamId: await this.resolveTeamId(), name: input.name };
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

  async findLabel(name: string): Promise<(IssueLabel & { id: string; description?: string }) | null> {
    if (!this.token) {
      throw new Error("Linear is not configured (missing token)");
    }
    const data = await this.gql<{
      issueLabels: {
        nodes: { id: string; name: string; color?: string | null; description?: string | null; team?: { key?: string | null } | null }[];
      };
    }>(`query FindIssueLabels { issueLabels(first: 250) { nodes { id name color description team { key } } } }`, {});
    const needle = name.trim().toLowerCase();
    const matches = data.issueLabels.nodes.filter((l) => l.name?.toLowerCase() === needle);
    if (matches.length === 0) return null;
    const found =
      matches.find((l) => l.team?.key?.toUpperCase() === this.teamKey) ??
      matches.find((l) => !l.team) ??
      matches[0];
    return {
      id: found.id,
      name: found.name,
      ...(found.color ? { color: found.color } : {}),
      ...(found.description ? { description: found.description } : {}),
    };
  }

  async updateLabel(
    id: string,
    patch: { name?: string; color?: string; description?: string },
  ): Promise<IssueLabel & { id: string; description?: string }> {
    // Labels without a team are shared across the workspace.
    const owner = await this.gql<{ issueLabel: { team: { key: string } | null } | null }>(
      `query LabelOwner($id: String!) { issueLabel(id: $id) { team { key } } }`,
      { id },
    );
    if (!owner.issueLabel) throw new Error(`Linear label not found: ${id}`);
    if (owner.issueLabel.team) this.assertOwnTeam(id, owner.issueLabel.team.key);
    const input: Record<string, unknown> = {};
    if (patch.name !== undefined) input.name = patch.name;
    if (patch.color !== undefined) input.color = patch.color.startsWith("#") ? patch.color : `#${patch.color}`;
    if (patch.description !== undefined) input.description = patch.description;
    const data = await this.gql<{
      issueLabelUpdate: {
        success: boolean;
        issueLabel: { id: string; name: string; color?: string | null; description?: string | null } | null;
      };
    }>(
      `mutation LabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
        issueLabelUpdate(id: $id, input: $input) {
          success
          issueLabel { id name color description }
        }
      }`,
      { id, input },
    );
    const label = data.issueLabelUpdate.issueLabel;
    if (!data.issueLabelUpdate.success || !label) {
      throw new Error("Linear rejected the label update");
    }
    return {
      id: label.id,
      name: label.name,
      ...(label.color ? { color: label.color } : {}),
      ...(label.description ? { description: label.description } : {}),
    };
  }

  async deleteUnusedLabel(id: string, name: string): Promise<void> {
    const data = await this.gql<{
      issueLabel: { team: { key: string } | null; issues: { nodes: { identifier: string }[] } } | null;
    }>(
      `query LabelUsage($id: String!) {
        issueLabel(id: $id) { team { key } issues(first: 1) { nodes { identifier } } }
      }`,
      { id },
    );
    if (!data.issueLabel) return;
    if (data.issueLabel.team) this.assertOwnTeam(id, data.issueLabel.team.key);
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
    const owner = await this.gql<{ comment: { issue: { team: { key: string } | null } | null } | null }>(
      `query CommentTeam($id: String!) { comment(id: $id) { issue { team { key } } } }`,
      { id: commentId },
    );
    if (!owner.comment) return;
    this.assertOwnTeam(commentId, owner.comment.issue?.team?.key ?? null);
    const data = await this.gql<{ commentDelete: { success: boolean } }>(
      `mutation DeleteComment($id: String!) { commentDelete(id: $id) { success } }`,
      { id: commentId },
    );
    if (!data.commentDelete.success) throw new Error("Linear rejected the comment delete");
  }

  async updateComment(
    issueId: string,
    commentId: string,
    body: string,
  ): Promise<{ comment: TrackerComment; previousBody: string }> {
    const issueUuid = await this.resolveUuid(issueId);
    const data = await this.gql<{
      viewer: { id: string; displayName?: string | null; name?: string | null };
      comment: {
        id: string;
        body: string;
        user: { id: string; displayName?: string | null; name?: string | null } | null;
        issue: { id: string; identifier: string; team: { key: string } | null } | null;
      } | null;
    }>(
      `query CommentOwner($id: String!) {
        viewer { id displayName name }
        comment(id: $id) {
          id
          body
          user { id displayName name }
          issue { id identifier team { key } }
        }
      }`,
      { id: commentId },
    );
    const existing = data.comment;
    if (!existing) throw new Error(`Linear comment not found: ${commentId}`);
    this.assertOwnTeam(commentId, existing.issue?.team?.key ?? null);
    if (existing.issue?.id !== issueUuid) {
      const where = existing.issue ? ` — it is on ${existing.issue.identifier}.` : ".";
      throw new Error(
        `Comment ${commentId} is not on ${issueId}${where} A comment id is workspace-global, ` +
          `so the issue it belongs to is checked against the one named.`,
      );
    }
    if (existing.user?.id !== data.viewer.id) {
      const author = existing.user?.displayName ?? existing.user?.name ?? "someone else";
      const viewer = data.viewer.displayName ?? data.viewer.name ?? "the ShipIt workspace token";
      throw new TrackerPermissionError(
        `Comment ${commentId} on ${issueId} was written by ${author}, not by ${viewer} (the identity ` +
          `ShipIt writes as). ShipIt only edits its own comments — post a new comment instead of ` +
          `rewriting someone else's.`,
      );
    }
    const updated = await this.gql<{
      commentUpdate: { success: boolean; comment: LinearCommentNode | null };
    }>(
      `mutation UpdateComment($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) {
          success
          comment { ${COMMENT_FIELDS} }
        }
      }`,
      { id: commentId, input: { body } },
    );
    const comment = updated.commentUpdate.comment;
    if (!updated.commentUpdate.success || !comment) {
      throw new Error("Linear rejected the comment update");
    }
    return { comment: toTrackerComment(comment), previousBody: existing.body };
  }

  async updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  ): Promise<TrackerIssue> {
    const issueId = await this.resolveUuid(id);
    const input: Record<string, unknown> = {};
    if (patch.title !== undefined) input.title = patch.title;
    if (patch.description !== undefined) input.description = patch.description;
    if (patch.labels !== undefined) input.labelIds = await this.resolveLabelIds(patch.labels);
    if (patch.priority !== undefined) input.priority = resolveLinearPriority(patch.priority);
    if (patch.parent !== undefined) {
      input.parentId = patch.parent === null ? null : await this.resolveUuid(patch.parent);
    }
    return this.runIssueUpdate(issueId, input);
  }

  async setStatus(id: string, status: string): Promise<TrackerIssue> {
    const issue = await this.gql<{ issue: (LinearIssueNode & { team?: { states?: { nodes: LinearStateNode[] } | null } | null }) | null }>(
      `query IssueStates($id: String!) {
        issue(id: $id) { id team { key states(first: 100) { nodes { id name type position } } } }
      }`,
      { id },
    );
    if (!issue.issue) throw new Error(`Linear issue not found: ${id}`);
    this.assertOwnTeam(id, issue.issue.team?.key ?? null);
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
    return toTrackerIssue(data.issueUpdate.issue, this.formatRef);
  }

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

  private gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    if (!this.token) throw new Error("Linear is not configured (missing token)");
    return linearGraphql<T>(this.token, query, variables, this.fetchImpl);
  }
}

// Callers sort states by board position; the first matching type wins.
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

export function resolveLinearPriority(value: string): number {
  const wanted = value.trim().toLowerCase();
  if (wanted in LINEAR_PRIORITY_BY_LEVEL) {
    return LINEAR_PRIORITY_BY_LEVEL[wanted as IssuePriorityLevel];
  }
  if (wanted === "no priority") return LINEAR_PRIORITY_BY_LEVEL.none;
  throw new TrackerResolutionError(
    `Unknown priority "${value}" for Linear.`,
    "priority",
    ["urgent", "high", "medium", "low", "none"],
  );
}
