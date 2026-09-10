import type {
  TrackerId,
  TrackerInfo,
  TrackerIssue,
  TrackerComment,
  IssueLabel,
  IssuePriority,
  IssuePriorityLevel,
} from "../../../shared/types.js";
import { githubHeaders, parseGitHubError } from "../../github-api.js";
import { formatIssueReference } from "../../../shared/issue-ref.js";
import { parseRetryAfterSeconds, secondsUntilEpoch, waitPhrase } from "../throttle.js";
import {
  TrackerPermissionError,
  TrackerResolutionError,
  type ListIssuesOptions,
  type SetAssigneeOptions,
  type Tracker,
} from "../tracker.js";

const GITHUB_AVAILABLE_STATUSES: { name: string; type?: string; color?: string }[] = [
  { name: "Open", type: "started", color: "#3fb950" },
  { name: "Closed", type: "completed", color: "#8957e5" },
];

export type FetchImpl = typeof fetch;

export interface GitHubRepoRef {
  owner: string;
  repo: string;
}

export interface GitHubTrackerConfig {
  token: string | null;
  repo: GitHubRepoRef | null;
  fetchImpl?: FetchImpl;
  id?: TrackerId;
  name?: string;
  label?: string;
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

interface GitHubIssueNode {
  id: number;
  number: number;
  title: string;
  html_url: string;
  body?: string | null;
  state: string;
  labels?: (string | { name?: string | null; color?: string | null })[];
  assignee?: { login?: string | null; avatar_url?: string | null } | null;
  created_at?: string | null;
  pull_request?: unknown;
}

interface GitHubCommentNode {
  id: number;
  body?: string | null;
  html_url?: string | null;
  created_at?: string | null;
  user?: { login?: string | null; avatar_url?: string | null } | null;
  issue_url?: string | null;
}

function issueNumberFromUrl(issueUrl?: string | null): string | null {
  const match = /\/issues\/(\d+)$/.exec(issueUrl ?? "");
  return match ? match[1] : null;
}

function toTrackerComment(node: GitHubCommentNode): TrackerComment {
  const login = node.user?.login ?? undefined;
  return {
    id: String(node.id),
    body: node.body ?? "",
    ...(node.html_url ? { url: node.html_url } : {}),
    ...(node.created_at ? { createdAt: node.created_at } : {}),
    ...(login
      ? { author: { name: login, ...(node.user?.avatar_url ? { avatarUrl: node.user.avatar_url } : {}) } }
      : {}),
  };
}

function normalizeGitHubColor(color?: string | null): string | undefined {
  const v = (color ?? "").trim();
  if (!v) return undefined;
  return v.startsWith("#") ? v : `#${v}`;
}

function issueLabels(node: GitHubIssueNode): IssueLabel[] {
  return (node.labels ?? [])
    .map((l): IssueLabel | null => {
      if (typeof l === "string") return l ? { name: l } : null;
      const name = l?.name ?? "";
      if (!name) return null;
      const color = normalizeGitHubColor(l?.color);
      return { name, ...(color ? { color } : {}) };
    })
    .filter((l): l is IssueLabel => l !== null);
}

function toTrackerIssue(
  node: GitHubIssueNode,
  ref: GitHubRepoRef,
  formatRef: (issueNumber: string) => string,
): TrackerIssue {
  const assigneeName = node.assignee?.login ?? undefined;
  const isClosed = node.state === "closed";
  const labels = issueLabels(node);
  return {
    id: String(node.number),
    identifier: formatRef(String(node.number)),
    title: node.title,
    url: node.html_url,
    ...(node.body ? { description: node.body } : {}),
    ...(node.created_at ? { createdAt: node.created_at } : {}),
    priority: mapGitHubPriority(labels.map((l) => l.name)),
    ...(labels.length > 0 ? { labels } : {}),
    status: {
      name: isClosed ? "Closed" : "Open",
      type: isClosed ? "completed" : "started",
      color: isClosed ? "#8957e5" : "#3fb950",
    },
    ...(assigneeName
      ? { assignee: { name: assigneeName, ...(node.assignee?.avatar_url ? { avatarUrl: node.assignee.avatar_url } : {}) } }
      : {}),
    ...(assigneeName ? { assigneeId: assigneeName } : {}),
  };
}

export function resolveGitHubState(status: string): { state: "open" | "closed"; state_reason?: "completed" | "not_planned" } {
  const wanted = status.trim().toLowerCase();
  switch (wanted) {
    case "open":
    case "unstarted":
    case "started":
    case "backlog":
    case "triage":
      return { state: "open" };
    case "closed":
    case "completed":
      return { state: "closed", state_reason: "completed" };
    case "canceled":
    case "cancelled":
    case "not_planned":
      return { state: "closed", state_reason: "not_planned" };
    default:
      throw new TrackerResolutionError(
        `Unknown status "${status}" for GitHub (binary open/closed).`,
        "status",
        ["open", "closed", "completed", "canceled"],
      );
  }
}

export interface GitHubThrottle {
  kind: "secondary" | "primary";
  retryAfterSeconds?: number;
}

function parseErrorBody(body: string): { message: string; documentationUrl: string } {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; documentation_url?: unknown };
    return {
      message: typeof parsed.message === "string" ? parsed.message : "",
      documentationUrl: typeof parsed.documentation_url === "string" ? parsed.documentation_url : "",
    };
  } catch {
    return { message: body, documentationUrl: "" };
  }
}

