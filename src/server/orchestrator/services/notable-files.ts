/**
 * Notable-file classification for the PR card's changed-docs strip (docs/205).
 *
 * A "notable" file is one worth surfacing on the PR lifecycle card so the user
 * notices it moved without scanning the full diff or detouring to the Docs
 * panel. Two tiers:
 *
 *   1. **Design docs** — any `.md` file. The chip reads the frontmatter `title`
 *      ("Session lifecycle") rather than the filename ("plan.md").
 *   2. **Config** — a small allowlist of "wait, what moved?" files.
 *
 * Everything else stays in the full diff. The list is a pure projection of the
 * PR's changed-file set, so it's sticky and drift-free by construction.
 */

import path from "node:path";

import type { GitManager } from "../../shared/git.js";
import type { NotableFileChange } from "../../shared/types.js";
import { resolveDocTitle } from "../markdown.js";
import { committedChangesVsBase } from "./git.js";

/**
 * Config files surfaced on the strip, matched by basename. `CLAUDE.md` /
 * `AGENTS.md` are `.md` but live here (not in the doc tier) because they're
 * agent-config, not design docs — config classification takes precedence over
 * the generic `.md` rule.
 */
const CONFIG_FILENAMES = new Set([
  "shipit.yaml",
  "docker-compose.yml",
  "CLAUDE.md",
  "AGENTS.md",
  "package.json",
]);

/** A changed file as reported by `git diff --name-status`. */
export interface RawFileChange {
  /** Single-letter git status (M, A, D, R100, C75, …). */
  status: string;
  path: string;
}

/**
 * Normalize a git status letter to the tri-state the chip dot renders.
 * Renames and copies map to "M" (the path on the new side is what we open).
 * Returns null for statuses we don't surface (e.g. type-change/unmerged).
 */
function normalizeStatus(raw: string): "M" | "A" | "D" | null {
  switch (raw.charAt(0).toUpperCase()) {
    case "A":
      return "A";
    case "D":
      return "D";
    case "M":
    case "R":
    case "C":
      return "M";
    default:
      return null;
  }
}

/**
 * Preference rank for collapsing doc chips that share a title — lower wins.
 * A feature directory is one logical document split across generic files
 * (`plan.md`, `checklist.md`, …); when several change together we keep a
 * single chip pointing at the canonical file so it opens the doc's main page.
 */
const DOC_FILENAME_RANK: Record<string, number> = { plan: 0, index: 1, readme: 2 };
function docFilenameRank(p: string): number {
  return DOC_FILENAME_RANK[path.basename(p, ".md").toLowerCase()] ?? 3;
}

/**
 * Collapse design-doc chips that resolve to the same title into one. A feature
 * dir's `plan.md` + `checklist.md` both derive their title from the directory
 * name ({@link resolveDocTitle} → `titleFromPath`), which previously surfaced
 * the same document as two identical chips on the PR card. We keep one chip per
 * title, preferring the canonical file (`plan.md`) so the click opens the doc's
 * main page, and preserving first-seen order.
 *
 * Config files are NOT deduped: two same-named configs in different directories
 * (a monorepo's multiple `package.json` / `docker-compose.yml`) are genuinely
 * distinct files the user needs to see separately.
 */
function dedupeNotableDocs(files: NotableFileChange[]): NotableFileChange[] {
  const docIndexByTitle = new Map<string, number>();
  const out: NotableFileChange[] = [];
  for (const file of files) {
    if (file.kind !== "doc") {
      out.push(file);
      continue;
    }
    const existingIdx = docIndexByTitle.get(file.title);
    if (existingIdx === undefined) {
      docIndexByTitle.set(file.title, out.length);
      out.push(file);
    } else if (docFilenameRank(file.path) < docFilenameRank(out[existingIdx].path)) {
      // A more canonical file collides — replace in place, keeping position.
      out[existingIdx] = file;
    }
  }
  return out;
}

/**
 * Classify a changed-file list into the notable subset (docs + config),
 * resolving the frontmatter `title` for docs against `workspaceDir`. Docs that
 * resolve to the same title are collapsed to a single chip (see
 * {@link dedupeNotableDocs}).
 */
export async function computeNotableFiles(
  workspaceDir: string,
  changes: RawFileChange[],
): Promise<NotableFileChange[]> {
  const out: NotableFileChange[] = [];
  for (const change of changes) {
    const status = normalizeStatus(change.status);
    if (!status) continue;
    const basename = path.basename(change.path);

    if (CONFIG_FILENAMES.has(basename)) {
      out.push({ path: change.path, title: basename, kind: "config", status });
    } else if (change.path.endsWith(".md")) {
      const title = await resolveDocTitle(path.join(workspaceDir, change.path), change.path);
      out.push({ path: change.path, title, kind: "doc", status });
    }
  }
  return dedupeNotableDocs(out);
}

/**
 * Derive the notable-file list (docs + config) for a feature branch vs its
 * base, classifying the SAME committed merge-base change set the Docs panel
 * uses ({@link committedChangesVsBase}). Sharing that helper keeps the PR
 * card's strip and the Docs panel's "Modified in this session" list in lockstep
 * — the strip is just that set filtered to docs + the config allowlist.
 *
 * Returns `[]` when the base or merge-base can't be resolved — the toggle then
 * hides entirely.
 */
export async function notableFilesForBranch(
  git: GitManager,
  workspaceDir: string,
  baseBranch: string,
): Promise<NotableFileChange[]> {
  const changes = await committedChangesVsBase(git, baseBranch);
  return computeNotableFiles(workspaceDir, changes);
}
