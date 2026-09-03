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

import {
  declaredPluginHosts,
  type DeclaredHostsManifest,
  type PluginHostDeclaration,
} from "../shared/plugin-hosts.js";
import type { PluginExport, PluginReposConfig, PluginRequirement } from "../shared/plugin-repos.js";
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
 * `attemptedFor` adds the version the last activation TRIED, and is the half
 * that makes the requirement's affordance reachable at all. Two states have a
 * declared host and no live manifest carrying it:
 *
 *  - a FIRST activation whose install was denied the network it declared —
 *    nothing was ever published, so the live reader answers `null` and the card
 *    rendered no host rows at all, while the install failure told the user to
 *    press the buttons that were missing;
 *  - a REFRESH that adds a host and then fails — the live manifest is the OLD
 *    commit's, which does not name it.
 *
 * The two versions are UNIONED rather than one replacing the other, because both
 * are true at once in the second case: the live version's hosts are what the
 * session is running on, and the attempted version's are what it will need when
 * the refresh succeeds. Reporting a host is still not granting it (see this
 * module's header) — reach is resolved per host by the caller's seam, so an
 * attempted version can no more widen a session than a live one can.
 *
 * Never throws — a repository whose manifest cannot be read contributes
 * nothing, and the card reports that repository's state through its own path.
 */
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

/**
 * One export list per plugin name, carrying every host either version declares.
 *
 * `null` — "not knowable" — only when BOTH sides are null, which req 13 requires
 * to stay distinct from "declares nothing": a repository nobody could read has
 * not said it needs no network.
 */
function mergeDeclaredHosts(
  live: DeclaredHostsManifest | null,
  attempted: DeclaredHostsManifest | null,
): DeclaredHostsManifest | null {
  if (!attempted) return live;
  if (!live) return attempted;
  const byName = new Map<string, { name: string; hosts: PluginRequirement[] }>();
  // Live first, so the name a card shows is the running version's spelling and
  // its hosts keep manifest order; the walk de-duplicates the values itself —
  // including the case where the two versions disagree about whether a host is
  // optional, which it settles as REQUIRED (`plugin-needs.ts`).
  for (const e of [...live, ...attempted]) {
    const existing = byName.get(e.name.toLowerCase());
    if (existing) existing.hosts.push(...e.hosts);
    else byName.set(e.name.toLowerCase(), { name: e.name, hosts: [...e.hosts] });
  }
  return [...byName.values()];
}

