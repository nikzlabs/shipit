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
 * actually run. The FAILURE half comes from this round's own returned outcome
 * rather than the shared activation-state map — that map belongs to the UI and
 * is owned by whichever round finishes last (review finding).
 */

import { activateDeclaredPlugins, type PluginActivationDeps } from "./plugin-activation.js";
import { readActiveGeneration, pluginsRoot } from "../plugin-generations.js";
import { liveInstallProblem } from "./plugin-status.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { destinationKey, declaredRefLabel } from "../../shared/plugin-repos.js";
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
  /**
   * docs/266 req 7 — why the version that is now live is not usable, when it is
   * not. Separate from `detail`, which is about THIS round: the condition this
   * carries is durable state that the round may have had nothing to do with,
   * and a refresh that correctly found nothing to do must still say it.
   */
  degraded?: string[];
  /**
   * docs/266 reqs 5, 6 — this round re-installed the version that was already
   * live (`--force`). It needs its own field because `status` answers "did the
   * live commit change", and for a forced re-install the honest answer to that
   * is no: before and after are the same commit, and reporting `unchanged`
   * would tell a consumer their retry did nothing.
   */
  reinstalled?: boolean;
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
  /**
   * docs/266 reqs 5, 6 — re-stage and re-install the version already live.
   * Refused without `repoName`, here rather than only in the shim: this is the
   * boundary every caller crosses, and discarding a live version's writable
   * layer for every declared repository at once is not something to make
   * reachable by omitting an argument.
   */
  force?: boolean,
): Promise<PluginRefreshResult> {
  if (force && !repoName) {
    return {
      rows: [],
      error: "`--force` needs the name of one plugin repository. It re-runs that repository's "
        + "install over the version already live, discarding what the last install left, so it is "
        + "never applied to every declared repository at once.",
    };
  }
  // `source` rides along because a generation is only THIS declaration's when it
  // was built from the repository the declaration currently names — the name
  // alone is re-pointable (`plugin-generations.ts`).
  let declared: { name: string; ref: string; source: string }[];
  let selfNames: string[];
  let stateDir: string;
  try {
    const config = resolveShipitConfig(workspaceDir);
    stateDir = sessionStateDirForWorkspace(workspaceDir);
    declared = config.plugins.repos
      .filter((r) => r.source.kind === "github")
      .map((r) => ({
        name: r.name,
        ref: declaredRefLabel(r),
        source: destinationKey(r.source),
      }));
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
    targets.map((r) => [r.name, readActiveGeneration(stateDir, r.name, r.source)?.commit ?? null]),
  );
  // Resolved once, and tolerated as absent: a session layout with no resolvable
  // state dir still gets its rows, minus the install half of the report.
  let pluginsDir: string | null = null;
  try {
    pluginsDir = pluginsRoot(stateDir);
  } catch {
    pluginsDir = null;
  }

  const outcomes = await activateDeclaredPlugins(
    sessionId, workspaceDir, deps, deps.consumerKey, repoName, force,
  );

  return {
    rows: targets.map((target) => {
      const live = readActiveGeneration(stateDir, target.name, target.source);
      const after = live?.commit ?? null;
      const was = before.get(target.name) ?? null;
      // THIS round's own outcome, not the shared "latest attempt" state. That
      // map is the UI's, and whichever round finishes last owns it — so with a
      // second trigger queued it could already read `activating: true`, and a
      // refresh whose install had just failed reported `unchanged` and exited
      // zero (review finding). A round with no outcome for this repository ran
      // nothing for it, which is not a failure to report.
      const outcome = outcomes.get(target.name);
      const status: PluginRefreshRow["status"] = outcome?.status === "failed"
        ? "failed"
        : after !== was ? "activated" : "unchanged";
      const detail = outcome?.status === "failed" ? outcome.reason : outcome?.warning;
      // docs/266 req 7 — the live version's OWN problems, read off the record
      // that is live now rather than off this round. A round that found nothing
      // to do is the case this exists for: it exited 0 and said `unchanged`
      // while every surface of that plugin was failing, and a consumer had no
      // way to see the sentence the Plugins card was already showing.
      // Two sources, because they cover different failures: the generation's own
      // warnings carry "active but not installed", and the durable install
      // record carries a FAILED install for the version that is live — which no
      // generation can carry, because the round that failed published none.
      // Reading only the first left a plain refresh silent after a failed forced
      // retry (review finding).
      const degraded = [
        ...(live?.manifestWarnings ?? []),
        ...(pluginsDir ? [liveInstallProblem(pluginsDir, target.name, after)] : []),
      ].filter((d): d is string => typeof d === "string" && d.length > 0);
      // A forced round that reached `activated` re-staged and re-installed the
      // same commit. The outcome is needed as well as the two commits: for a
      // re-install they are identical by construction, so `after !== was`
      // cannot see it. And both halves are needed — `--force` on a repository
      // with NOTHING live is an ordinary first activation, which must read
      // `none → <commit>` rather than claiming it re-installed something that
      // was never there.
      const reinstalled = force === true
        && outcome?.status === "activated"
        && was !== null
        && was === after;
      return {
        repo: target.name,
        ref: target.ref,
        before: was,
        after,
        status,
        ...(detail ? { detail } : {}),
        ...(degraded.length > 0 ? { degraded } : {}),
        ...(reinstalled ? { reinstalled: true } : {}),
      };
    }),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
