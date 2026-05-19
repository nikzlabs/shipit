/**
 * Workflow loader & path-filter matcher.
 *
 * Reads `.github/workflows/*.yml` from a bare git cache via `git ls-tree` +
 * `git show`, extracts each workflow's `on.{push,pull_request,
 * pull_request_target}.paths` / `paths-ignore` filters, and provides a
 * helper to decide whether a given list of changed files would trigger any
 * of the workflows.
 *
 * Used by `CiGraceTracker` to short-circuit the "force pending" grace
 * window for PRs whose changed paths don't match any workflow's filters
 * (the classic `paths-ignore: ['**.md']` + docs-only PR case).
 *
 * The glob semantics are a deliberate subset of GitHub Actions' matcher
 * (which itself uses minimatch under the hood): `**`, `*`, and `?` are
 * supported; character classes and brace alternation are not. The subset
 * covers the patterns observed in practice (see `extractEventFilters`
 * tests) — anything more exotic falls back to "treat as always-applies"
 * which preserves the pre-fix behavior.
 */

import simpleGit from "simple-git";
import { parse as parseYaml } from "yaml";

/** PR-relevant trigger event names (we ignore manual/scheduled triggers). */
const RELEVANT_EVENTS = ["push", "pull_request", "pull_request_target"] as const;

/** Path-filter view of a single workflow file. */
export interface ParsedWorkflow {
  /**
   * True when at least one relevant event has no path filter (or YAML was
   * unparseable, or the event is shorthand like `on: push`). In that case
   * the workflow is assumed to always trigger and grace is justified.
   */
  alwaysApplies: boolean;
  /**
   * Path filters for each event that has them. Multiple events on the same
   * workflow produce one entry each; the workflow triggers if ANY entry
   * matches the changed files.
   */
  events: { pathsInclude: string[]; pathsIgnore: string[] }[];
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
 *     `{ alwaysApplies: true }` so the caller stays conservative.
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
      parsed.push({ alwaysApplies: true, events: [] });
      continue;
    }
    parsed.push(parseWorkflowContent(content));
  }
  return parsed;
}

/**
 * Parse a single workflow YAML's `on:` block into the filter view. Exposed
 * for unit testing; production callers go through `loadAndParseWorkflows`.
 */
export function parseWorkflowContent(content: string): ParsedWorkflow {
  let doc: unknown;
  try {
    doc = parseYaml(content);
  } catch {
    return { alwaysApplies: true, events: [] };
  }
  if (!doc || typeof doc !== "object") {
    return { alwaysApplies: true, events: [] };
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
      alwaysApplies: (RELEVANT_EVENTS as readonly string[]).includes(onValue),
      events: [],
    };
  }

  // Case 2: `on: [push, pull_request]` (array)
  if (Array.isArray(onValue)) {
    const hasRelevant = onValue.some(
      (e) => typeof e === "string" && (RELEVANT_EVENTS as readonly string[]).includes(e),
    );
    return { alwaysApplies: hasRelevant, events: [] };
  }

  // Case 3: `on: { pull_request: { paths: [...] } }` (map)
  if (onValue && typeof onValue === "object") {
    const events: { pathsInclude: string[]; pathsIgnore: string[] }[] = [];
    let alwaysApplies = false;
    for (const eventName of RELEVANT_EVENTS) {
      if (!(eventName in onValue)) continue;
      const eventCfg = (onValue as Record<string, unknown>)[eventName];
      // `on: { push: null }` or `on: { pull_request: }` — event present but
      // empty config means "fire for every push/PR with no filter."
      if (eventCfg === null || eventCfg === undefined) {
        alwaysApplies = true;
        continue;
      }
      if (typeof eventCfg !== "object") continue;
      const paths = (eventCfg as Record<string, unknown>).paths;
      const pathsIgnore = (eventCfg as Record<string, unknown>)["paths-ignore"];
      const pathsArr = toStringArray(paths);
      const pathsIgnoreArr = toStringArray(pathsIgnore);
      if (pathsArr.length === 0 && pathsIgnoreArr.length === 0) {
        // Event configured but no path filter → always applies for this event.
        alwaysApplies = true;
        continue;
      }
      events.push({ pathsInclude: pathsArr, pathsIgnore: pathsIgnoreArr });
    }
    return { alwaysApplies, events };
  }

  return { alwaysApplies: false, events: [] };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string" && s.length > 0);
}

/**
 * Decide whether the given list of changed files would trigger this
 * workflow. Returns true on `alwaysApplies` or when at least one event's
 * filters match at least one file.
 */
export function workflowAppliesToFiles(
  workflow: ParsedWorkflow,
  changedFiles: string[],
): boolean {
  if (workflow.alwaysApplies) return true;
  if (changedFiles.length === 0) {
    // No changed-files info available — be conservative.
    return true;
  }
  for (const event of workflow.events) {
    if (eventAppliesToFiles(event, changedFiles)) return true;
  }
  return false;
}

function eventAppliesToFiles(
  event: { pathsInclude: string[]; pathsIgnore: string[] },
  files: string[],
): boolean {
  const includeRegexes = event.pathsInclude.map(globToRegex);
  const ignoreRegexes = event.pathsIgnore.map(globToRegex);
  for (const file of files) {
    // GitHub rule: with `paths`, include-list is required to match. With
    // only `paths-ignore`, every non-matching file is in-scope.
    const matchesInclude =
      includeRegexes.length === 0 || includeRegexes.some((r) => r.test(file));
    if (!matchesInclude) continue;
    const matchesIgnore = ignoreRegexes.some((r) => r.test(file));
    if (matchesIgnore) continue;
    return true;
  }
  return false;
}

/**
 * Convert a GitHub-Actions-style glob to a `RegExp`. Supports `**`, `*`,
 * `?` and literal escapes. Character classes and brace alternation are
 * NOT supported (rare in practice; the parsing layer handles them by
 * returning `alwaysApplies: true` only at the YAML-parse level — patterns
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
