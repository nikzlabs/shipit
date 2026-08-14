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
 * So this module reads two things and writes nothing. {@link
 * pluginHostAllowance} composes its answer from the very same inputs the
 * Settings → Network egress editor renders (`buildEffectiveAllowlist`) plus
 * the live allow-once policy the Tier C proxy consults (`egress-policy.ts`) —
 * never from the manifest. Granting is elsewhere and is a deliberate user act:
 * `POST /api/egress/hosts`, which carries no `containerAccessible` flag, so
 * plugin code cannot self-grant (planning#131's default-deny).
 *
 * ## Why containment gates the whole answer
 *
 * "Not yet allowed" is only a fact about a session whose egress is contained.
 * An Open session — or a deployment with no egress enforcement — reaches every
 * host, and reporting a declared host as blocked there would send the user to
 * grant something that was never denied. `ContainerSessionManager.
 * isEgressContained` is the one honest answer to "is this session contained
 * right now?": it folds in whether enforcement is deployed at all and what the
 * LIVE container was started with, and the plugin-repos route already computes
 * it for the compose-validation rule set. The same value gates this.
 *
 * ## What this cannot see, stated rather than left implied
 *
 * Allowance is evaluated against the session's allowlist — the one the agent
 * container and (since docs/263) every contained Compose service share, plugin
 * services included, because they take the same `containComposeServices` path.
 * A companion-CLI **invocation** container does not: it joins its own
 * `shipit-plugin-cli` bridge (`plugin-container.ts`) with no firewall,
 * resolver or proxy installed, so it is not contained by this allowlist at
 * all. That is a gap in req 24's enforcement half, not in this report; the row
 * therefore names the plugin that declared the host and what the session's
 * allowlist says, and does not claim a call was blocked.
 */

import { buildEffectiveAllowlist, hostMatchesEntry, normalizeHost } from "./egress-allowlist.js";
import { EGRESS_GLOBAL_SCOPE } from "./egress-allowlist-store.js";
import type { EgressAllowlistStore } from "./egress-allowlist-store.js";
import { isEgressHostAllowed } from "./egress-policy.js";
import type { CredentialStore } from "./credential-store.js";
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
  /** The durable user allowlist (global + per-session). Absent in runtimes with no egress wiring. */
  store?: EgressAllowlistStore | undefined;
  /** Live MCP server hosts — reachable, so a plugin declaring one is not blocked. */
  credentialStore?: CredentialStore | undefined;
  sessionId?: string | undefined;
  /**
   * Whether this session's egress is contained right now
   * (`ContainerSessionManager.isEgressContained`). False means nothing is
   * denied, so nothing is "not yet allowed".
   */
  contained: boolean;
}

/**
 * The predicate {@link import("../shared/plugin-hosts.js").resolvePluginHosts}
 * resolves declared hosts against.
 *
 * Composed from exactly what a contained session can reach:
 *
 *  - the **effective allowlist** — built-in defaults minus the ones the user
 *    removed, operator extras (`SESSION_EGRESS_ALLOWLIST`), live MCP hosts,
 *    and the durable global + per-session user entries. This is the static set
 *    the resolver pins and the proxy splices, and the same view the Settings
 *    editor shows, so the card and that editor cannot disagree.
 *  - the **allow-once policy** for this session, which is what the proxy's own
 *    decision endpoint answers with for a host outside that static set. A host
 *    the user approved on an inline card is reachable, and a plugin row
 *    claiming otherwise would offer to grant something already granted.
 *
 * Fails closed on an unreadable store, for the reason
 * `loadSatisfiedPluginCredentialNames` does: "not knowable" must render as the
 * visible gap req 24 asks for, never as satisfied. The cost of being wrong
 * that way is one redundant, idempotent grant; the cost of the other way is a
 * plugin that fails at runtime with the card saying nothing.
 */
export function pluginHostAllowance(
  input: PluginHostAllowanceInput,
): (host: string) => boolean {
  // An Open session (or a deployment that does not enforce containment) denies
  // nothing, so there is no gap to show and nothing to grant.
  if (!input.contained) return () => true;

  const sessionId = input.sessionId;
  let entries: string[];
  try {
    entries = buildEffectiveAllowlist({
      ...(input.credentialStore ? { credentialStore: input.credentialStore } : {}),
      globalHosts: input.store?.listHosts(EGRESS_GLOBAL_SCOPE) ?? [],
      sessionHosts: input.store && sessionId ? input.store.listHosts(sessionId) : [],
      suppressedDefaults: input.store?.listSuppressedDefaults() ?? [],
    }).map((e) => e.host);
  } catch {
    entries = [];
  }

  return (host: string): boolean => {
    const h = normalizeHost(host);
    if (!h) return false;
    if (entries.some((entry) => hostMatchesEntry(h, entry))) return true;
    return sessionId ? isEgressHostAllowed(sessionId, h) : false;
  };
}
