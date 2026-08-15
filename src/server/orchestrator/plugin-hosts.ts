/**
 * docs/262 req 24 — the orchestrator half of plugin host needs: read what each
 * activated plugin declares. What the session's egress configuration says about
 * a declared host is NOT here: it is one predicate shared with every other host
 * surface, `egress-host-reach.ts`, and that module's docstring is where the
 * reasoning about reachability lives.
 *
 * ## The boundary this module holds
 *
 * Req 24 is two sentences that must both stay true. A plugin **declares** the
 * external hosts its services and CLIs need, "so the user never has to
 * reverse-engineer them from failing calls" — and "the declaration grants
 * nothing: services and companion CLIs reach exactly what equivalent same-repo
 * code could reach under the session's user-managed egress configuration, and
 * a plugin declaration never widens a session's network reach by itself."
 *
 * So this module reads a manifest and writes nothing, and the answer beside each
 * host comes from an egress seam that has never heard of plugins. Granting is
 * elsewhere and is a deliberate user act on the browser-only egress routes.
 *
 * ## What the report covers
 *
 * All three execution surfaces are bound by the allowlist that predicate reads:
 * plugin **services** through docs/263's `containComposeServices`, and the
 * **companion-CLI invocation** and **install** containers through
 * `plugin-egress.ts`, which builds each one a namespace carrying the Tier A/B/C
 * stack from the same `resolveEgress` answer. (Those two used to join a plain
 * NAT bridge with nothing installed — a gap in req 24's enforcement half that
 * this report was careful not to claim was closed. It is closed now.)
 *
 * The card therefore says a host is not in the session's egress allowlist, not
 * that a call was blocked; the instance-scope button says when it takes effect;
 * and where no button could work, the card says that instead of offering one.
 */

import { declaredPluginHosts, type PluginHostDeclaration } from "../shared/plugin-hosts.js";
import type { PluginExport, PluginReposConfig } from "../shared/plugin-repos.js";
import { liveManifestReader } from "./plugin-credentials.js";
import type { LiveGenerations } from "./plugin-generations.js";

/**
 * What every activated plugin of this session declares it must reach (req 24).
 *
 * Shares `liveManifestReader` with the credential collector rather than
 * resolving generations again: both answer for the same card, out of the same
 * already-verified `{dir, record}` handle (docs/262 resolve-once), so a refresh
 * landing mid-request cannot give one need list a different generation from the
 * other.
 *
 * Never throws — a repository whose manifest cannot be read contributes
 * nothing, and the card reports that repository's state through its own path.
 */
export function pluginHostDeclarationsFor(
  plugins: PluginReposConfig,
  selfExports: readonly PluginExport[],
  live: LiveGenerations,
): PluginHostDeclaration[] {
  try {
    return declaredPluginHosts(plugins, liveManifestReader(plugins.repos, selfExports, live));
  } catch {
    return [];
  }
}

