import {
  describeInstallRecord,
  readInstallRecord,
  type PluginInstallRecord,
} from "../plugin-install-record.js";
import { pluginsRoot } from "../plugin-generations.js";
import { sessionStateDirForWorkspace } from "../session-state-dir.js";
import type { PluginRepoStatus } from "../../shared/plugin-repos.js";

export interface PluginStatusRepo {
  repo: string;
  source: string;
  ref: string | null;
  commit: string | null;
  status: PluginRepoStatus;
  issues: string[];
  install: PluginInstallRecord | null;
  installSummary: string;
  /** Installation cost, separate from usability issues. */
  depStoreNotice?: string;
  usable: boolean;
}

export interface PluginStatusResult {
  repos: PluginStatusRepo[];
  warnings: string[];
  error?: string;
}

export function liveInstallProblem(
  record: PluginInstallRecord | null,
  liveCommit: string | null,
): string | null {
  if (!describesLive(record, liveCommit) || !record) return null;
  if (record.outcome !== "failed" && record.outcome !== "not-run") return null;
  return describeInstallRecord(record);
}

// Match the generation: a rejected rebuild of the same commit may have installed differently.
export function liveDepStoreNotice(
  record: PluginInstallRecord | null,
  liveGenerationId: string | null,
): string | null {
  if (!record?.generationId || !liveGenerationId) return null;
  if (record.generationId !== liveGenerationId) return null;
  return record.depStoreReason ?? null;
}

export interface PluginStatusSnapshot {
  repos: {
    name: string;
    source: string;
    ref: string | null;
    commit: string | null;
    status: PluginRepoStatus;
    issues: string[];
    depStoreNotice?: string;
  }[];
  warnings: string[];
}

export function buildPluginStatus(
  workspaceDir: string,
  snapshot: PluginStatusSnapshot,
  repoName?: string,
): PluginStatusResult {
  let pluginsDir: string | null;
  try {
    pluginsDir = pluginsRoot(sessionStateDirForWorkspace(workspaceDir));
  } catch {
    pluginsDir = null;
  }

  const wanted = repoName?.toLowerCase();
  const matched = wanted
    ? snapshot.repos.filter((r) => r.name.toLowerCase() === wanted)
    : snapshot.repos;
  if (wanted && matched.length === 0) {
    const known = snapshot.repos.map((r) => `\`${r.name}\``).join(", ");
    return {
      repos: [],
      warnings: snapshot.warnings,
      error: snapshot.repos.length > 0
        ? `\`${repoName}\` is not a declared plugin repository. This project declares ${known}.`
        : `\`${repoName}\` is not a declared plugin repository. This project declares none.`,
    };
  }

  return {
    warnings: snapshot.warnings,
    repos: matched.map((repo) => {
      // A self declaration must not inherit install records from a previously tracked repository.
      const install = pluginsDir && repo.status !== "self"
        ? readInstallRecord(pluginsDir, repo.name)
        : null;
      return {
        repo: repo.name,
        source: repo.source,
        ref: repo.ref,
        commit: repo.commit,
        status: repo.status,
        issues: repo.issues,
        ...(repo.depStoreNotice ? { depStoreNotice: repo.depStoreNotice } : {}),
        install,
        installSummary: repo.status === "self"
          ? "no install runs under `repo: self` — `agent.install` prepares the working tree"
          : summarize(install, repo.commit),
        usable: isUsable(repo.status, install, repo.commit),
      };
    }),
  };
}

function describesLive(install: PluginInstallRecord | null, liveCommit: string | null): boolean {
  return install !== null && liveCommit !== null && install.commit === liveCommit;
}

function summarize(install: PluginInstallRecord | null, liveCommit: string | null): string {
  const line = describeInstallRecord(install);
  if (!install || describesLive(install, liveCommit)) return line;
  return `${line} (the last attempt was for a different version than the one live)`;
}

// Without a manifest, a missing record cannot distinguish no install from unrecorded installation.
function isUsable(
  status: PluginRepoStatus,
  install: PluginInstallRecord | null,
  liveCommit: string | null,
): boolean {
  if (status === "self") return true;
  if (status !== "active") return false;
  if (!install || !describesLive(install, liveCommit)) return true;
  return install.outcome !== "failed" && install.outcome !== "not-run";
}
