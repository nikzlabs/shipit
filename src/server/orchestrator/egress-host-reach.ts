/**
 * **Can this host be made reachable at all, and by whom?** — the one predicate
 * every surface that reports on a host asks (planning#383, docs/262 req 24).
 *
 * ## Why there is exactly one
 *
 * Three defects came out of req 24's single demand that enforcement and the
 * Plugins card must not disagree. They differed only in what the reporting side
 * was optimistic ABOUT:
 *
 *  - **planning#377** — optimistic about a compose file: reported "could not
 *    read" for a file it had read and deliberately refused.
 *  - **planning#380** — optimistic about a session: called a durably-added host
 *    allowed in a Network-off sandbox, where its own resolver never heard of it.
 *  - **planning#383** — optimistic about a deployment: offered "Allow for
 *    session" / "Allow for ShipIt" on an install where no grant can ever work,
 *    so both buttons wrote a durable entry that changed nothing.
 *
 * Each was found by a different route and none by the tests. A fourth
 * special case beside the other three would have been the same bug again, so the
 * question itself is consolidated here: not "is this host in the allowlist" but
 * "what, if anything, would make it reachable — and is that a user act at all?".
 * The verdict vocabulary is {@link EgressHostReach}; a `blocked-*` answer is the
 * one thing a grant button may never sit on.
 *
 * ## The answer comes from the seams that configure enforcement
 *
 * Nothing here re-derives a composition from the allowlist store. The inputs are
 * the very values a session's sidecars are launched with:
 *
 *  - `contained` — `ContainerSessionManager.isEgressContained`: whether this
 *    deployment enforces at all AND what the live container actually started
 *    with. False means nothing is denied, so nothing is "not yet allowed".
 *  - `dnsControlDeployed` — `egressDnsEnabled()`: whether Tier B exists on this
 *    deployment. This is the planning#383 axis and it is deployment-wide, not
 *    per session.
 *  - `config` — `ContainerSessionManager.resolveEgress`: the exact
 *    `base` + `extraHosts` pair `buildProxyAllowed` hands the resolver and the
 *    SNI proxy. Re-deriving it from the store instead is the thing NOT to do: a
 *    docs/211 sandbox with `network` OFF runs on the lifeline base with an
 *    EMPTY extras list, so a store-derived answer reports hosts as reachable
 *    that that session cannot reach at all.
 *  - `sessionId` — scopes the IN-MEMORY allow-once layer, which is what the
 *    proxy's decision endpoint answers with for a host outside the static set,
 *    and what `plugin-egress.ts` snapshots into a plugin container. Never the
 *    durable allowlist: those hosts arrive through `config.extraHosts` or not at
 *    all, and folding them back in is exactly how planning#380 happened.
 *
 * ## Where the answer is still narrower than it looks
 *
 * **Identity rules are a within-host allowance this predicate does not model**
 * (#2292). `ResolvedEgressConfig.identityRules` reaches the plugin proxy and can
 * refuse a tenant on a host whose ENTRY is allowed. The question here — is the
 * host in this session's allowlist, and who could put it there — stays correctly
 * answered; the tenant half is not a host fact, and rendering it as one would
 * report a gap no host grant can close.
 *
 * Two timing divergences between "the configuration permits it" and "the call
 * will succeed" also remain, and both are reported by the grant outcome
 * (`egress-grant-outcome.ts`) rather than by this verdict: an instance-scoped
 * grant reaches a running agent only at its next container start, and an
 * allow-once decision taken WHILE a plugin CLI or install container is running
 * does not reach that container (its proxy has no decision endpoint to ask).
 */

import {
  EGRESS_DEFAULT_ALLOWLIST,
  hostMatchesEntry,
  normalizeHost,
  type ResolvedEgressConfig,
} from "./egress-allowlist.js";
import { EGRESS_TIER_A_RESOLVE_HOSTS } from "./egress-firewall.js";
import { isEgressAllowOnceHost } from "./egress-policy.js";
import type { EgressHostReach } from "../shared/types.js";

export interface EgressHostReachInput {
  /**
   * Whether egress is contained for the subject of the question. The Plugins
   * card asks the boot-effective `isEgressContained` (what the live container
   * runs on); the grant route asks the resolved policy, because the entry it is
   * reporting on outlives the running container. Each caller states which
   * containment its answer is about — the predicate does not guess.
   */
  contained: boolean;
  /**
   * Does this DEPLOYMENT install the Tier B controlled resolver at all
   * (`egressDnsEnabled()`)? False — `SESSION_EGRESS_DNS=0` — means a contained
   * session gets the fixed Tier A IP floor and nothing else: dnsmasq is what
   * pins a newly-resolved IP into the ipset, and with no resolver and no proxy
   * an allowlist entry has nothing to act on. Defaults to TRUE when a caller
   * cannot say, deliberately: it is a pure env read that is never unknowable in
   * production, and guessing "floor only" would tell every user of an unwired
   * test runtime that their deployment can grant nothing.
   */
  dnsControlDeployed?: boolean | undefined;
  /**
   * The session's resolved egress config — the same `base` + `extraHosts` the
   * resolver and proxy are launched with. Absent in a runtime with no resolver
   * wired, where a contained session fails closed (see below).
   */
  config?: ResolvedEgressConfig | undefined;
  /** Scopes the allow-once lookup; without it that layer is not counted. */
  sessionId?: string | undefined;
  /**
   * An already-snapshotted allow-once set, for a caller holding one instead of a
   * live session: a plugin container's proxy is on a network denied ShipIt's API
   * (req 19), so it cannot ask the decision endpoint and the answer travels with
   * it (`plugin-egress.ts`). Composed with `sessionId` rather than replacing it;
   * a caller normally supplies one or the other. It passes through exactly the
   * same gates the live layer does — a sealed session and a floor-only
   * deployment discard both alike.
   */
  allowOnceHosts?: readonly string[] | undefined;
}