function parsePositiveInt(raw: string | null): number | null {
  const v = raw?.trim() ?? "";
  return /^\d+$/.test(v) ? Number(v) : null;
}

// GitHub uses 403 for both throttling and denied access; status alone cannot distinguish them.
export function classifyGitHubThrottle(res: Response, body: string): GitHubThrottle | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const { message, documentationUrl } = parseErrorBody(body);
  const retryAfter = parseRetryAfterSeconds(res);
  const secondaryText = /secondary rate limit/i.test(message);
  const primaryText = !secondaryText && /rate limit exceeded/i.test(message);
  const quotaSpent = res.headers.get("x-ratelimit-remaining")?.trim() === "0";

  // Reset applies only to exhausted quotas; use the longer wait when both limits apply.
  const reset =
    quotaSpent || primaryText
      ? secondsUntilEpoch(parsePositiveInt(res.headers.get("x-ratelimit-reset")))
      : null;
  const wait = longestWait(retryAfter, reset);

  if (secondaryText) return { kind: "secondary", ...wait };
  if (quotaSpent || primaryText) return { kind: "primary", ...wait };
  if (retryAfter !== null || /rate.?limit/i.test(documentationUrl) || res.status === 429) {
    return { kind: "secondary", ...wait };
  }
  return null;
}

function longestWait(a: number | null, b: number | null): { retryAfterSeconds?: number } {
  const known = [a, b].filter((v): v is number => v !== null);
  return known.length > 0 ? { retryAfterSeconds: Math.max(...known) } : {};
}

export class GitHubTracker implements Tracker {
  readonly id: TrackerId;
  readonly label: string;

  private token: string | null;
  private repo: GitHubRepoRef | null;
  private refName: string | undefined;
  private fetchImpl: FetchImpl;

