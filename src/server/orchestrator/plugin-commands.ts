/**
 * docs/262 req 20 — the orchestrator's half of the companion-CLI naming domain:
 * report, on the Plugins tab's card, every command a session refuses to
 * surface and how to fix it.
 *
 * The plan itself is pure (`shared/plugin-cli.ts`); this only feeds it the two
 * things it needs from disk — which repository each `use:` entry names, and
 * that repository's live manifest — through the resolver `plugin-state.ts`
 * already owns.
 *
 * **Recomputed, never remembered**, exactly like `pluginSettingsIssuesByRepo`
 * beside it: the snapshot GET must be able to say "this declaration cannot
 * work" before any round has run, and it must activate nothing to say it.
 *
 * What it deliberately does NOT know is the agent container's PATH. A wrapper
 * that would shadow a real program is refused where PATH is real
 * (`session/plugin-cli.ts`); here only the cross-plugin collisions and the
 * reserved names are knowable, which is the earliest phase that can know them
 * (plan §1a).
 */

import { planPluginCommands } from "../shared/plugin-cli.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { createPluginImportResolver } from "./plugin-state.js";

/**
 * Command refusals for one session, grouped by declared repository name.
 *
 * Empty for a project that declares no plugins, and empty for one whose
 * repositories have not been fetched yet — an import with no manifest surfaces
 * no commands, so it can collide with nothing.
 */
export function pluginCommandIssuesByRepo(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  stateDir: string,
): Map<string, string[]> {
  const resolver = createPluginImportResolver(plugins, selfExports, stateDir);
  return planPluginCommands(plugins.uses, (use) => ({
    repo: resolver.repoNameFor(use),
    exported: resolver.exportFor(use),
  })).issues;
}
