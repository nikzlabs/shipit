import { parse as parseYaml } from "yaml";
import type { GitManager } from "../shared/git.js";

const WORKFLOW_PATH = ".github/workflows/release.yml";

export interface AutoPublishAssessment {
  canAutoPublish: boolean;
  workflowPresent: boolean;
  warning: string | null;
}

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
  // YAML 1.1 can parse the key `on` as true.
  const onNode = "on" in rec ? rec.on : rec.true;
  return pushFiresForBranch(onNode, branch);
}

function pushFiresForBranch(onNode: unknown, branch: string): boolean {
  if (typeof onNode === "string") return onNode === "push";
  if (Array.isArray(onNode)) return onNode.includes("push");
  if (!onNode || typeof onNode !== "object") return false;
  if (!("push" in onNode)) return false;
  const push = (onNode as Record<string, unknown>).push;
  if (push === null || push === undefined) return true;
  if (typeof push !== "object" || Array.isArray(push)) return true;
  const p = push as Record<string, unknown>;
  const branches = normalizePatterns(p.branches);
  const branchesIgnore = normalizePatterns(p["branches-ignore"]);
  if (branches) return branches.some((pat) => matchRef(pat, branch));
  if (branchesIgnore) return !branchesIgnore.some((pat) => matchRef(pat, branch));
  // A tag filter without a branch filter excludes branch pushes.
  if ("tags" in p || "tags-ignore" in p) return false;
  return true;
}

function normalizePatterns(v: unknown): string[] | null {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return null;
}

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

// The caller must fetch first: Actions uses the workflow on the pushed branch.
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

/**
 * Whether the workflow that will RUN publishes authored notes (docs/309).
 *
 * Read from the ref whose tree the release ships, not from the session
 * checkout: `--from main` merges that branch's workflow onto the release
 * commit, while `--pick` keeps the maintenance branch's own. Checking the
 * wrong one lets a hotfix commit notes that the running workflow ignores.
 */
export async function workflowPublishesAuthoredNotes(git: GitManager, payloadRef: string): Promise<boolean> {
  return yamlPublishesAuthoredNotes(await git.showFileAtRef(payloadRef, WORKFLOW_PATH));
}

/** The content test itself, so the checkout-side reader (`release-notes-draft.ts`) cannot drift from it. */
export function yamlPublishesAuthoredNotes(yamlText: string | null): boolean {
  return yamlText?.includes(".release-notes/") ?? false;
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
