/**
 * GitHub Issues tracker adapter (docs/170, SHI-80).
 *
 * The second tracker behind the inline Issues tab, alongside Linear. Two things
 * make it different from `LinearTracker`, and both trace back to GitHub issues
 * being **per-repo** rather than workspace-wide:
 *
 *  - **Auth is reused, not separately connected.** We authenticate with the
 *    GitHub token ShipIt already holds for clone/push/PRs (`GitHubAuthManager`),
 *    so there is no "connect GitHub for issues" step — unlike Linear's explicit
 *    API-token + team binding. The token is passed in at construction.
 *  - **The binding is derived, not picked.** Which repo's issues to list comes
 *    from the active session's git remote (resolved by the route), not a
 *    user-selected setting. So `isConfigured()` is true whenever a GitHub token
 *    AND a resolved `{owner, repo}` are both present.
 *
 * Read-only: `listIssues()` / `getIssue()` only. Editing/triage and the
 * `/shipit` push trigger are explicitly out of scope (SHI-43 / docs/156).
 *
 * GitHub has no native numeric priority enum like Linear, so priority is
 * **label-derived** (`priority:high`, `P1`, `critical`, …) with a "No priority"
 * fallback — see `mapGitHubPriority`.
 */

import type {
  TrackerInfo,
  TrackerIssue,
  IssuePriority,
  IssuePriorityLevel,
} from "../../../shared/types.js";
import { githubHeaders } from "../../github-api.js";
import type { Tracker } from "../tracker.js";

export type FetchImpl = typeof fetch;

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubTrackerConfig {
  token: string | null;
  /** Repo derived from the active session's remote, or null when unresolved. */
  repo: GitHubRepoRef | null;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: FetchImpl;
}

const PRIORITY_BY_LEVEL: Record<
  Exclude<IssuePriorityLevel, "none">,
  { sortOrder: number; label: string }
> = {
  urgent: { sortOrder: 0, label: "Urgent" },
  high: { sortOrder: 1, label: "High" },
  medium: { sortOrder: 2, label: "Medium" },
  low: { sortOrder: 3, label: "Low" },
};

const NO_PRIORITY: IssuePriority = { level: "none", sortOrder: 4, label: "No priority" };

/**
 * Derive a normalized priority from an issue's labels. GitHub has no priority
 * field, so we recognize the common label conventions: an explicit
 * `priority: high` / `priority/high` form, the `P0`–`P3` shorthand, and bare
 * severity words (`critical`, `urgent`, `high`, …). The highest-priority label
 * wins; anything unrecognized falls back to "No priority".
 */
export function mapGitHubPriority(labelNames: string[]): IssuePriority {
  let best: IssuePriorityLevel = "none";
  let bestSort = NO_PRIORITY.sortOrder;
  for (const raw of labelNames) {
    const level = labelToPriorityLevel(raw);
    if (!level) continue;
    const sort = PRIORITY_BY_LEVEL[level].sortOrder;
    if (sort < bestSort) {
      best = level;
      bestSort = sort;
    }
  }
  if (best === "none") return NO_PRIORITY;
  return { level: best, sortOrder: PRIORITY_BY_LEVEL[best].sortOrder, label: PRIORITY_BY_LEVEL[best].label };
}

function labelToPriorityLevel(label: string): Exclude<IssuePriorityLevel, "none"> | null {
  // Strip an optional `priority:` / `priority/` / `priority-` prefix and trim.
  const v = label
    .toLowerCase()
    .replace(/^priority\s*[:/-]\s*/, "")
    .trim();
  if (/^(p0|urgent|critical|sev0|sev1)$/.test(v) || v === "urgent" || v === "critical") return "urgent";
  if (/^(p1|high)$/.test(v)) return "high";
  if (/^(p2|medium|med)$/.test(v)) return "medium";
  if (/^(p3|p4|low|minor)$/.test(v)) return "low";
  return null;
}

/** GitHub REST issue node (subset we consume). */
interface GitHubIssueNode {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  state: string;
  labels?: (string | { name?: string | null })[];
  assignee?: { login?: string | null; avatar_url?: string | null } | null;
  /** Present iff this "issue" is actually a pull request — we skip those. */
  pull_request?: unknown;
}

function labelNames(node: GitHubIssueNode): string[] {
  return (node.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l?.name ?? "")))
    .filter((n): n is string => Boolean(n));
}

function toTrackerIssue(node: GitHubIssueNode, ref: GitHubRepoRef): TrackerIssue {
  const assigneeName = node.assignee?.login ?? undefined;
  const isClosed = node.state === "closed";
  return {
    id: String(node.number),
    identifier: `${ref.owner}/${ref.repo}#${node.number}`,
    title: node.title,
    url: node.html_url,
    ...(node.body ? { description: node.body } : {}),
    priority: mapGitHubPriority(labelNames(node)),
    status: { name: isClosed ? "Closed" : "Open", type: isClosed ? "completed" : "started" },
    ...(assigneeName
      ? { assignee: { name: assigneeName, ...(node.assignee?.avatar_url ? { avatarUrl: node.assignee.avatar_url } : {}) } }
      : {}),
  };
}

export class GitHubTracker implements Tracker {
  readonly id = "github" as const;
  readonly label = "GitHub";

  private token: string | null;
  private repo: GitHubRepoRef | null;
  private fetchImpl: FetchImpl;

  constructor(config: GitHubTrackerConfig) {
    this.token = config.token;
    this.repo = config.repo;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.token && this.repo);
  }

  info(): TrackerInfo {
    const slug = this.repo ? `${this.repo.owner}/${this.repo.repo}` : null;
    return {
      id: this.id,
      label: this.label,
      configured: this.isConfigured(),
      ...(slug ? { binding: { key: slug, name: slug } } : {}),
    };
  }

  async listIssues(): Promise<TrackerIssue[]> {
    if (!this.token || !this.repo) {
      throw new Error("GitHub is not configured (missing token or repo binding)");
    }
    const ref = this.repo;
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues?state=open&per_page=100&sort=created&direction=desc`;
    const nodes = await this.fetchIssues(url);
    return nodes
      .filter((n) => !n.pull_request) // the issues endpoint also returns PRs — drop them
      .map((n) => toTrackerIssue(n, ref))
      .sort((a, b) => a.priority.sortOrder - b.priority.sortOrder || a.identifier.localeCompare(b.identifier));
  }

  async getIssue(id: string): Promise<TrackerIssue | null> {
    if (!this.token || !this.repo) {
      throw new Error("GitHub is not configured (missing token or repo binding)");
    }
    const ref = this.repo;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${encodeURIComponent(id)}`,
        { headers: githubHeaders(this.token) },
      );
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 404) return null;
    this.assertOk(res);
    const node = (await res.json()) as GitHubIssueNode;
    if (node.pull_request) return null; // a PR number, not an issue
    return toTrackerIssue(node, ref);
  }

  private async fetchIssues(url: string): Promise<GitHubIssueNode[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: githubHeaders(this.token!) });
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.assertOk(res);
    return (await res.json()) as GitHubIssueNode[];
  }

  private assertOk(res: Response): void {
    if (res.status === 401 || res.status === 403) {
      throw new Error("GitHub rejected the token (401/403). Re-connect GitHub with a valid token.");
    }
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
  }
}
