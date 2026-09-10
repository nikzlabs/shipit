import {
  declaredPluginHosts,
  type DeclaredHostsManifest,
  type PluginHostDeclaration,
} from "../shared/plugin-hosts.js";
import type { PluginExport, PluginReposConfig, PluginRequirement } from "../shared/plugin-repos.js";
import { liveManifestReader } from "./plugin-credentials.js";
import type { LiveGenerations } from "./plugin-generations.js";

// Failed installs can declare hosts absent from the live version. Report both;
// declarations do not grant network access.
export function pluginHostDeclarationsFor(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
  attemptedFor: (repoName: string) => DeclaredHostsManifest | null = () => null,
): PluginHostDeclaration[] {
  try {
    const liveFor = liveManifestReader(plugins.repos, selfExports, live);
    return declaredPluginHosts(plugins, (repoName) =>
      mergeDeclaredHosts(liveFor(repoName), attemptedFor(repoName)),
    );
  } catch {
    return [];
  }
}

function mergeDeclaredHosts(
  live: DeclaredHostsManifest | null,
  attempted: DeclaredHostsManifest | null,
): DeclaredHostsManifest | null {
  if (!attempted) return live;
  if (!live) return attempted;
  const byName = new Map<string, { name: string; hosts: PluginRequirement[] }>();
  // Preserve the live spelling and order; declaredPluginHosts deduplicates hosts.
  for (const e of [...live, ...attempted]) {
    const existing = byName.get(e.name.toLowerCase());
    if (existing) existing.hosts.push(...e.hosts);
    else byName.set(e.name.toLowerCase(), { name: e.name, hosts: [...e.hosts] });
  }
  return [...byName.values()];
}
