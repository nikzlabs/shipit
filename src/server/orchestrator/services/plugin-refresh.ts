/**
 * docs/262 req 12 — `shipit plugin refresh`, the agent's verb for "bring this
 * plugin repository to its declared version now".
 *
 * **Refresh is generation activation, not a second mechanism** (plan §2). It
 * runs exactly the round a `shipit.yaml` edit runs, so every property that
 * round already has holds here unchanged: staging then atomic publish, install
 * before publish, a failure leaving the prior generation whole and live, and
 * one serial queue per repository. What this module adds is the part an
 * interactive caller needs and a fire-and-forget trigger does not — it AWAITS
 * the round and reports what moved.
 *
 * Before/after is read from disk on both sides rather than inferred from the
 * activation outcome, for the same reason the generation record lives inside
 * the generation: the commit that is live is a fact about the filesystem, and a
 * report assembled from anything else can disagree with what the session will
 * actually run.
 */

import { activateDeclaredPlugins, getActivationState, type PluginActivationDeps } from "./plugin-activation.js";
import { readActiveGeneration } from "../plugin-generations.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";

/** One repository's before/after, as the shim prints it. */
export interface PluginRefreshRow {
  repo: string;
  /** What the declaration asks for: `branch main`, `pin v1.2.0`. */
  ref: string;
  /** Exact commit before the round; null when nothing was live. */
  before: string | null;
  /** Exact commit after; null when the round activated nothing. */
  after: string | null;
  /** `activated` | `unchanged` | `failed` — derived from the two commits + state. */
  status: "activated" | "unchanged" | "failed";
  /** Why it failed, or an advisory (a moved tag a durable pin overrode). */
  detail?: string;
}

export interface PluginRefreshResult {
  rows: PluginRefreshRow[];
  /** Set when the request named a repository the declaration does not have. */
  error?: string;
}

export interface PluginRefreshDeps extends PluginActivationDeps {
  /** The consuming project's identity, for the durable pin store (req 8). */
  consumerKey?: string;
}

/**
 * Refresh one declared repository, or every one of them.
 *
 * Never throws: a failure is a row with `status: "failed"`, because the agent
 * asked a question and deserves an answer about each repository rather than an
 * exception about one.
 */
export async function refreshPluginRepos(
  sessionId: string,
  workspaceDir: string,
  deps: PluginRefreshDeps,
  repoName?: string,
): Promise<PluginRefreshResult> {
  let declared: { name: string; ref: string }[];
  let selfNames: string[];
  let stateDir: string;
  try {
    const config = resolveShipitConfig(workspaceDir);
    stateDir = sessionStateDirForWorkspace(workspaceDir);
    declared = config.plugins.repos
      .filter((r) => r.source.kind === "github")
      .map((r) => ({ name: r.name, ref: r.pin ? `pin ${r.pin}` : `branch ${r.branch ?? "(default)"}` }));
    selfNames = config.plugins.repos.filter((r) => r.source.kind === "self").map((r) => r.name);
  } catch (err) {
    return { rows: [], error: `could not read this project's shipit.yaml: ${message(err)}` };
  }

  const targets = repoName
    ? declared.filter((r) => r.name.toLowerCase() === repoName.toLowerCase())
    : declared;
  if (repoName && targets.length === 0) {
    // A `repo: self` entry IS declared — it just has no generation, because it
    // is this session's own working tree (req 27). Saying "not declared" here
    // would send the reader looking for a typo that is not there.
    if (selfNames.some((n) => n.toLowerCase() === repoName.toLowerCase())) {
      return {
        rows: [],
        error: `\`${repoName}\` is declared as \`repo: self\` — it runs this session's own working tree, `
          + "so it has no version to refresh. Edit the files directly.",
      };
    }
    const known = declared.map((r) => `\`${r.name}\``).join(", ");
    return {
      rows: [],
      error: declared.length > 0
        ? `\`${repoName}\` is not a declared plugin repository. This project declares ${known}.`
        : `\`${repoName}\` is not a declared plugin repository. This project declares none.`,
    };
  }

  const before = new Map(
    targets.map((r) => [r.name, readActiveGeneration(stateDir, r.name)?.commit ?? null]),
  );

  await activateDeclaredPlugins(sessionId, workspaceDir, deps, deps.consumerKey, repoName);

  return {
    rows: targets.map((target) => {
      const after = readActiveGeneration(stateDir, target.name)?.commit ?? null;
      const state = getActivationState(sessionId, target.name);
      const was = before.get(target.name) ?? null;
      // `error` with a live generation is req 15's degraded state — the refresh
      // failed and the prior version is still serving. That is a failure to
      // report, not an "unchanged".
      const status: PluginRefreshRow["status"] = state?.error
        ? "failed"
        : after !== was ? "activated" : "unchanged";
      const detail = state?.error ?? state?.warning;
      return {
        repo: target.name,
        ref: target.ref,
        before: was,
        after,
        status,
        ...(detail ? { detail } : {}),
      };
    }),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
