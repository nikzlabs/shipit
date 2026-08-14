/**
 * docs/262 — plugin-declared credential NAMES, resolved against the consuming
 * project's own secret store (req 23).
 *
 * A plugin manifest declares `credentials: [FAL_KEY]` — names only, never
 * values. The values live with each consuming project, in the per-repository
 * secret store that project already uses for `x-shipit-secrets`. This module
 * turns "what does each activated plugin declare?" into "which of those names
 * does this project have a value for?", grouped per plugin so a missing key is
 * a named gap on the plugin's own card rather than a flat list nobody can
 * attribute (req 23: "a visible, named gap, never an opaque failure").
 *
 * Filesystem-free, like `plugin-repos.ts`: the client imports these types, so
 * nothing here may pull in `node:fs`. The orchestrator half — reading each
 * repository's live manifest, and reading the project's store — is
 * `orchestrator/plugin-credentials.ts`.
 *
 * **The boundary this module does not decide, and must not undermine** (req
 * 23, last sentence): satisfaction is a pure function of the name set handed
 * in. What keeps ShipIt's own platform credentials — the user's GitHub
 * identity, tracker tokens, agent tokens — out of a plugin's reach is the map
 * that set is computed FROM.
 *
 * {@link satisfiedCredentialNames} is the one rule; there are exactly two
 * callers, and each reads the consuming project's secret store and nothing
 * else. `orchestrator/plugin-credentials.ts`'s
 * `loadSatisfiedPluginCredentialNames` reads `SecretStore` — a parameter type
 * that admits nothing else — keyed by the consuming session's remote, for the
 * Plugins card and the CLI surface. `service-secrets-resolver.ts` applies it to
 * the `secretsLoader` map it has already loaded for the project's own compose
 * services, and then delivers exactly those names to that session's plugin
 * services. Sharing the rule is what makes the card's verdict and the
 * container's environment one answer instead of two.
 */

import type { PluginExport, PluginReposConfig } from "./plugin-repos.js";

/** One declared credential name and whether this project has a value for it. */
export interface PluginCredentialNeed {
  name: string;
  satisfied: boolean;
}

/**
 * What one activated plugin declares, before satisfaction is known. Produced
 * from the repository's LIVE manifest — the generation actually running, so a
 * refresh that adds a credential is reflected without recreating the session.
 */
export interface PluginCredentialDeclaration {
  /** Declared repo name (`plugins.repos[].name`) — which card this belongs to. */
  repo: string;
  /** The exported plugin's own name in that repository's manifest. */
  plugin: string;
  /** The consumer's alias — unique across the project, so it keys the group. */
  alias: string;
  /** Declared credential names, in manifest order, de-duplicated. */
  credentials: string[];
}

/**
 * Which of a store's names actually satisfy a declared credential — the ONE
 * rule, so the card's verdict and what a plugin container receives are the same
 * answer rather than two lookups that agree by convention (req 23).
 *
 * A value counts when it is a non-empty string. An empty string is a name the
 * user started to set and did not, which is the gap req 23 wants named rather
 * than a credential delivered empty. Nothing else is excluded: every delivery
 * surface carries an arbitrary string — a plugin service gets its values in the
 * generated override's `environment`, a companion CLI in the invocation
 * container's `Env` — so a rule that narrowed further would report a working
 * credential as missing.
 */
export function satisfiedCredentialNames(
  values: Readonly<Record<string, unknown>>,
): Set<string> {
  return new Set(
    Object.entries(values)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([name]) => name),
  );
}

/** {@link PluginCredentialDeclaration} with each name resolved (req 23). */
export interface PluginCredentialGroup {
  repo: string;
  plugin: string;
  alias: string;
  credentials: PluginCredentialNeed[];
}

/**
 * Collect the credential names every activated plugin declares.
 *
 * `manifestFor` returns a repository's live manifest, or `null` when there is
 * none to read yet — a tracked repository that has never activated. `null` is
 * deliberately NOT "declares no credentials": the card reports that repository
 * as unavailable, and inventing an empty needs list there would turn a
 * fetch failure into a silent "nothing required" (req 13).
 *
 * A `use` entry whose selector names no exported plugin is skipped for the
 * same reason — the card already says the selector is missing, and a needs
 * list assembled from a plugin that does not exist would be fiction.
 */
export function declaredPluginCredentials(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => readonly PluginExport[] | null,
): PluginCredentialDeclaration[] {
  const declarations: PluginCredentialDeclaration[] = [];

  for (const repo of plugins.repos) {
    const uses = plugins.uses.filter((u) => u.from.toLowerCase() === repo.name.toLowerCase());
    if (uses.length === 0) continue;

    const manifest = manifestFor(repo.name);
    if (!manifest) continue;

    const byName = new Map(manifest.map((e) => [e.name.toLowerCase(), e]));
    for (const use of uses) {
      const exported = byName.get(use.plugin.toLowerCase());
      if (!exported) continue;

      const credentials = [...new Set(exported.credentials)];
      if (credentials.length === 0) continue;
      declarations.push({
        repo: repo.name,
        plugin: exported.name,
        alias: use.alias,
        credentials,
      });
    }
  }
  return declarations;
}

/**
 * Resolve declared names against the project's stored secret names.
 *
 * `satisfiedNames` is the set of names the CONSUMING project has a non-empty
 * value for — see this module's header for why its provenance is the whole
 * security property. Matching is exact: a credential name is an environment
 * variable name, and `fal_key` is not `FAL_KEY` to the process that reads it.
 */
export function resolvePluginCredentials(
  declarations: readonly PluginCredentialDeclaration[],
  satisfiedNames: ReadonlySet<string>,
): PluginCredentialGroup[] {
  return declarations.map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    credentials: d.credentials.map((name) => ({ name, satisfied: satisfiedNames.has(name) })),
  }));
}

/** Every credential name any activated plugin declares, de-duplicated, sorted. */
export function pluginCredentialNames(
  declarations: readonly PluginCredentialDeclaration[],
): string[] {
  return [...new Set(declarations.flatMap((d) => d.credentials))].sort();
}

/**
 * Which plugin aliases claim a given credential name. Feeds the claimant chips
 * on the Secrets settings row: a project credential and a plugin credential of
 * the same name are deliberately the SAME stored secret (plan §3), so one row
 * lists every claimant rather than the name appearing twice.
 */
export function pluginClaimantsOf(
  declarations: readonly PluginCredentialDeclaration[],
  name: string,
): string[] {
  return declarations.filter((d) => d.credentials.includes(name)).map((d) => d.alias).sort();
}
