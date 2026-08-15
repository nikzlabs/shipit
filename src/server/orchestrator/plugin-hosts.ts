/**
 * docs/262 req 24 — the orchestrator half of plugin host needs: read what each
 * activated plugin declares, and read what this session's egress configuration
 * actually permits.
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
 * So this module reads two things and writes nothing. Granting is elsewhere and
 * is a deliberate user act on the browser-only egress routes.
 *
 * ## The allowance comes from the seam that configures enforcement
 *
 * {@link pluginHostAllowance} answers from the session's own
 * `ResolvedEgressConfig` — the exact `base` + `extraHosts` pair the Tier B
 * resolver and the Tier C SNI proxy are launched with
 * (`buildProxyAllowed`) — plus the allow-once policy, which is what the
 * proxy's decision endpoint answers with for a host outside that static set.
 *
 * Re-deriving that composition from the allowlist store instead is the thing
 * NOT to do, and the first review of this slice caught why: a docs/211 sandbox
 * with `network` OFF runs on the lifeline base with an EMPTY extras list, so a
 * store-derived answer reported hosts as reachable that that session cannot
 * reach at all. One seam, one answer.
 *
 * That holds for the allow-once layer too, and planning#380 is the half that was
 * missed: this predicate used to finish with `isEgressHostAllowed`, which is the
 * DECISION point's answer and folds the durable allowlist back in. So the store
 * re-entered through the layer meant to add only the user's live decisions, and
 * the sandbox reported a durably-added host as allowed while its own resolver
 * had never heard of it — the one direction that misleads, since the user's next
 * move is to debug a plugin whose network really is the problem. The narrow
 * {@link isEgressAllowOnceHost} is the layer that is true of any session: it is
 * the set `plugin-egress.ts` snapshots into the container it launches.
 *
 * Containment itself is asked separately, of `isEgressContained`: that is the
 * boot-effective truth (does this deployment enforce at all, and what did the
 * LIVE container start with), where the config's own `contained` is only the
 * policy. An Open session denies nothing, so nothing there is "not yet
 * allowed" — naming a gap would send the user to grant what was never blocked.
 *
 * ## What this report covers, and where it is still narrower than it looks
 *
 * All three execution surfaces are now bound by the allowlist this reads:
 * plugin **services** through docs/263's `containComposeServices`, and the
 * **companion-CLI invocation** and **install** containers through
 * `plugin-egress.ts`, which builds each one a namespace carrying the Tier A/B/C
 * stack from this same `resolveEgress` answer. (Those two used to join a plain
 * NAT bridge with nothing installed — a gap in req 24's enforcement half that
 * this report was careful not to claim was closed. It is closed now.)
 *
 * Two divergences between "the configuration permits it" and "the call will
 * succeed" remain, recorded because the honest report is narrower than it looks:
 *
 *  - An **instance-scoped** grant applies to the running resolver and proxy
 *    only at the next container start (`api-routes-egress.ts` reloads for a
 *    session-scoped add alone), though the proxy's decision endpoint honours it
 *    live for a host outside the static set. Plugin CLI and install containers
 *    are built per call, so for them "the next container start" is the next
 *    invocation.
 *  - An **allow-once** decision taken WHILE a plugin CLI or install is running
 *    does not reach it: that container's proxy has no decision endpoint to ask
 *    (its network is denied ShipIt's API by req 19), so the allow-once set is
 *    snapshotted into its static allowlist at launch. The next invocation has
 *    it. The agent's own proxy, which can ask, is unaffected.
 *  - **A Tier A-only deployment (`SESSION_EGRESS_DNS=0`) permits far less than
 *    this reports**, and the gap is not the sandbox's: with no resolver and no
 *    proxy, `preparePluginNetns` installs the fixed Tier A IP floor alone, so a
 *    host outside `EGRESS_TIER_A_RESOLVE_HOSTS` is blocked at the ipset however
 *    the allowlist reads — for every session, not only a narrowed one. Left
 *    reported-as-allowed deliberately: the honest row there is not "not yet
 *    allowed" but "this deployment cannot allow it", and the card's grant button
 *    could not close it. Naming the state properly is a surface of its own.
 *  - **Identity rules are a within-host allowance this predicate does not
 *    model.** `ResolvedEgressConfig.identityRules` reaches the plugin proxy
 *    (`plugin-egress.ts`) and can refuse a tenant on a host whose ENTRY is
 *    allowed. The question this predicate answers — is the host in the session's
 *    allowlist — stays correctly answered; the tenant half is not a host fact,
 *    and rendering it as one would report a gap no host grant can close.
 *
 * The card therefore says a host is not in the session's egress allowlist, not
 * that a call was blocked, and the instance-scope button says when it takes
 * effect.
 */

import {
  EGRESS_DEFAULT_ALLOWLIST,
  hostMatchesEntry,
  normalizeHost,
  type ResolvedEgressConfig,
} from "./egress-allowlist.js";
import { isEgressAllowOnceHost } from "./egress-policy.js";
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

export interface PluginHostAllowanceInput {
  /**
   * Whether this session's egress is contained right now
   * (`ContainerSessionManager.isEgressContained`). False means nothing is
   * denied, so nothing is "not yet allowed".
   */
  contained: boolean;
  /**
   * The session's resolved egress config
   * (`ContainerSessionManager.resolveEgress`) — the same `base` + `extraHosts`
   * the proxy is launched with. Absent in a runtime with no resolver wired.
   */
  config?: ResolvedEgressConfig | undefined;
  /**
   * Scopes the allow-once lookup; without it that layer is simply not counted.
   * It scopes the IN-MEMORY decisions only — never the durable allowlist, whose
   * hosts reach this predicate through `config.extraHosts` or not at all
   * (planning#380).
   */
  sessionId?: string | undefined;
}

/**
 * The predicate {@link import("../shared/plugin-hosts.js").resolvePluginHosts}
 * resolves declared hosts against — never anything derived from the manifest,
 * which is the whole point of req 24's "grants nothing".
 *
 * Fails closed on a contained session with no resolved config, for the reason
 * `loadSatisfiedPluginCredentialNames` does: "not knowable" must render as the
 * visible gap req 24 asks for, never as satisfied. The cost of being wrong that
 * way is one redundant, idempotent grant; the cost of the other way is a plugin
 * that fails at runtime with the card saying nothing.
 */
export function pluginHostAllowance(
  input: PluginHostAllowanceInput,
): (host: string) => boolean {
  if (!input.contained) return () => true;

  const sessionId = input.sessionId;
  // Exactly `buildProxyAllowed`'s composition. `base` is omitted by a config
  // that means "the full default list"; a Network-off sandbox narrows it, and a
  // user who removed a built-in default has it removed here too.
  const entries = input.config
    ? [...(input.config.base ?? EGRESS_DEFAULT_ALLOWLIST), ...input.config.extraHosts].map(normalizeHost)
    : [];

  // A session that admits no user hosts has no allow-once layer to count either:
  // the decision route never cards it, and `pluginEgressPolicy` hands its plugin
  // containers an empty allow-once set, so the entries above are the whole answer.
  const allowOnce = sessionId && !input.config?.userHostsExcluded ? sessionId : null;

  return (host: string): boolean => {
    const h = normalizeHost(host);
    if (!h) return false;
    if (entries.some((entry) => hostMatchesEntry(h, entry))) return true;
    // The in-memory allow-once set ONLY. `isEgressHostAllowed` would re-admit
    // the durable store here and undo the composition above (planning#380).
    return allowOnce ? isEgressAllowOnceHost(allowOnce, h) : false;
  };
}
