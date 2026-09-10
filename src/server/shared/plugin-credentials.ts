import { declaredPluginNeeds } from "./plugin-needs.js";
import type { PluginExport, PluginReposConfig, PluginRequirement } from "./plugin-repos.js";

export interface PluginCredentialNeed {
  name: string;
  satisfied: boolean;
  optional: boolean;
}

export interface PluginCredentialDeclaration {
  repo: string;
  plugin: string;
  alias: string;
  credentials: PluginRequirement[];
}

/** Read only the consuming project's secret store, never platform credentials. */
export function satisfiedCredentialNames(
  values: Readonly<Record<string, unknown>>,
): Set<string> {
  return new Set(
    Object.entries(values)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([name]) => name),
  );
}

export interface PluginCredentialGroup {
  repo: string;
  plugin: string;
  alias: string;
  credentials: PluginCredentialNeed[];
}

export function declaredPluginCredentials(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => readonly PluginExport[] | null,
): PluginCredentialDeclaration[] {
  return declaredPluginNeeds(plugins, manifestFor, (e) => e.credentials).map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    credentials: d.values,
  }));
}

export function resolvePluginCredentials(
  declarations: readonly PluginCredentialDeclaration[],
  satisfiedNames: ReadonlySet<string>,
): PluginCredentialGroup[] {
  return declarations.map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    credentials: d.credentials.map((c) => ({
      name: c.name,
      satisfied: satisfiedNames.has(c.name),
      optional: c.optional,
    })),
  }));
}

export function pluginCredentialNames(
  declarations: readonly PluginCredentialDeclaration[],
): string[] {
  return [...new Set(declarations.flatMap((d) => d.credentials.map((c) => c.name)))].sort();
}

export function pluginClaimantsOf(
  declarations: readonly PluginCredentialDeclaration[],
  name: string,
): string[] {
  return declarations
    .filter((d) => d.credentials.some((c) => c.name === name))
    .map((d) => d.alias)
    .sort();
}

export function pluginRequiresName(
  declarations: readonly PluginCredentialDeclaration[],
  name: string,
): boolean {
  return declarations.some((d) => d.credentials.some((c) => c.name === name && !c.optional));
}
