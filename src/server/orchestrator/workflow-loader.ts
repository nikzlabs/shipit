/**
 * Workflow loader & trigger matcher.
 *
 * Reads `.github/workflows/*.yml` from a bare git cache via `git ls-tree` +
 * `git show`, extracts each workflow's PR-relevant triggers (`push`,
 * `pull_request`, `pull_request_target`) along with their `branches` /
 * `branches-ignore` / `tags` / `paths` / `paths-ignore` filters, and provides
 * a helper to decide whether a given pull request would trigger any of them.
 *
 * Used by `CiGraceTracker` to short-circuit the "force pending" grace window
 * for PRs that provably can't produce a check run. Two shapes matter:
 *
 *   - **Path filters** — `paths-ignore: ['**.md']` + a docs-only PR.
 *   - **Event/branch filters** — the repo's only workflow is
 *     `on: { workflow_dispatch: , push: { branches: [release] } }`, so a PR
 *     from `shipit/xyz` into `main` matches no trigger at all and GitHub
 *     creates zero check runs (SHI / nikzlabs/shipit#1730). A release
 *     workflow gated on `push: { tags: ['v*'] }` is the same class.
 *
 * In both cases the empty check set is *terminal from the first poll*, so the
 * grace window must not apply — otherwise the CI indicator spins for a result
 * that is never coming.
 *
 * The glob semantics are a deliberate subset of GitHub Actions' matcher
 * (which itself uses minimatch under the hood): `**`, `*`, and `?` are
 * supported; character classes and brace alternation are not. The subset
 * covers the patterns observed in practice — anything more exotic falls back
 * to "treat as always-applies", which preserves the conservative behavior.
 */

import simpleGit from "simple-git";
import { parse as parseYaml } from "yaml";

/** PR-relevant trigger event names (we ignore manual/scheduled triggers). */
const RELEVANT_EVENTS = ["push", "pull_request", "pull_request_target"] as const;

export type WorkflowEventName = (typeof RELEVANT_EVENTS)[number];

/** One PR-relevant trigger declared by a workflow, with its filters. */
export interface ParsedWorkflowEvent {
  event: WorkflowEventName;
  /** `paths:` — when non-empty, at least one changed file must match. */
  pathsInclude: string[];
  /** `paths-ignore:` — a file matching any of these is out of scope. */
  pathsIgnore: string[];
  /** `branches:` — when non-empty, the ref must match one of these. */
  branchesInclude: string[];
  /** `branches-ignore:` — the ref must match none of these. */
  branchesIgnore: string[];
  /**
   * True when a `push` trigger declares `tags:` / `tags-ignore:` and no
   * branch filter — GitHub then runs it for tag pushes only, so it can never
   * fire for a PR's head branch. Always false for `pull_request*` (tag
   * filters aren't valid there).
   */
  tagsOnly: boolean;
}

/** Trigger view of a single workflow file. */
export interface ParsedWorkflow {
  /**
   * True when the YAML couldn't be parsed. We then know nothing about the
   * workflow's triggers and must assume it applies (conservative — a spinner
   * that resolves late beats a wrongly-enabled merge button).
   */
  unparseable: boolean;
  /**
   * Every PR-relevant trigger the workflow declares. Empty means the
   * workflow declares only irrelevant triggers (`workflow_dispatch`,
   * `schedule`, `workflow_call`, …) and can never run for a pull request.
   */
  events: ParsedWorkflowEvent[];
}

/** The pull request a workflow is being matched against. */
export interface PrTriggerContext {
  /** The PR's head branch — what `push:` filters see. */
  headBranch?: string;
  /** The PR's base branch — what `pull_request:` filters see. */
  baseBranch?: string;
  /** Files the PR changes. Empty/absent means "unknown", matched conservatively. */
  changedFiles?: string[];
}

/**
 * Load and parse all `.github/workflows/*.{yml,yaml}` from a bare git repo.
 *
 * Returns:
 *   - `null` if the workflow directory doesn't exist in HEAD, or the git
 *     calls fail (callers should NOT cache this — retry on the next poll
 *     because the cache may not be fetched yet).
 *   - `[]` if the directory exists but contains no recognizable workflow
 *     files (also not worth caching — same retry rationale).
 *   - A non-empty array if at least one workflow file was successfully
 *     enumerated. Individual files that fail to parse are represented as
 *     `{ unparseable: true }` so the caller stays conservative.
 */
export async function loadAndParseWorkflows(
  bareRepoDir: string,
): Promise<ParsedWorkflow[] | null> {
  const git = simpleGit(bareRepoDir);
  let lsTreeOutput: string;
  try {
    lsTreeOutput = await git.raw([
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      ".github/workflows/",
    ]);
  } catch {
    return null;
  }
  const files = lsTreeOutput
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  if (files.length === 0) return null;

  const parsed: ParsedWorkflow[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await git.raw(["show", `HEAD:${file}`]);
    } catch {
      parsed.push({ unparseable: true, events: [] });
      continue;
    }
    parsed.push(parseWorkflowContent(content));
  }
  return parsed;
}

/** An event with no filters at all — fires for every push / every PR. */
function unfilteredEvent(event: WorkflowEventName): ParsedWorkflowEvent {
  return {
    event,
    pathsInclude: [],
    pathsIgnore: [],
    branchesInclude: [],
    branchesIgnore: [],
    tagsOnly: false,
  };
}

/**
 * Parse a single workflow YAML's `on:` block into the trigger view. Exposed
 * for unit testing; production callers go through `loadAndParseWorkflows`.
 */
