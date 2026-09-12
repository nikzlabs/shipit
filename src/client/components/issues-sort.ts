import type { TrackerIssue } from "../../server/shared/types.js";
import { UNASSIGNED } from "./issues-filter.js";

/**
 * Nesting + two-level sorting core for the Issues panel (docs/206).
 *
 * Pure functions over the normalized `TrackerIssue[]` the adapters return —
 * nothing here knows about Linear or GitHub. Two concerns:
 *
 *  - **Sorting**: a user-defined PRIMARY key, then a SECONDARY key, then the
 *    issue identifier as a final stable tiebreak. Each axis has its own
 *    direction. The default (`priority` asc, no secondary) reproduces the prior
 *    fixed `priority.sortOrder → identifier` order, so behavior is unchanged
 *    until the user picks something else.
 *  - **Nesting**: sub-issues (those carrying a `parentId` present in the set)
 *    render under their parent and are sorted *within* that parent — never lifted
 *    into the top-level order. A sub-issue whose parent is NOT in the set (filtered
 *    out, done-and-hidden, beyond the fetch window) is promoted to the top level
 *    and flagged `orphan` so the UI can hint at the missing parent.
 */

export type SortKey = "priority" | "status" | "title" | "updated" | "assignee";

export type SecondaryKey = SortKey | "none";

export type GroupKey = "none" | "priority" | "status" | "assignee";

export type SortDir = 1 | -1;

export interface SortPrefs {
  primary: SortKey;
  primaryDir: SortDir;
  secondary: SecondaryKey;
  secondaryDir: SortDir;
  group: GroupKey;
}

export const DEFAULT_SORT_PREFS: SortPrefs = {
  primary: "priority",
  primaryDir: 1,
  secondary: "status",
  secondaryDir: 1,
  group: "none",
};

export const SORT_KEY_LABELS: Record<SortKey, string> = {
  priority: "Priority",
  status: "Status",
  title: "Title",
  updated: "Last updated",
  assignee: "Assignee",
};

export function isNonDefaultSort(p: SortPrefs): boolean {
  return (
    p.primary !== DEFAULT_SORT_PREFS.primary ||
    p.primaryDir !== DEFAULT_SORT_PREFS.primaryDir ||
    p.secondary !== DEFAULT_SORT_PREFS.secondary ||
    p.secondaryDir !== DEFAULT_SORT_PREFS.secondaryDir ||
    p.group !== DEFAULT_SORT_PREFS.group
  );
}

export function describeSort(p: SortPrefs): string {
  const arrow = (d: SortDir) => (d === 1 ? "↑" : "↓");
  let s = `${SORT_KEY_LABELS[p.primary]} ${arrow(p.primaryDir)}`;
  if (p.secondary !== "none") s += ` → ${SORT_KEY_LABELS[p.secondary]} ${arrow(p.secondaryDir)}`;
  if (p.group !== "none") s += `  ·  grouped by ${SORT_KEY_LABELS[p.group as SortKey]}`;
  return s;
}

const STATUS_TYPE_RANK: Record<string, number> = {
  triage: 0,
  backlog: 1,
  unstarted: 2,
  started: 3,
  completed: 4,
  canceled: 5,
};

function statusRank(issue: TrackerIssue): number {
  const type = issue.status?.type;
  if (type && type in STATUS_TYPE_RANK) return STATUS_TYPE_RANK[type];

  return 99;
}

