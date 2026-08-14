/**
 * docs/262 — the one walk behind every "what does this plugin declare it
 * needs?" surface: credential names (req 23) and external hosts (req 24).
 *
 * Both requirements ask for the same shape — a name, the plugin that declares
 * it, and whether the consuming project has satisfied it — and req 24 says so
 * in its own words: a session shows unallowed hosts with "the same visibility
 * req 23 gives credentials". What they must never differ on is the four rules
 * below, each of which is a way for a card to state something untrue:
 *
 *  - a repository with no `use:` entry activates nothing, so it declares
 *    nothing;
 *  - a repository whose live manifest cannot be read reports **nothing**,
 *    never "needs nothing" — "not knowable" must not render as satisfied
 *    (req 13);
 *  - a `use:` entry whose selector names no exported plugin is skipped, since
 *    a needs list assembled from a plugin that does not exist is fiction (the
 *    card already says the selector is missing);
 *  - names are de-duplicated in manifest order, and a plugin that declares
 *    none contributes no group at all.
 *
 * Filesystem-free, like its two callers: the client imports the types.
 */

import type { PluginExport, PluginReposConfig } from "./plugin-repos.js";

/** One activated plugin and the names it declares of one kind. */
export interface PluginNeedDeclaration {
  /** Declared repo name (`plugins.repos[].name`) — which card this belongs to. */
  repo: string;
  /** The exported plugin's own name in that repository's manifest. */
  plugin: string;
  /** The consumer's alias — unique across the project, so it keys the group. */
  alias: string;
  /** The declared names, in manifest order, de-duplicated. */
  values: string[];
}

/**
 * Walk every activated plugin and collect what `pick` reads off its export.
 *
 * `manifestFor` returns a repository's live manifest, or `null` when there is
 * none to read yet — a tracked repository that has never activated.
 */
export function declaredPluginNeeds(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => readonly PluginExport[] | null,
  pick: (exported: PluginExport) => readonly string[],
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

      const values = [...new Set(pick(exported))];
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
