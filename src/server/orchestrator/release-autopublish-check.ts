/**
 * docs/214 — cold-start guard for the `release-branch` mechanism.
 *
 * GitHub Actions evaluates a workflow file *as it exists on the branch that was
 * pushed*. The merge-triggered `release.yml` (`on: push: { branches: [<branch>] }`)
 * that tags + publishes on merge therefore only auto-publishes once it has
 * actually landed on the maintenance branch. Two cold-start states silently run
 * nothing when a version-bump PR merges:
 *
 *   - the branch has **no** `.github/workflows/release.yml` at all (brand-new repo), or
 *   - the branch still carries the **legacy** tag-triggered workflow
 *     (`on: push: { tags: ['v*'] }` — no `branches:` trigger).
 *
 * In both, the bump PR merges and looks successful, but GitHub matches no
 * trigger → no tag, no GitHub Release. This is a bootstrap deadlock: the very
 * commit that *adds* the merge-triggered workflow is unreleased on `main` and
 * only reaches the maintenance branch by being released — which can't happen via
 * merge-publish until the workflow is already there.
 *
 * This module reads the workflow as it exists on the maintenance branch and
 * decides whether a merge will auto-publish, so `shipit release plan|prepare` can
 * warn (and name the remedy) instead of letting a merge no-op silently.
 */

import { parse as parseYaml } from "yaml";
import type { GitManager } from "../shared/git.js";

const WORKFLOW_PATH = ".github/workflows/release.yml";

export interface AutoPublishAssessment {
  /** Merging a bump PR into the maintenance branch will trigger the publish workflow. */
  canAutoPublish: boolean;
  /** A `release.yml` workflow exists on the branch at all (false → cold/new repo). */
  workflowPresent: boolean;
  /** Actionable warning to surface, or null when the merge will auto-publish. */
  warning: string | null;
}

/**
 * Does this workflow's `on:` fire a `push` event for `branch`? Pure (no git), so
 * the trigger logic is unit-testable against literal workflow YAML. Returns false
 * for a missing/unparseable file or a tag-only trigger.
 */
export function workflowAutoPublishesOnMerge(yamlText: string | null, branch: string): boolean {
  if (!yamlText) return false;
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return false;
  }
  if (!doc || typeof doc !== "object") return false;
  const rec = doc as Record<string, unknown>;
  // The `yaml` package (YAML 1.2 core schema) keeps the bare key `on` a string;
  // guard the YAML-1.1 `on → true` reading too, just in case a future config opts in.
  const onNode = "on" in rec ? rec.on : rec.true;
  return pushFiresForBranch(onNode, branch);
}

function pushFiresForBranch(onNode: unknown, branch: string): boolean {
  // `on: push` or `on: [push, …]` — a push trigger with no ref filters fires on
  // every branch.
  if (typeof onNode === "string") return onNode === "push";
  if (Array.isArray(onNode)) return onNode.includes("push");
  if (!onNode || typeof onNode !== "object") return false;
  if (!("push" in onNode)) return false;
  const push = (onNode as Record<string, unknown>).push;
  // `push:` with an empty/null body → no ref filters → fires on every branch.
  if (push === null || push === undefined) return true;
  if (typeof push !== "object" || Array.isArray(push)) return true;
  const p = push as Record<string, unknown>;
  const branches = normalizePatterns(p.branches);
  const branchesIgnore = normalizePatterns(p["branches-ignore"]);
  if (branches) return branches.some((pat) => matchRef(pat, branch));
  if (branchesIgnore) return !branchesIgnore.some((pat) => matchRef(pat, branch));
  // No branch filter. GitHub: when only `tags`/`tags-ignore` are defined, the
  // push event runs for tags ONLY — not for branches (this is the legacy
  // tag-triggered workflow). With no ref filters at all, it runs for every branch.
  if ("tags" in p || "tags-ignore" in p) return false;
  return true;
}

function normalizePatterns(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return null;
}

/** Minimal GitHub branch-filter glob: `*` (not `/`), `**` (incl. `/`), `?`. */
function matchRef(pattern: string, ref: string): boolean {
  if (pattern === ref) return true;
  if (!/[*?]/.test(pattern)) return false;
  return globToRegExp(pattern).test(ref);
}

function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Read the maintenance branch's release workflow and decide whether merging a
 * bump PR into it will auto-publish. Reads `origin/<branch>`, so the caller must
 * have fetched first (the `prepare` path fetches; the `plan` route fetches before
 * calling this). When the branch or workflow is absent — or carries the legacy
 * tag-only workflow — returns an actionable, bootstrap-pointing warning rather
 * than throwing or blocking.
 */
export async function assessMergeAutoPublish(git: GitManager, branch: string): Promise<AutoPublishAssessment> {
  const yamlText = await git.showFileAtRef(`origin/${branch}`, WORKFLOW_PATH);
  const workflowPresent = yamlText !== null;
  const canAutoPublish = workflowAutoPublishesOnMerge(yamlText, branch);
  if (canAutoPublish) {
    return { canAutoPublish: true, workflowPresent, warning: null };
  }
  return {
    canAutoPublish: false,
    workflowPresent,
    warning: buildWarning(branch, workflowPresent),
  };
}

function buildWarning(branch: string, workflowPresent: boolean): string {
  const cause = workflowPresent
    ? `the \`.github/workflows/release.yml\` on \`${branch}\` has no \`push\` trigger for \`${branch}\` (it's the legacy tag-triggered workflow)`
    : `\`${branch}\` has no \`.github/workflows/release.yml\``;
  return [
    `⚠ Merging into \`${branch}\` will NOT auto-publish a release: ${cause}.`,
    "GitHub Actions evaluates the workflow as it exists on the pushed branch, so the merge will run nothing — no tag, no GitHub Release.",
    `Bootstrap the maintenance branch once before relying on merge-publish: cut the first release via the tag path (push a \`vX.Y.Z\` tag on a commit that already carries the merge-triggered workflow), or run \`shipit release prepare --bootstrap\` when \`${branch}\` doesn't exist yet. Once the merge-triggered \`release.yml\` is on \`${branch}\`, every future merge auto-publishes.`,
  ].join(" ");
}
