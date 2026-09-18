import { safeSimpleGit } from "../shared/git-hooks-guard.js";
import { parse as parseYaml } from "yaml";

const RELEVANT_EVENTS = ["push", "pull_request", "pull_request_target"] as const;

export type WorkflowEventName = (typeof RELEVANT_EVENTS)[number];

export interface ParsedWorkflowEvent {
  event: WorkflowEventName;
  pathsInclude: string[];
  pathsIgnore: string[];
  branchesInclude: string[];
  branchesIgnore: string[];
  tagsOnly: boolean;
}

export interface ParsedWorkflow {
  unparseable: boolean;
  events: ParsedWorkflowEvent[];
}

export interface PrTriggerContext {
  headBranch?: string;
  baseBranch?: string;
  /** Files the PR changes. Empty/absent means "unknown", matched conservatively. */
  changedFiles?: string[];
}

/** Null means unavailable or no workflow files; retry after the cache is fetched. */
export async function loadAndParseWorkflows(
  bareRepoDir: string,
): Promise<ParsedWorkflow[] | null> {
  const git = safeSimpleGit(bareRepoDir);
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
  // YAML 1.1 treats bare `on` as true; accept either key.
  const onValue =
    (doc as Record<string, unknown>).on ??
    (doc as Record<string | symbol, unknown>)[true as unknown as string];

  if (typeof onValue === "string") {
    return {
      unparseable: false,
      events: isRelevantEvent(onValue) ? [unfilteredEvent(onValue)] : [],
    };
  }

  if (Array.isArray(onValue)) {
    const events = onValue
      .filter((e): e is WorkflowEventName => typeof e === "string" && isRelevantEvent(e))
      .map(unfilteredEvent);
    return { unparseable: false, events };
  }

  if (onValue && typeof onValue === "object") {
    const events: ParsedWorkflowEvent[] = [];
    for (const eventName of RELEVANT_EVENTS) {
      if (!(eventName in onValue)) continue;
      const eventCfg = (onValue as Record<string, unknown>)[eventName];
      if (eventCfg === null || eventCfg === undefined) {
        events.push(unfilteredEvent(eventName));
        continue;
      }
      if (typeof eventCfg !== "object") continue;
      const cfg = eventCfg as Record<string, unknown>;
      const branchesInclude = toStringArray(cfg.branches);
      const branchesIgnore = toStringArray(cfg["branches-ignore"]);
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

  return { unparseable: false, events: [] };
}

function isRelevantEvent(name: string): name is WorkflowEventName {
  return (RELEVANT_EVENTS as readonly string[]).includes(name);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is string => typeof s === "string" && s.length > 0);
}

export function workflowAppliesToPr(
  workflow: ParsedWorkflow,
  ctx: PrTriggerContext,
): boolean {
  if (workflow.unparseable) return true;
  return workflow.events.some(
    (event) => eventBranchApplies(event, ctx) && eventPathsApply(event, ctx.changedFiles ?? []),
  );
}

function eventBranchApplies(event: ParsedWorkflowEvent, ctx: PrTriggerContext): boolean {
  if (event.tagsOnly) return false;

  const ref = event.event === "push" ? ctx.headBranch : ctx.baseBranch;
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
  if (files.length === 0) return true;

  const includeRegexes = event.pathsInclude.map(globToRegex);
  const ignoreRegexes = event.pathsIgnore.map(globToRegex);
  for (const file of files) {
    const matchesInclude =
      includeRegexes.length === 0 || includeRegexes.some((r) => r.test(file));
    if (!matchesInclude) continue;
    if (ignoreRegexes.some((r) => r.test(file))) continue;
    return true;
  }
  return false;
}

/** Supports **, * and ?; brackets and braces are literal characters. */
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
