import { declaredPluginNeeds } from "./plugin-needs.js";
import type { PluginExport, PluginReposConfig, PluginRequirement } from "./plugin-repos.js";
import type { EgressHostReach } from "./types.js";

export interface PluginHostNeed {
  host: string;
  optional: boolean;
  reach: EgressHostReach;
}

export interface PluginHostDeclaration {
  repo: string;
  plugin: string;
  alias: string;
  hosts: PluginRequirement[];
}

export type DeclaredHostsManifest = readonly Pick<PluginExport, "name" | "hosts">[];

export interface PluginHostGroup {
  repo: string;
  plugin: string;
  alias: string;
  hosts: PluginHostNeed[];
}

export function declaredPluginHosts(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => DeclaredHostsManifest | null,
): PluginHostDeclaration[] {
  return declaredPluginNeeds(plugins, manifestFor, (e) => e.hosts).map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    hosts: d.values,
  }));
}

/** Declarations grant no access; reachOf must use the session's egress policy. */
export function resolvePluginHosts(
  declarations: readonly PluginHostDeclaration[],
  reachOf: (host: string) => EgressHostReach,
): PluginHostGroup[] {
  return declarations.map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    hosts: d.hosts.map((h) => ({ host: h.name, reach: reachOf(h.name), optional: h.optional })),
  }));
}
