import type { DocEntry } from "../../server/shared/types.js";

export function dirOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) return "";
  return path.slice(0, lastSlash + 1);
}

export function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}

export function isChecklistPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "checklist.md";
}

export function siblingsOf<T extends { path: string }>(path: string, entries: T[]): T[] {
  const dir = dirOf(path);
  return entries.filter((e) => dirOf(e.path) === dir);
}

/** Filename (without extension), lowercased. Used for ordering siblings. */
function stem(path: string): string {
  const name = basenameOf(path);
  const dot = name.lastIndexOf(".");
  return (dot < 0 ? name : name.slice(0, dot)).toLowerCase();
}

export function orderSiblingsForTabs<T extends { path: string }>(siblings: T[]): T[] {
  const rank = (p: string): number => {
    const s = stem(p);
    if (s === "plan") return 0;
    if (s === "checklist") return 1;
    return 2;
  };
  return [...siblings].sort((a, b) => {
    const r = rank(a.path) - rank(b.path);
    if (r !== 0) return r;
    return stem(a.path).localeCompare(stem(b.path));
  });
}

export function siblingTabLabel(path: string): string {
  const s = stem(path);
  if (!s) return path;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function isPlanPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "plan.md";
}

export interface DocIndex {

  dirsWithChecklist: Set<string>;

  dirsWithPlan: Set<string>;

  trackedCountByDir: Map<string, number>;

  trackedPaths: Set<string>;
}

export function buildDocIndex(entries: DocEntry[]): DocIndex {
  const dirsWithChecklist = new Set<string>();
  const dirsWithPlan = new Set<string>();
  for (const e of entries) {
    const dir = dirOf(e.path);
    if (dir === "") continue;
    if (isChecklistPath(e.path)) dirsWithChecklist.add(dir);
    else if (isPlanPath(e.path)) dirsWithPlan.add(dir);
  }

  const trackedCountByDir = new Map<string, number>();
  const trackedPaths = new Set<string>();
  const index: DocIndex = { dirsWithChecklist, dirsWithPlan, trackedCountByDir, trackedPaths };
  for (const e of entries) {

    if (trackedPaths.has(e.path)) continue;
    if (!isTrackedIn(index, e)) continue;
    trackedPaths.add(e.path);
    const dir = dirOf(e.path);
    trackedCountByDir.set(dir, (trackedCountByDir.get(dir) ?? 0) + 1);
  }
  return index;
}

export function isTrackedIn(
  index: DocIndex,
  entry: Pick<DocEntry, "path" | "issue">,
): boolean {
  if (isPlanPath(entry.path)) return true;
  if (isChecklistPath(entry.path)) return true;
  if (entry.issue !== undefined) return true;
  const dir = dirOf(entry.path);
  if (dir === "") return false;

  return index.dirsWithChecklist.has(dir);
}

/**
 * Return true if the indexed list contains a tracked doc in the same directory
 * as `path` other than `path` itself. Used to hide incidental files (e.g. a
 * stray `README.md`) in the Other tab when a tracked doc exists alongside them.
 *
 * Files at the repo root (no directory prefix) are never considered siblings —
 * the "feature directory" concept only applies inside a folder like
 * `docs/NNN-feature/`. A top-level `README.md` next to a top-level tracked
 * doc would otherwise be erroneously hidden.
 */
export function hasTrackedSiblingIn(index: DocIndex, path: string): boolean {
  const dir = dirOf(path);
  if (dir === "") return false;
  const inDir = index.trackedCountByDir.get(dir) ?? 0;

  // path the index has never seen contributes nothing to the count.
  return inDir - (index.trackedPaths.has(path) ? 1 : 0) > 0;
}

export function hasTrackedPlanSiblingIn(index: DocIndex, path: string): boolean {
  if (!isChecklistPath(path)) return false;
  const dir = dirOf(path);
  if (dir === "") return false;

  return index.dirsWithPlan.has(dir);
}
