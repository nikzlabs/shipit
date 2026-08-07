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
 *
 * docs/248 — the **team comes from the repository's declaration**, not from
 * `CredentialStore`. A `kind: linear` entry states its team key (req 5), so a
 * repository may declare two Linear trackers on different teams and each gets
 * its own adapter instance, its own `linear:<TEAM>` id, and its own tab. The
 * credential still defines the *workspace* (req 23) — which is exactly why a
 * declaration identifies a team and not a workspace. The team key is resolved to
 * Linear's internal team id lazily, on the first call that needs it, so building
 * a registry stays synchronous and free.
 */

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
  /**
   * docs/248 req 5 — the declared team key (`SHI`), which is also the prefix its
   * issue keys carry. Null when the declaration was unusable; the tracker then
   * reports unconfigured rather than guessing a team.
   */
  teamKey: string | null;
  /** The declared `name` this tracker is addressed by (req 2). */
  name?: string;
  /** Sub-tab label. Defaults to the declared name, then to "Linear". */
  label?: string;
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
  createdAt?: string | null;
  priority: number;
  priorityLabel?: string | null;
  /** Parent issue when this is a sub-issue (docs/206) — drives nested rendering. */
  parent?: { id: string; identifier: string } | null;
  labels?: { nodes: { name: string; color?: string | null }[] } | null;
  state?: { name: string; type?: string; color?: string } | null;
  assignee?: { id?: string | null; name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
  /** Only fetched by `getIssue` (the team's workflow states) — drives `availableStatuses`. */
  team?: { key?: string | null; states?: { nodes: LinearStateNode[] } | null } | null;
}