  constructor(config: GitHubTrackerConfig) {
    this.token = config.token;
    this.repo = config.repo;
    this.refName = config.name;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.id = config.id ?? "github";
    this.label = config.label ?? config.name ?? "GitHub";
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
      kind: "github",
      ...(this.refName ? { name: this.refName } : {}),
      ...(slug ? { binding: { key: slug, name: slug } } : {}),
    };
  }

  private formatRef = (issueNumber: string): string =>
    formatIssueReference({
      trackerName: this.refName,
      kind: "github",
      ...(this.repo ? { key: `${this.repo.owner}/${this.repo.repo}` } : {}),
      issueId: issueNumber,
    });

  async listIssues(options?: ListIssuesOptions): Promise<TrackerIssue[]> {
    if (!this.token || !this.repo) {
      throw new Error("GitHub is not configured (missing token or repo binding)");
    }
    const ref = this.repo;
    const state = options?.includeDone ? "all" : "open";
    const url = `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues?state=${state}&per_page=100&sort=created&direction=desc`;
    const nodes = await this.fetchIssues(url);
    return nodes
      .filter((n) => !n.pull_request)
      .map((n) => toTrackerIssue(n, ref, this.formatRef))
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
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (res.status === 404) return null;
    await this.assertOk(res);
    const node = (await res.json()) as GitHubIssueNode;
    if (node.pull_request) return null;
    return { ...toTrackerIssue(node, ref, this.formatRef), availableStatuses: GITHUB_AVAILABLE_STATUSES };
  }

  async listStatuses(): Promise<{ name: string; type?: string; color?: string }[]> {
    this.requireRepo();
    return GITHUB_AVAILABLE_STATUSES.map((s) => ({ ...s }));
  }

  async listComments(id: string): Promise<TrackerComment[]> {
    const ref = this.requireRepo();
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${encodeURIComponent(id)}/comments?per_page=100`,
        { headers: githubHeaders(this.token!) },
      );
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    await this.assertOk(res);
    const nodes = (await res.json()) as GitHubCommentNode[];
    return nodes.map(toTrackerComment);
  }

  async createIssue(input: {
    title: string;
    body: string;
    labels?: string[];
    priority?: string;
    parent?: string;
  }): Promise<TrackerIssue> {
    const ref = this.requireRepo();
    this.rejectPriority(input.priority);
    this.rejectParent(input.parent);
    const body: Record<string, unknown> = { title: input.title, body: input.body };
    if (input.labels && input.labels.length > 0) {
      body.labels = await this.resolveLabels(input.labels);
    }
    const node = await this.api<GitHubIssueNode>("POST", "issues", body);
    return toTrackerIssue(node, ref, this.formatRef);
  }

  async createLabel(input: { name: string; color?: string; description?: string }): Promise<IssueLabel & { id: string }> {
    const body: Record<string, unknown> = { name: input.name };
    if (input.color) body.color = input.color.replace(/^#/, "");
    if (input.description) body.description = input.description;
    const node = await this.api<{ name: string; color?: string | null }>("POST", "labels", body);
    const color = normalizeGitHubColor(node.color);
    return { id: node.name, name: node.name, ...(color ? { color } : {}) };
  }

  async findLabel(name: string): Promise<(IssueLabel & { id: string; description?: string }) | null> {
    const needle = name.trim().toLowerCase();
    const found = (await this.fetchRepoLabelNodes()).find((l) => l.name.toLowerCase() === needle);
    return found ? { id: found.name, ...found } : null;
  }

  async updateLabel(
    id: string,
    patch: { name?: string; color?: string; description?: string },
  ): Promise<IssueLabel & { id: string; description?: string }> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.new_name = patch.name;
    if (patch.color !== undefined) body.color = patch.color.replace(/^#/, "");
    if (patch.description !== undefined) body.description = patch.description;
    const node = await this.api<{ name: string; color?: string | null; description?: string | null }>(
      "PATCH",
      `labels/${encodeURIComponent(id)}`,
      body,
    );
    const color = normalizeGitHubColor(node.color);
    return {
      id: node.name,
      name: node.name,
      ...(color ? { color } : {}),
      ...(node.description ? { description: node.description } : {}),
    };
  }

  async deleteUnusedLabel(id: string, name: string): Promise<void> {
    const ref = this.requireRepo();
    // PRs also carry labels and must prevent deletion.
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues?labels=${encodeURIComponent(id)}&state=all&per_page=1`,
        { headers: githubHeaders(this.token!) },
      );
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    await this.assertOk(res);
    const carriers = (await res.json()) as { number: number }[];
    if (carriers.length > 0) {
      throw new Error(
        `Label "${name}" is now in use (e.g. on #${carriers[0].number}) — remove it from those issues before deleting it.`,
      );
    }
    await this.api<unknown>("DELETE", `labels/${encodeURIComponent(id)}`);
  }

  async addComment(id: string, body: string): Promise<TrackerComment> {
    const data = await this.api<GitHubCommentNode>(
      "POST",
      `issues/${encodeURIComponent(id)}/comments`,
      { body },
    );
    return toTrackerComment(data);
  }

  async deleteComment(commentId: string): Promise<void> {
    await this.api<unknown>("DELETE", `issues/comments/${encodeURIComponent(commentId)}`);
  }

  async updateComment(
    issueId: string,
    commentId: string,
    body: string,
  ): Promise<{ comment: TrackerComment; previousBody: string }> {
    const existing = await this.fetchComment(commentId);
    const onIssue = issueNumberFromUrl(existing.issue_url);
    if (onIssue !== issueId) {
      const where = onIssue ? ` — it is on #${onIssue}.` : ".";
      throw new Error(
        `Comment ${commentId} is not on issue #${issueId}${where} A comment id is repository-global, ` +
          `so the issue it belongs to is checked against the one named.`,
      );
    }
    const author = existing.user?.login ?? "";
    const viewer = await this.resolveViewerLogin();
    if (author.toLowerCase() !== viewer.toLowerCase()) {
      throw new TrackerPermissionError(
        `Comment ${commentId} on #${issueId} was written by @${author || "someone else"}, not by ` +
          `@${viewer} (the identity ShipIt writes as). ShipIt only edits its own comments — post a ` +
          `new comment instead of rewriting someone else's.`,
      );
    }
    const updated = await this.api<GitHubCommentNode>(
      "PATCH",
      `issues/comments/${encodeURIComponent(commentId)}`,
      { body },
    );
    return { comment: toTrackerComment(updated), previousBody: existing.body ?? "" };
  }

  private async fetchComment(commentId: string): Promise<GitHubCommentNode> {
    const ref = this.requireRepo();
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/comments/${encodeURIComponent(commentId)}`,
        { headers: githubHeaders(this.token!) },
      );
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    if (res.status === 404) {
      throw new Error(`Comment ${commentId} not found in ${ref.owner}/${ref.repo}.`);
    }
    await this.assertOk(res);
    return (await res.json()) as GitHubCommentNode;
  }

  async updateIssue(
    id: string,
    patch: { title?: string; description?: string; labels?: string[]; priority?: string; parent?: string | null },
  ): Promise<TrackerIssue> {
    this.rejectPriority(patch.priority);
    this.rejectParent(patch.parent);
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body.title = patch.title;
    if (patch.description !== undefined) body.body = patch.description;
    if (patch.labels !== undefined) body.labels = await this.resolveLabels(patch.labels);
    return this.patchIssue(id, body);
  }

  async setStatus(id: string, status: string): Promise<TrackerIssue> {
    return this.patchIssue(id, resolveGitHubState(status));
  }

  async setAssignee(id: string, assignee: string | null, opts?: SetAssigneeOptions): Promise<TrackerIssue> {
    let assignees: string[];
    if (assignee === null) {
      assignees = [];
    } else if (!opts?.raw && assignee.trim().toLowerCase() === "me") {
      assignees = [await this.resolveViewerLogin()];
    } else {
      assignees = [assignee];
    }
    return this.patchIssue(id, { assignees });
  }

  private async patchIssue(id: string, body: Record<string, unknown>): Promise<TrackerIssue> {
    const ref = this.requireRepo();
    const node = await this.api<GitHubIssueNode>("PATCH", `issues/${encodeURIComponent(id)}`, body);
    return toTrackerIssue(node, ref, this.formatRef);
  }

  // Reject unknown labels so typos cannot create labels through the write API.
  private async resolveLabels(names: string[]): Promise<string[]> {
    const existing = await this.fetchRepoLabels();
    const existingNames = existing.map((l) => l.name);
    const resolved: string[] = [];
    for (const raw of names) {
      const needle = raw.trim().toLowerCase();
      const match = existingNames.find((l) => l.toLowerCase() === needle);
      if (!match) {
        throw new TrackerResolutionError(
          `No label "${raw}" exists in this repo.`,
          "label",
          existingNames.slice(0, 50),
        );
      }
      if (!resolved.includes(match)) resolved.push(match);
    }
    return resolved;
  }

  async listLabels(): Promise<IssueLabel[]> {
    return this.fetchRepoLabels();
  }

  private async fetchRepoLabels(): Promise<IssueLabel[]> {
    return (await this.fetchRepoLabelNodes()).map(({ name, color }) => ({ name, ...(color ? { color } : {}) }));
  }

  private async fetchRepoLabelNodes(): Promise<{ name: string; color?: string; description?: string }[]> {
    const ref = this.requireRepo();
    let res: Response;
    try {
      res = await this.fetchImpl(
        `https://api.github.com/repos/${ref.owner}/${ref.repo}/labels?per_page=100`,
        { headers: githubHeaders(this.token!) },
      );
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    await this.assertOk(res);
    const nodes = (await res.json()) as {
      name?: string | null;
      color?: string | null;
      description?: string | null;
    }[];
    return nodes
      .filter((n) => Boolean(n?.name))
      .map((n) => {
        const color = normalizeGitHubColor(n.color);
        return {
          name: n.name!,
          ...(color ? { color } : {}),
          ...(n.description ? { description: n.description } : {}),
        };
      });
  }

  private rejectPriority(priority: string | undefined): void {
    if (priority !== undefined) {
      throw new TrackerResolutionError(
        "GitHub Issues has no priority field. Use a label (e.g. --label 'priority: high') or file on Linear instead.",
        "priority",
        [],
      );
    }
  }

  private rejectParent(parent: string | null | undefined): void {
    if (parent !== undefined) {
      throw new TrackerResolutionError(
        "GitHub Issues are flat — no sub-issue nesting. Sub-issue parents are Linear-only.",
        "parent",
        [],
      );
    }
  }

  private async resolveViewerLogin(): Promise<string> {
    if (!this.token) throw new Error("GitHub is not configured (missing token)");
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.github.com/user", { headers: githubHeaders(this.token) });
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    await this.assertOk(res);
    const data = (await res.json()) as { login: string };
    return data.login;
  }

  private requireRepo(): GitHubRepoRef {
    if (!this.token || !this.repo) {
      throw new Error("GitHub is not configured (missing token or repo binding)");
    }
    return this.repo;
  }

  private async api<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
    const ref = this.requireRepo();
    const init: RequestInit = {
      method,
      headers: { ...githubHeaders(this.token!), "Content-Type": "application/json" },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/repos/${ref.owner}/${ref.repo}/${path}`, init);
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    const throttled = await this.throttleError(res);
    if (throttled) throw new Error(throttled);
    if (res.status === 401 || res.status === 403) {
      throw new Error(this.accessError(res.status));
    }
    if (!res.ok) {
      throw new Error(await parseGitHubError(res));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  private async fetchIssues(url: string): Promise<GitHubIssueNode[]> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: githubHeaders(this.token!) });
    } catch (err) {
      throw new Error(`GitHub request failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    await this.assertOk(res);
    return (await res.json()) as GitHubIssueNode[];
  }

  private async assertOk(res: Response): Promise<void> {
    const throttled = await this.throttleError(res);
    if (throttled) throw new Error(throttled);
    if (res.status === 401 || res.status === 403) {
      throw new Error(this.accessError(res.status));
    }
    if (res.status === 404) {
      throw new Error(this.accessError(404));
    }
    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}`);
    }
  }

  private async throttleError(res: Response): Promise<string | null> {
    if (res.status !== 403 && res.status !== 429) return null;
    let body = "";
    try {
      body = await res.clone().text();
    } catch {
      // Headers can still identify the throttle.
    }
    const throttle = classifyGitHubThrottle(res, body);
    if (!throttle) return null;
    const slug = this.repo ? `${this.repo.owner}/${this.repo.repo}` : null;
    const wait = waitPhrase(throttle.retryAfterSeconds);
    if (throttle.kind === "secondary") {
      return (
        `GitHub is throttling requests${slug ? ` to \`${slug}\`` : ""} — a secondary rate limit ` +
        `(${res.status}), not an access failure, so checking the repository slug or the credential's grant ` +
        `will not help. Wait ${wait} and retry. If this is a batch of writes, slow the rate — GitHub's ` +
        `content-creation limits are per-minute and per-hour.`
      );
    }
    return (
      `GitHub's request quota for the connected credential is exhausted (${res.status}) — ` +
      `\`x-ratelimit-remaining\` is 0, so this is a rate limit rather than the usual meaning of a ${res.status}. ` +
      `The quota resets in ${wait}; retry after that${slug ? `, and only if it still fails check that the ` +
      `credential can access \`${slug}\`` : ""}.`
    );
  }

  private accessError(status: number): string {
    if (!this.repo) {
      return "GitHub rejected the token (401/403). Re-connect GitHub with a valid token.";
    }
    const slug = `${this.repo.owner}/${this.repo.repo}`;
    if (status === 401) {
      return `GitHub rejected the token (401). Re-connect GitHub with a valid token.`;
    }
    return (
      `GitHub returned ${status} for \`${slug}\` — the repository either does not exist or ` +
      `the connected GitHub credential cannot access it. GitHub returns the same response for both, ` +
      `so check the slug and that the credential is granted Issues access there.`
    );
  }
}
