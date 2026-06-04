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
  IssuePriority,
  IssuePriorityLevel,
} from "../../../shared/types.js";
import type { ListIssuesOptions, Tracker } from "../tracker.js";

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

interface LinearIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  description?: string | null;
  priority: number;
  priorityLabel?: string | null;
  state?: { name: string; type?: string } | null;
  assignee?: { name?: string | null; displayName?: string | null; avatarUrl?: string | null } | null;
}

function toTrackerIssue(node: LinearIssueNode): TrackerIssue {
  const assigneeName = node.assignee?.displayName ?? node.assignee?.name ?? undefined;
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
  assignee { name displayName avatarUrl }
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
      `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
      { id },
      this.fetchImpl,
    );
    return data.issue ? toTrackerIssue(data.issue) : null;
  }
}