export function parseWorkflowContent(content: string): ParsedWorkflow {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return { unparseable: true, events: [] };
  }
  if (!doc || typeof doc !== "object") {
    return { unparseable: true, events: [] };
  }
  // YAML 1.1 quirk: bare `on:` parses as the boolean `true` (the "Norway
  // problem" cousin). The `yaml` package follows YAML 1.2 by default, which
  // keeps `on` as a string key, so the bracket lookup below works. We still
  // probe both spellings defensively.
  const onValue =
    (doc as Record<string, unknown>).on ??
    (doc as Record<string | symbol, unknown>)[true as unknown as string];

  // Case 1: `on: push` (string)
  if (typeof onValue === "string") {
    return {
      unparseable: false,
      events: isRelevantEvent(onValue) ? [unfilteredEvent(onValue)] : [],
    };
  }

  // Case 2: `on: [push, pull_request]` (array)
  if (Array.isArray(onValue)) {
    const events = onValue
      .filter((e): e is WorkflowEventName => typeof e === "string" && isRelevantEvent(e))
      .map(unfilteredEvent);
    return { unparseable: false, events };
  }

  // Case 3: `on: { pull_request: { branches: [...], paths: [...] } }` (map)
  if (onValue && typeof onValue === "object") {
    const events: ParsedWorkflowEvent[] = [];
    for (const eventName of RELEVANT_EVENTS) {
      if (!(eventName in onValue)) continue;
      const eventCfg = (onValue as Record<string, unknown>)[eventName];
      // `on: { push: null }` or `on: { pull_request: }` — event present but
      // empty config means "fire for every push/PR with no filter."
      if (eventCfg === null || eventCfg === undefined) {
        events.push(unfilteredEvent(eventName));
        continue;
      }
      if (typeof eventCfg !== "object") continue;
      const cfg = eventCfg as Record<string, unknown>;
      const branchesInclude = toStringArray(cfg.branches);
      const branchesIgnore = toStringArray(cfg["branches-ignore"]);
      // Tag filters are only meaningful on `push`. A push trigger that names
      // tags and no branches fires exclusively for tag pushes.
      const hasTagFilter =
        eventName === "push"
        && (toStringArray(cfg.tags).length > 0 || toStringArray(cfg["tags-ignore"]).length > 0);
      events.push({
        event: eventName,
        pathsInclude: toStringArray(cfg.paths),
        pathsIgnore: toStringArray(cfg["paths-ignore"]),
        branchesInclude,
        branchesIgnore,
        tagsOnly: hasTagFilter && branchesInclude.length === 0 && branchesIgnore.length === 0,
      });
    }
    return { unparseable: false, events };
  }

  // No `on:` block we can make sense of — assume nothing relevant is declared.
  return { unparseable: false, events: [] };
}

function isRelevantEvent(name: string): name is WorkflowEventName {
  return (RELEVANT_EVENTS as readonly string[]).includes(name);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Decide whether the given pull request would trigger this workflow.
 *
 * Returns true when the workflow is unparseable (conservative) or when at
 * least one of its PR-relevant triggers survives both the branch filter and
 * the path filter. Returns false only when we can prove no trigger fires —
 * which makes an empty check-run set terminal rather than pending.
 */
export function workflowAppliesToPr(
  workflow: ParsedWorkflow,
  ctx: PrTriggerContext,
): boolean {
  if (workflow.unparseable) return true;
  return workflow.events.some(
    (event) => eventBranchApplies(event, ctx) && eventPathsApply(event, ctx.changedFiles ?? []),
  );
}

/**
 * Branch/ref gate. `push` filters match against the ref being pushed — for a
 * ShipIt PR that's the head branch. `pull_request` / `pull_request_target`
 * filters match against the PR's *base* branch, per GitHub's semantics.
 */
function eventBranchApplies(event: ParsedWorkflowEvent, ctx: PrTriggerContext): boolean {
  if (event.tagsOnly) return false;

  const ref = event.event === "push" ? ctx.headBranch : ctx.baseBranch;
  // Unknown ref — can't rule the trigger out, so keep it conservative.
  if (!ref) return true;

  if (event.branchesInclude.length > 0) {
    if (!event.branchesInclude.some((p) => globToRegex(p).test(ref))) return false;
  }
  if (event.branchesIgnore.length > 0) {
    if (event.branchesIgnore.some((p) => globToRegex(p).test(ref))) return false;
  }
  return true;
}

function eventPathsApply(event: ParsedWorkflowEvent, files: string[]): boolean {
  if (event.pathsInclude.length === 0 && event.pathsIgnore.length === 0) return true;
  // No changed-files info available — be conservative.
  if (files.length === 0) return true;

  const includeRegexes = event.pathsInclude.map(globToRegex);
  const ignoreRegexes = event.pathsIgnore.map(globToRegex);
  for (const file of files) {
    // GitHub rule: with `paths`, include-list is required to match. With
    // only `paths-ignore`, every non-matching file is in-scope.
    const matchesInclude =
      includeRegexes.length === 0 || includeRegexes.some((r) => r.test(file));
    if (!matchesInclude) continue;
    if (ignoreRegexes.some((r) => r.test(file))) continue;
    return true;
  }
  return false;
}

/**
 * Convert a GitHub-Actions-style glob to a `RegExp`. Supports `**`, `*`,
 * `?` and literal escapes. Character classes and brace alternation are
 * NOT supported (rare in practice; the parsing layer handles them by
 * returning `unparseable: true` only at the YAML-parse level — patterns
 * containing `[` or `{` will simply not match anything, which on the
 * paths-ignore side means "no file is excluded by this pattern"). Exposed
 * for unit testing.
 */
export function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        regex += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^$()|{}\\[]".includes(c)) {
      regex += `\\${c}`;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}
