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
 * Classify a changed-file list into the notable subset (docs + config),
 * resolving the frontmatter `title` for docs against `workspaceDir`.
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
  return out;
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
