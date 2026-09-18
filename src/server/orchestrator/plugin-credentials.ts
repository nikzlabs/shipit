import type { DeclaredPluginRepo, PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";

import {
  declaredPluginCredentials,
  satisfiedCredentialNames,
  type PluginCredentialDeclaration,
} from "../shared/plugin-credentials.js";
import { resolveShipitConfig } from "../shared/shipit-config.js";
import {
  readGenerationManifestAt,
  resolveLiveGenerations,
  type LiveGenerations,
} from "./plugin-generations.js";
import { sessionStateDirForWorkspace } from "./session-state-dir.js";
import type { SecretStore } from "./secret-store.js";

export function collectPluginCredentialDeclarations(
  workspaceDir: string,
): PluginCredentialDeclaration[] {
  try {
    const config = resolveShipitConfig(workspaceDir);
    return pluginCredentialDeclarationsFor(
      config.plugins,
      config.pluginExports,
      resolveLiveGenerations(sessionStateDirForWorkspace(workspaceDir), config.plugins.repos),
    );
  } catch {
    return [];
  }
}

export function pluginCredentialDeclarationsFor(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): PluginCredentialDeclaration[] {
  try {
    return declaredPluginCredentials(
      plugins,
      liveManifestReader(plugins.repos, selfExports, live),
    );
  } catch {
    return [];
  }
}

export function liveManifestReader(
  repos: readonly DeclaredPluginRepo[],
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): (repoName: string) => readonly PluginExport[] | null {
  const byName = new Map(repos.map((r) => [r.name.toLowerCase(), r]));

  return (repoName: string) => {
    const repo = byName.get(repoName.toLowerCase());
    if (!repo) return null;
    if (repo.source.kind === "self") return selfExports;
    const verified = live(repo);
    return verified ? readGenerationManifestAt(verified.dir) : null;
  };
}

// Read only the consuming project's SecretStore; never ShipIt's platform CredentialStore.
export function loadSatisfiedPluginCredentialNames(
  secretStore: Pick<SecretStore, "loadSecrets"> | undefined,
  consumerRemoteUrl: string | null | undefined,
): Set<string> {
  if (!secretStore || !consumerRemoteUrl) return new Set();
  try {
    return satisfiedCredentialNames(secretStore.loadSecrets(consumerRemoteUrl));
  } catch {
    return new Set();
  }
}