/**
 * Build the verdict function for one session.
 *
 * Fails closed on a contained session with no resolved config, for the reason
 * `loadSatisfiedPluginCredentialNames` does: "not knowable" must render as the
 * visible gap req 24 asks for, never as satisfied. The cost of being wrong that
 * way is one redundant, idempotent grant; the cost of the other way is a plugin
 * that fails at runtime with the card saying nothing. Note which way it fails —
 * `grantable`, never `blocked-*`: an unknown is a gap the user may try to close,
 * not a claim that they cannot.
 */
export function egressHostReach(input: EgressHostReachInput): (host: string) => EgressHostReach {
  // Nothing is denied, so nothing is "not yet allowed" and there is nothing to
  // grant. Naming a gap here would send the user to grant what was never
  // blocked; `isEgressContained` already folds in whether the deployment
  // enforces containment at all.
  if (!input.contained) return () => "allowed";

  // planning#383 — the deployment axis, checked before the allowlist because it
  // OVERRIDES it: with no Tier B resolver and no Tier C proxy, the fixed Tier A
  // floor is the whole reach of every contained session on this install, and the
  // allowlist (base, extras, allow-once alike) acts on nothing. So the verdict
  // here is about GRANTABILITY, which is knowable, and it outranks
  // `blocked-by-session` where both hold: both are true, and the wider one is
  // the one the user can do least about.
  //
  // The one `allowed` exception is deliberately narrow, and the review that
  // caught it is why. Tier A is an IP filter, so a hostname cannot decide its
  // membership in general: its GitHub half is CIDR ranges GitHub itself says are
  // NOT exhaustive, and mirroring them as suffix families was wrong in both
  // directions — `cli.github.io` sits inside `185.199.108.0/22` and would have
  // read blocked, while `pipelines.actions.githubusercontent.com` resolves
  // outside every published range and would have read allowed, which is the
  // exact optimism this whole predicate exists to stop. What IS knowable is the
  // installer's own resolve list: it names those hosts, resolves them in the
  // netns and pins the answers. Anything else reads `blocked-by-deployment`,
  // whose sentence is "no allowlist entry changes what this deployment reaches"
  // — true of a GitHub host too, even where the CIDR floor happens to admit it.
  if (input.dnsControlDeployed === false) {
    return (host: string): EgressHostReach =>
      matches(host, EGRESS_TIER_A_RESOLVE_HOSTS) ? "allowed" : "blocked-by-deployment";
  }

  // Exactly `buildProxyAllowed`'s composition. `base` is omitted by a config
  // that means "the full default list"; a Network-off sandbox narrows it, and a
  // user who removed a built-in default has it removed here too.
  const entries = input.config
    ? [...(input.config.base ?? EGRESS_DEFAULT_ALLOWLIST), ...input.config.extraHosts]
    : [];

  // planning#380 — a session whose policy admits no user hosts at all. Stated by
  // `resolveEgress`, never inferred from empty extras: "this session drops user
  // hosts" and "this user has added none" look identical and mean opposite
  // things. Its allow-once layer goes with it — docs/211's `network` capability
  // "only ever tightens", so a live decision may not widen it either, and
  // `pluginEgressPolicy` empties `allowOnceHosts` for the same config.
  const userHostsExcluded = input.config?.userHostsExcluded ?? false;
  const allowOnce = input.sessionId && !userHostsExcluded ? input.sessionId : null;
  const allowOnceSnapshot = userHostsExcluded ? [] : input.allowOnceHosts ?? [];

  return (host: string): EgressHostReach => {
    if (matches(host, entries)) return "allowed";
    // The in-memory allow-once set ONLY. `isEgressHostAllowed` would re-admit
    // the durable store here and undo the composition above (planning#380).
    if (allowOnce && isEgressAllowOnceHost(allowOnce, normalizeHost(host))) return "allowed";
    if (matches(host, allowOnceSnapshot)) return "allowed";
    return userHostsExcluded ? "blocked-by-session" : "grantable";
  };
}

/** Suffix/exact match of one host against allowlist-shaped entries. */
function matches(host: string, entries: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return entries.some((entry) => hostMatchesEntry(h, normalizeHost(entry)));
}
