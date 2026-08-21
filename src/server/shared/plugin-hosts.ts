/**
 * docs/262 req 24 — the external hosts each activated plugin declares, resolved
 * against the session's own egress allowlist.
 *
 * A plugin manifest declares `hosts: [fal.run]` "so the user never has to
 * reverse-engineer them from failing calls". The requirement is emphatic about
 * what that declaration is worth: **it grants nothing.** Plugin services and
 * companion CLIs reach exactly what equivalent same-repo code could reach under
 * the session's user-managed egress configuration, and "a plugin declaration
 * never widens a session's network reach by itself".
 *
 * Nothing in this module can widen anything: it takes an `isAllowed` predicate
 * and returns a projection. Adding a host to the allowlist happens on the
 * existing egress routes, which carry no `containerAccessible` flag, so nothing
 * running **in a session container** — a plugin service, a companion CLI, the
 * agent — can call them (`api-container-guard.ts` default-deny, planning#131).
 * This module is only what makes the gap visible enough to act on.
 *
 * **What that boundary does not cover** (planning#370): the orchestrator has no
 * origin or CSRF check and reflects any `Origin` with credentials, so any page
 * the user's browser loads can both call and read `/api/*`. Platform-wide,
 * predating this feature, and not closable by any plugin-local design. Stated
 * here so nothing in this slice is built on the stronger claim.
 *
 * The shape is req 23's, because the requirement asks for it in those words:
 * "the same visibility req 23 gives credentials". So the collector is the same
 * walk (`plugin-needs.ts`), the group is keyed by the same alias, and an
 * unallowed host reads as "`artk` needs `fal.run`" rather than as an anonymous
 * blocked hostname. Filesystem-free, like its neighbours: the client imports
 * these types.
 */

import { declaredPluginNeeds } from "./plugin-needs.js";
import type { PluginExport, PluginReposConfig } from "./plugin-repos.js";
import type { EgressHostReach } from "./types.js";

/** One declared host and what this session's egress configuration says about it. */
export interface PluginHostNeed {
  host: string;
  /**
   * The one verdict every host surface reads (`orchestrator/egress-host-reach.ts`):
   * reachable, closable by a user grant, or closable by nobody the user can be.
   *
   * `grantable` is the "not yet allowed" req 24 asks the session to show — a gap
   * to grant, never a failure, and never something a declaration closed by
   * itself. A `blocked-*` verdict is the gap the requirement's affordance CANNOT
   * close, and the card must state it without a button rather than offer a grant
   * that writes an inert entry (planning#383).
   */
  reach: EgressHostReach;
}

/** What one activated plugin declares, before allowance is known. */
export interface PluginHostDeclaration {
  /** Declared repo name (`plugins.repos[].name`) — which card this belongs to. */
  repo: string;
  /** The exported plugin's own name in that repository's manifest. */
  plugin: string;
  /** The consumer's alias — unique across the project, so it keys the group. */
  alias: string;
  /** Declared hostnames, in manifest order, de-duplicated. */
  hosts: string[];
}

/** {@link PluginHostDeclaration} with each host resolved (req 24). */
export interface PluginHostGroup {
  repo: string;
  plugin: string;
  alias: string;
  hosts: PluginHostNeed[];
}

/**
 * Collect the hosts every activated plugin declares, from the LIVE manifest —
 * so a refresh that adds a host is visible without recreating the session.
 *
 * `manifestFor` returns `null` for a repository with nothing live, and that is
 * reported as nothing rather than as "needs no network": a repository whose
 * version could not be read has not told us what it calls.
 */
export function declaredPluginHosts(
  plugins: PluginReposConfig,
  manifestFor: (repoName: string) => readonly PluginExport[] | null,
): PluginHostDeclaration[] {
  return declaredPluginNeeds(plugins, manifestFor, (e) => e.hosts).map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    hosts: d.values,
  }));
}

/**
 * Resolve declared hosts against what the session may actually reach.
 *
 * `reachOf` is the session's own egress answer — never anything derived from
 * the plugin declaration, which is the whole point of req 24's "grants
 * nothing". It is `orchestrator/egress-host-reach.ts`, the same predicate the
 * grant route and the Tier C decision route read, so this projection cannot
 * report a state the enforcement side disagrees with.
 */
export function resolvePluginHosts(
  declarations: readonly PluginHostDeclaration[],
  reachOf: (host: string) => EgressHostReach,
): PluginHostGroup[] {
  return declarations.map((d) => ({
    repo: d.repo,
    plugin: d.plugin,
    alias: d.alias,
    hosts: d.hosts.map((host) => ({ host, reach: reachOf(host) })),
  }));
}
