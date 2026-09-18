import { activateDeclaredPlugins, type PluginActivationDeps } from "./plugin-activation.js";
import { readActiveGeneration, pluginsRoot } from "../plugin-generations.js";
import { liveInstallProblem } from "./plugin-status.js";
import { readInstallRecord, type PluginInstallRecord } from "../plugin-install-record.js";
import { resolveShipitConfig } from "../../shared/shipit-config.js";
import { destinationKey, declaredRefLabel } from "../../shared/plugin-repos.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";

export interface PluginRefreshRow {
  repo: string;
  ref: string;
  before: string | null;
  after: string | null;
  status: "activated" | "unchanged" | "failed";
  detail?: string;
  /** Problems with the live version, even when this round changed nothing. */
  degraded?: string[];
  /** A rebuild can change the installed generation without changing its commit. */
  reinstalled?: boolean;
  /** Last attempt, which may differ from the live version; includes output for JSON diagnostics. */
  install?: PluginInstallRecord;
}

export interface PluginRefreshResult {
  rows: PluginRefreshRow[];
  error?: string;
}

export interface PluginRefreshDeps extends PluginActivationDeps {
  consumerKey?: string;
}

export async function refreshPluginRepos(
  sessionId: string,
  workspaceDir: string,
  deps: PluginRefreshDeps,
  repoName?: string,
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
  // Match source identity as well as name: declarations can point a name at another repository.
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
      // Shared activation state may already belong to another round.
      const outcome = outcomes.get(target.name);
      const status: PluginRefreshRow["status"] = outcome?.status === "failed"
        ? "failed"
        : after !== was ? "activated" : "unchanged";
      const detail = outcome?.status === "failed" ? outcome.reason : outcome?.warning;
      // One read keeps install output and degradation tied to the same attempt.
      const install = pluginsDir ? readInstallRecord(pluginsDir, target.name) : null;
      const degraded = [
        ...(live?.manifestWarnings ?? []),
        liveInstallProblem(install, after),
      ].filter((d): d is string => typeof d === "string" && d.length > 0);
      const reinstalled = outcome?.status === "activated" && was !== null && was === after;
      return {
        repo: target.name,
        ref: target.ref,
        before: was,
        after,
        status,
        ...(detail ? { detail } : {}),
        ...(degraded.length > 0 ? { degraded } : {}),
        ...(reinstalled ? { reinstalled: true } : {}),
        ...(install ? { install } : {}),
      };
    }),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
