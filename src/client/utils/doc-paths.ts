import type { DocEntry } from "../../server/shared/types.js";

/** Return the directory portion of a path, including trailing slash. Empty string if no slash. */
export function dirOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash < 0) return "";
  return path.slice(0, lastSlash + 1);
}

/** Return the filename (last segment) of a path. */
export function basenameOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash < 0 ? path : path.slice(lastSlash + 1);
}

/** Return true for the secondary tracking file in a feature-doc directory. */
export function isChecklistPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "checklist.md";
}

/**
 * Return all entries in `entries` whose directory matches `path`'s directory.
 * The result includes the entry for `path` itself (if present in `entries`).
 * Order is the same as `entries`.
 */
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

/**
 * Order sibling docs for the modal tab strip:
 * `plan` first, `checklist` second, then alphabetical by stem.
 */
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

/**
 * Human-readable label for a sibling tab. Capitalizes the filename stem
 * ("plan" → "Plan", "checklist" → "Checklist", "readme" → "Readme").
 */
export function siblingTabLabel(path: string): string {
  const s = stem(path);
  if (!s) return path;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Return true if `path` is a feature-directory `plan.md`. The primary row of a
 * feature directory is always tracked, regardless of frontmatter.
 */
export function isPlanPath(path: string): boolean {
  return basenameOf(path).toLowerCase() === "plan.md";
}

/**
 * Everything the three grouping predicates below need, precomputed per
 * directory in one pass over the doc list.
 *
 * **This exists for cost, not for tidiness.** The predicates are each asked
 * about every doc in the list, and the naive form answers each question by
 * scanning the whole list again — `hasTrackedSibling` scanning it once per
 * candidate sibling, since it calls `isTracked` (itself a scan) *before* the
 * cheap same-directory test. Over n docs with u of them untracked that is
 * O(u²·n), and it runs inside `DocsViewer`'s render body. Measured on this
 * repository (n = 866, u = 96) in Chrome: **342–486 ms per render**, on a
 * component that re-renders with its parent — i.e. once per streamed token
 * while the Docs tab is open. With the index it is one pass, ~1 ms.
 *
 * Taking the index rather than the doc list is deliberate, and it is the part
 * that stops the defect coming back: a predicate that accepts `entries` reads
 * as free at the call site and hides the scan, which is how a per-doc call in a
 * render body became O(u²·n) without anyone noticing. Threading the index makes
 * "who pays for the pass" visible in the signature. There is deliberately no
 * `(path, entries)` convenience wrapper — the one caller that had a single
 * question was this component asking n of them.
 */
export interface DocIndex {
  /** Directories holding a `checklist.md`. */
  dirsWithChecklist: Set<string>;
  /** Directories holding a `plan.md`. */
  dirsWithPlan: Set<string>;
  /** How many tracked docs each directory holds. */
  trackedCountByDir: Map<string, number>;
  /** Paths of the tracked docs, so a doc can exclude *itself* from its dir's count. */
  trackedPaths: Set<string>;
}

/** Build a {@link DocIndex} from a doc list. One pass for the sets, one for tracking. */
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
    if (!isTrackedIn(index, e)) continue;
    trackedPaths.add(e.path);
    const dir = dirOf(e.path);
    trackedCountByDir.set(dir, (trackedCountByDir.get(dir) ?? 0) + 1);
  }
  return index;
}

/**
 * Return true when a doc is "tracked" — i.e. a primary work doc that belongs in
 * the Tracked list, as opposed to incidental markdown (a stray `README.md`,
 * `notes.md`, etc.).
 *
 * docs/168 moved work tracking out to the issue tracker, so this grouping can
 * no longer key off a frontmatter field. The replacement is purely structural
 * and needs no frontmatter: a doc is tracked if it is a feature-directory `plan.md` or
 * `checklist.md`, carries an `issue:` pointer, or has a `checklist.md` sibling
 * in the same directory. This keeps the same docs "tracked" as before (every
 * feature dir has a plan and/or checklist) without depending on the removed
 * fields.
 */
export function isTrackedIn(
  index: DocIndex,
  entry: Pick<DocEntry, "path" | "issue">,
): boolean {
  if (isPlanPath(entry.path)) return true;
  if (isChecklistPath(entry.path)) return true;
  if (entry.issue !== undefined) return true;
  const dir = dirOf(entry.path);
  if (dir === "") return false;
  // `entry` is not itself a checklist (that returned true above), so any
  // checklist recorded for this directory is necessarily a *different* doc —
  // which is what the "other than itself" clause of the rule requires.
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
  // Subtract `path` itself only when it is in the indexed list AND tracked; a
  // path the index has never seen contributes nothing to the count.
  return inDir - (index.trackedPaths.has(path) ? 1 : 0) > 0;
}

/**
 * Return true when `path` is a checklist with a `plan.md` in the same
 * directory. A feature directory renders its `plan.md` as the single primary
 * row, so the sibling checklist is suppressed from the list (it stays
 * reachable via the modal's sibling tabs). Structural test — needs no
 * frontmatter.
 */
export function hasTrackedPlanSiblingIn(index: DocIndex, path: string): boolean {
  if (!isChecklistPath(path)) return false;
  const dir = dirOf(path);
  if (dir === "") return false;
  // `path` is a checklist, so the indexed `plan.md` is always a different doc.
  return index.dirsWithPlan.has(dir);
}