/**
 * `formatRef` renders a Linear issue key in the destination's reference form
 * (docs/248 req 15): `planning#306` when the tracker was declared under a
 * name, the bare `SHI-304` otherwise. Threaded in rather than applied at the
 * call sites so every identifier this adapter produces — including a sub-issue's
 * `parentIdentifier` — goes through the one formatter.
 */
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
  createdAt
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
  team { key states(first: 100) { nodes { id name type position color } } }
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
  // Throttle first, for the same reason GitHub's adapter does (docs/247): a
  // rate limit is not an auth failure, and telling someone to re-connect a
  // working credential sends them to fix something that isn't broken. Linear
  // does NOT share GitHub's ambiguity — it answers a throttle with `429`, which
  // cannot collide with the 401/403 below — so this only replaces the bare
  // "Linear API returned 429" with something the caller can act on.
  if (res.status === 429) {
    throw new Error(
      `Linear is rate-limiting requests (429) — not an auth or access problem. The API key and the ` +
        `declared team are fine; wait ${waitPhrase(parseRetryAfterSeconds(res))} and retry.`,
    );
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
  readonly id: TrackerId;
  readonly label: string;

  private token: string | null;
  /** The declared team key (docs/248 req 5), upper-cased. */
  private teamKey: string | null;
  /** The declared `name` this tracker is addressed by, when it has one. */
  private refName: string | undefined;
  private fetchImpl: FetchImpl;
  /**
   * Linear's internal team id, resolved from {@link teamKey} on first use and
   * cached for this adapter's lifetime. A registry is rebuilt per request, so
   * "cached for this adapter's lifetime" means "resolved at most once per
   * request that actually talks to Linear" — a fresh declaration is always
   * re-resolved, and nothing goes stale across a config edit.
   */
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

  /** Render an issue key in this destination's reference form (req 15). */
  private formatRef = (key: string): string =>
    formatIssueReference({
      trackerName: this.refName,
      kind: "linear",
      ...(this.teamKey ? { key: this.teamKey } : {}),
      issueId: key,
    });

  /**
   * Resolve the declared team **key** to Linear's internal team id.
   *
   * The declaration carries the key because that is what a human writes and what
   * a `planning#306` reference is matched against (req 5); Linear's own queries want
   * the UUID. A key the credential's workspace doesn't expose fails closed with
   * a message naming both possibilities, the same way GitHub's access error does
   * — the workspace comes from the credential (req 23), so "no such team" and
   * "this token can't see that team" are indistinguishable from here.
   */
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
    // Same team guard as `resolveUuid` — the read half of the same hole.
    this.assertOwnTeam(id, data.issue.team?.key ?? null);
    return toTrackerIssue(data.issue, this.formatRef);
  }

  async listStatuses(): Promise<{ name: string; type?: string; color?: string }[]> {
    if (!this.token || !this.teamKey) {
      throw new Error("Linear is not configured (missing token or declared team)");
    }
    const teamId = await this.resolveTeamId();
    // The bound team's workflow states, in board order — the same set
    // `getIssue` attaches per-issue, fetched once here for the list editor.
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

  // ---- Writes (docs/177) ----------------------------------------------------

  /**
   * Resolve a key (`SHI-28`) or UUID to the issue's UUID — mutations want it.
   *
   * docs/248 reqs 11/17 — Linear's `issue(id:)` lookup is **workspace-global**,
   * not team-scoped, so an id belonging to another team resolves happily. That
   * would let an operation which named *this* tracker act on a destination the
   * repository may not declare at all: exactly the wrong-target substitution this
   * feature exists to prevent, and a hole the reference resolver alone cannot
   * close, because a raw `tracker=` + `id=` pair over the agent relay never goes
   * through it. So every id this adapter resolves is checked against the declared
   * team before it is used.
   */
  private async resolveUuid(id: string): Promise<string> {
    const data = await this.gql<{ issue: { id: string; team?: { key?: string | null } | null } | null }>(
      `query IssueId($id: String!) { issue(id: $id) { id team { key } } }`,
      { id },
    );
    if (!data.issue) throw new Error(`Linear issue not found: ${id}`);
    this.assertOwnTeam(id, data.issue.team?.key ?? null);
    return data.issue.id;
  }

  /**
   * Fail closed when an issue belongs to a different team than the one this
   * tracker was declared for (req 17: a named destination is used as named, and
   * ShipIt never substitutes another for it). A response that carried no team is
   * unverifiable, so it is refused for the same reason rather than waved through.
   */
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
    // Resolve label names → ids and the priority value → Linear's numeric field
    // BEFORE the mutation, so an unknown label/priority fails cleanly with the
    // candidate list and never half-creates the issue (planning#94).
    if (input.labels && input.labels.length > 0) {
      createInput.labelIds = await this.resolveLabelIds(input.labels);
    }
    if (input.priority !== undefined) {
      createInput.priority = resolveLinearPriority(input.priority);
    }
    // Resolve the parent pointer (key/UUID) → the parent's UUID, which Linear's
    // `parentId` wants (planning#208). A bad pointer throws before the create runs.
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
    // Team-scoped, matching the adapter's binding — the created label shows up in
    // the same `issueLabels` set `resolveLabelIds` matches `--label` against.
    // Linear wants a `#rrggbb` color; tolerate a bare hex from the caller.
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

  async deleteUnusedLabel(id: string, name: string): Promise<void> {
    // Usage check first: undo must never strip a label off issues that adopted
    // it — one carrier is enough to refuse, so fetch a single node.
    const data = await this.gql<{
      issueLabel: { team: { key: string } | null; issues: { nodes: { identifier: string }[] } } | null;
    }>(
      `query LabelUsage($id: String!) {
        issueLabel(id: $id) { team { key } issues(first: 1) { nodes { identifier } } }
      }`,
      { id },
    );
    if (!data.issueLabel) return; // already gone — undo is idempotent
    // Same workspace-global reach as `deleteComment` — a label id resolves
    // across teams, and a re-pointed name (req 16) can hand this adapter a label
    // belonging to the team it used to name. A workspace-level label has no
    // team, and is left to the usage check below rather than refused outright.
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
    // docs/248 req 17 — a comment id is workspace-global, so this mutation can
    // reach a comment on ANY team's issue. That matters on the undo path: a
    // recorded write re-resolves through its declared NAME first (req 16), so a
    // `roadmap` re-pointed from SHI to OPS hands the undo an OPS-bound adapter
    // holding a comment id that still lives on an SHI issue. Deleting it would
    // mutate a destination this adapter does not name. Check ownership first;
    // the read is the same one `assertOwnTeam` guards everywhere else.
    const owner = await this.gql<{ comment: { issue: { team: { key: string } | null } | null } | null }>(
      `query CommentTeam($id: String!) { comment(id: $id) { issue { team { key } } } }`,
      { id: commentId },
    );
    if (!owner.comment) return; // already gone — undo is idempotent
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
    // The issue leg first — `resolveUuid` applies the team guard, so an issue
    // outside the declared team is refused before the comment is even read.
    const issueUuid = await this.resolveUuid(issueId);
    // One read supplies everything the guards and the undo snapshot need: the
    // comment's author, its owning issue, and the body being replaced. `viewer`
    // rides along in the same query — it is the identity the workspace PAT
    // writes as, which is what "ShipIt's own comment" means on Linear.
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
    // Same workspace-global reach `deleteComment` guards against: a comment id
    // resolves across teams, so check the team before acting on it.
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
    // `labelIds` replaces Linear's label set wholesale — the service hands us the
    // already-merged set (planning#94). Resolve names → ids first so a bad name aborts
    // before the mutation runs.
    if (patch.labels !== undefined) input.labelIds = await this.resolveLabelIds(patch.labels);
    if (patch.priority !== undefined) input.priority = resolveLinearPriority(patch.priority);
    // Reparent (planning#208): `null` detaches into a top-level issue; a pointer/key
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
    return toTrackerIssue(data.issueUpdate.issue, this.formatRef);
  }

  /**
   * Resolve label display names → Linear `IssueLabel` ids. Labels are matched by
   * exact (case-insensitive) name against the workspace's labels; an unknown or
   * ambiguous name throws {@link TrackerResolutionError} (`kind: "label"`) with
   * the available label names, mirroring assignee resolution. We deliberately do
   * NOT create a missing label on demand — that would let a typo spawn a stray
   * label (planning#94).
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
 * Resolve a `--priority` argument to Linear's numeric priority field (planning#94).
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
