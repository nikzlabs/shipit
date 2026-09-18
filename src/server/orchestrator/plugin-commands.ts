import { planPluginCommands } from "../shared/plugin-cli.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { createPluginImportResolver } from "./plugin-state.js";
import type { LiveGenerations } from "./plugin-generations.js";

export function pluginCommandIssuesByRepo(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): Map<string, string[]> {
  const resolver = createPluginImportResolver(plugins, selfExports, live);
  return planPluginCommands(plugins.uses, (use) => ({
    repo: resolver.repoNameFor(use),
    exported: resolver.exportFor(use),
  })).issues;
}