function updatedMs(issue: TrackerIssue): number {
  if (!issue.updatedAt) return 0;
  const ms = Date.parse(issue.updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
}

function sortValue(issue: TrackerIssue, key: SortKey): number | string {
  switch (key) {
    case "priority":
      return issue.priority.sortOrder;
    case "status":
      return statusRank(issue);
    case "title":
      return issue.title.toLowerCase();
    case "updated":
      return -updatedMs(issue);
    case "assignee":

      return issue.assignee ? issue.assignee.name.toLowerCase() : "￿";
  }
}

function compareBy(a: TrackerIssue, b: TrackerIssue, key: SortKey, dir: SortDir): number {
  const va = sortValue(a, key);
  const vb = sortValue(b, key);
  if (va < vb) return -dir;
  if (va > vb) return dir;
  return 0;
}

export function compareIssues(a: TrackerIssue, b: TrackerIssue, prefs: SortPrefs): number {
  let c = compareBy(a, b, prefs.primary, prefs.primaryDir);
  if (c !== 0) return c;
  if (prefs.secondary !== "none") {
    c = compareBy(a, b, prefs.secondary, prefs.secondaryDir);
    if (c !== 0) return c;
  }
  return a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
}

export interface IssueTreeNode {
  issue: TrackerIssue;

  depth: number;
  children: IssueTreeNode[];

  orphan: boolean;
}

export function buildIssueTree(issues: TrackerIssue[], prefs: SortPrefs): IssueTreeNode[] {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const childrenByParent = new Map<string, TrackerIssue[]>();
  const roots: TrackerIssue[] = [];

  for (const issue of issues) {
    const pid = issue.parentId;
    if (pid && byId.has(pid)) {
      const arr = childrenByParent.get(pid);
      if (arr) arr.push(issue);
      else childrenByParent.set(pid, [issue]);
    } else {

      roots.push(issue);
    }
  }

  const sortIssues = (arr: TrackerIssue[]) => arr.slice().sort((a, b) => compareIssues(a, b, prefs));
  const visited = new Set<string>();

  const build = (issue: TrackerIssue, depth: number): IssueTreeNode => {
    visited.add(issue.id);
    const kids = (childrenByParent.get(issue.id) ?? []).filter((k) => !visited.has(k.id));
    return {
      issue,
      depth,
      orphan: depth === 0 && Boolean(issue.parentId),
      children: sortIssues(kids).map((k) => build(k, depth + 1)),
    };
  };

  const result = sortIssues(roots).map((r) => build(r, 0));

  // any issue the walk never reached to the top level so nothing silently vanishes.
  const leftover = issues.filter((i) => !visited.has(i.id));
  for (const r of sortIssues(leftover)) {
    if (!visited.has(r.id)) result.push(build(r, 0));
  }
  return result;
}

export interface IssueRowItem {
  issue: TrackerIssue;
  depth: number;
  hasChildren: boolean;

  childCount: number;
  collapsed: boolean;
  orphan: boolean;
}

export function collapsePredicate(
  overrides: Record<string, boolean>,
  narrow: boolean,
): (issueId: string) => boolean {
  return (id) => {
    const explicit = overrides[id];
    if (explicit !== undefined) return explicit;
    return narrow;                                                    
  };
}

export function flattenTree(nodes: IssueTreeNode[], isCollapsed: (issueId: string) => boolean): IssueRowItem[] {
  const out: IssueRowItem[] = [];
  const walk = (node: IssueTreeNode) => {
    const hasChildren = node.children.length > 0;
    const collapsed = hasChildren && isCollapsed(node.issue.id);
    out.push({
      issue: node.issue,
      depth: node.depth,
      hasChildren,
      childCount: node.children.length,
      collapsed,
      orphan: node.orphan,
    });
    if (hasChildren && !collapsed) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

export interface IssueGroup {
  key: string;
  label: string;
  nodes: IssueTreeNode[];
}

function groupValue(issue: TrackerIssue, group: Exclude<GroupKey, "none">): { key: string; label: string; rank: number } {
  switch (group) {
    case "priority":
      return { key: issue.priority.level, label: issue.priority.label, rank: issue.priority.sortOrder };
    case "status":
      return issue.status
        ? { key: issue.status.name, label: issue.status.name, rank: statusRank(issue) }
        : { key: "__nostatus", label: "No status", rank: 100 };
    case "assignee":
      return issue.assignee
        ? { key: issue.assignee.name, label: issue.assignee.name, rank: 0 }
        : { key: UNASSIGNED, label: "Unassigned", rank: 1 };
  }
}

export function groupRoots(roots: IssueTreeNode[], group: Exclude<GroupKey, "none">): IssueGroup[] {
  const groups = new Map<string, { label: string; rank: number; nodes: IssueTreeNode[] }>();
  for (const node of roots) {
    const { key, label, rank } = groupValue(node.issue, group);
    const entry = groups.get(key);
    if (entry) entry.nodes.push(node);
    else groups.set(key, { label, rank, nodes: [node] });
  }
  return [...groups.entries()]
    .map(([key, { label, rank, nodes }]) => ({ key, label, rank, nodes }))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ key, label, nodes }) => ({ key, label, nodes }));
}

export interface IssueSection {

  label: string | null;
  rows: IssueRowItem[];
}

export function buildSections(
  issues: TrackerIssue[],
  prefs: SortPrefs,
  isCollapsed: (issueId: string) => boolean,
): IssueSection[] {
  const roots = buildIssueTree(issues, prefs);
  if (prefs.group === "none") {
    return [{ label: null, rows: flattenTree(roots, isCollapsed) }];
  }
  return groupRoots(roots, prefs.group).map((g) => ({
    label: g.label,
    rows: flattenTree(g.nodes, isCollapsed),
  }));
}
