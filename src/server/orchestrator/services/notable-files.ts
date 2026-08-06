/**
 * Notable-file classification for the PR card's changed-docs strip (docs/205).
 *
 * A "notable" file is one worth surfacing on the PR lifecycle card so the user
 * notices it moved without scanning the full diff or detouring to the Docs
 * panel. Three tiers:
 *
 *   1. **Design docs** — any `.md` file, plus any `.html`/`.htm` (a committed
 *      mockup; the viewer renders it rather than showing markup).
 *   2. **Config** — a small allowlist of "wait, what moved?" files.
 *   3. **Images** — any added/modified image (by extension). The chip opens the
 *      asset inline so the user can eyeball it.
 *
 * Every chip is labelled by its {@link compactPathLabel} — `246/plan.md`, not a
 * document title. This surface is a flat PR file list, not a document browser:
 * the *file* is the useful identity here (a feature's `plan.md` and
 * `checklist.md` are indistinguishable when both render as the feature's
 * title), and the Docs panel remains the title-and-description surface.
 *
 * Everything else stays in the full diff. The list is a pure 1:1 projection of
 * the PR's changed-file set — no collapsing, no title resolution, no disk reads
 * — so it's sticky and drift-free by construction.
 */

import path from "node:path";

import type { GitManager } from "../../shared/git.js";
import type { NotableFileChange } from "../../shared/types.js";
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

/**
 * HTML extensions surfaced on the strip, matched by (lowercased) extension.
 * A committed prototype (`mockup.html`, a `mocks/` subdir) is a first-class
 * design artifact in this repo's doc convention, and the file viewer *renders*
 * HTML rather than showing markup (docs/219 — `file-content-kind.ts` splits
 * `.html`/`.htm` out of the `code` bucket), so the chip opens a live mockup.
 *
 * Matched blanket, like {@link IMAGE_EXTENSIONS} and the `.md` rule — an app's
 * `index.html` gets a chip too. A location gate ("only under `docs/`", "only
 * beside a changed `.md`") was considered and rejected: no other tier here is
 * path-dependent, and a change-set-dependent rule would make one file's chip
 * appear or vanish based on what *else* the PR touched, breaking the per-file
 * determinism the 1:1 projection rests on. If noise shows up, the fix is an
 * exclusion rule applied uniformly across all tiers, not a bespoke gate here.
 */
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/**
 * Image extensions surfaced on the strip, matched by (lowercased) extension.
 * An added/modified image is worth a chip so the user can eyeball the asset
 * inline (committed mockups, screenshots, logos) without scanning the diff.
 */
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
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

/** A `NNN-` feature-directory prefix — shortened to just the digits. */
const FEATURE_DIR_PREFIX_RE = /^(\d+)-/;

/**
 * Compact, distinguishable chip label for a changed file: its basename
 * prefixed by its immediate parent directory (`shipit-docs/environment.md`).
 * A `NNN-slug` feature dir shortens to its number (`246-native-issue-tracker-
 * evaluation/plan.md` → `246/plan.md`), and a repo-root file is just its
 * basename (`shipit.yaml`). Only the immediate parent appears — the full path
 * already lives in the chip's `title=` tooltip.
 *
 * Pure string work on the diff path, so it resolves for a *deleted* file too,
 * and a path is unique within a diff — which is what makes the chip set a
 * collision-free 1:1 projection of the changed-file set.
 */
export function compactPathLabel(relativePath: string): string {
  const basename = path.posix.basename(relativePath);
  const dir = path.posix.dirname(relativePath);
  if (!dir || dir === "." || dir === "/") return basename;
  const parent = path.posix.basename(dir);
  if (!parent) return basename;
  const numbered = FEATURE_DIR_PREFIX_RE.exec(parent);
  return `${numbered ? numbered[1] : parent}/${basename}`;
}

/**
 * Classify a changed-file list into the notable subset (docs + config +
 * images), labelling each by {@link compactPathLabel}.
 *
 * A pure 1:1 projection: every classified change yields exactly one chip. No
 * collapsing — labels are path-derived, so they can't collide, and the docs
 * panel (which keys by path) can't drift from the strip.
 */
export function computeNotableFiles(changes: RawFileChange[]): NotableFileChange[] {
  const out: NotableFileChange[] = [];
  for (const change of changes) {
    const status = normalizeStatus(change.status);
    if (!status) continue;
    const basename = path.posix.basename(change.path);
    const label = compactPathLabel(change.path);
    const ext = path.extname(change.path).toLowerCase();

    if (CONFIG_FILENAMES.has(basename)) {
      out.push({ path: change.path, label, kind: "config", status });
    } else if (change.path.endsWith(".md") || HTML_EXTENSIONS.has(ext)) {
      out.push({ path: change.path, label, kind: "doc", status });
    } else if (IMAGE_EXTENSIONS.has(ext)) {
      out.push({ path: change.path, label, kind: "image", status });
    }
  }
  return out;
}

/**
 * Derive the notable-file list (docs + config + images) for a feature branch
 * vs its base, classifying the SAME committed merge-base change set the Docs
 * panel uses ({@link committedChangesVsBase}). Sharing that helper keeps the PR
 * card's strip and the Docs panel's "Modified in this session" list in lockstep
 * — the strip is just that set filtered to docs, the config allowlist, and
 * images.
 *
 * Returns `[]` when the base or merge-base can't be resolved — the toggle then
 * hides entirely.
 */
export async function notableFilesForBranch(
  git: GitManager,
  baseBranch: string,
): Promise<NotableFileChange[]> {
  const changes = await committedChangesVsBase(git, baseBranch);
  return computeNotableFiles(changes);
}
