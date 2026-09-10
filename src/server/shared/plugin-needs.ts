import type { PluginExport, PluginReposConfig, PluginRequirement } from "./plugin-repos.js";

export interface PluginNeedDeclaration {
  repo: string;
  plugin: string;
  alias: string;
  values: PluginRequirement[];
}

function dedupeRequirements(values: readonly PluginRequirement[]): PluginRequirement[] {
  const byName = new Map<string, PluginRequirement>();
  for (const value of values) {
    const prior = byName.get(value.name);
    if (!prior || (prior.optional && !value.optional)) byName.set(value.name, value);
  }
  return [...byName.values()];
}

/** An unreadable manifest reports nothing; it does not mean all needs are satisfied. */
export function declaredPluginNeeds<T extends Pick<PluginExport, "name">>(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => readonly T[] | null,
  pick: (exported: T) => readonly PluginRequirement[],
): PluginNeedDeclaration[] {
  const declarations: PluginNeedDeclaration[] = [];

  for (const repo of plugins.repos) {
    const uses = plugins.uses.filter((u) => u.from.toLowerCase() === repo.name.toLowerCase());
    if (uses.length === 0) continue;

    const manifest = manifestFor(repo.name);
    if (!manifest) continue;

    const byName = new Map(manifest.map((e) => [e.name.toLowerCase(), e]));
    for (const use of uses) {
      const exported = byName.get(use.plugin.toLowerCase());
      if (!exported) continue;

      const values = dedupeRequirements(pick(exported));
      if (values.length === 0) continue;
      declarations.push({
        repo: repo.name,
        plugin: exported.name,
        alias: use.alias,
        values,
      });
    }
  }
  return declarations;
}
