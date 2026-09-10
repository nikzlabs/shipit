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
  /** Callers choose live-container or resolved containment to match their question. */
  contained: boolean;
  dnsControlDeployed?: boolean | undefined;
  config?: ResolvedEgressConfig | undefined;
  sessionId?: string | undefined;
  /** Plugin proxies cannot query the decision endpoint and carry a snapshot instead. */
  allowOnceHosts?: readonly string[] | undefined;
}

// Reports host grants, not tenant identity rules or whether a running container has reloaded.
export function egressHostReach(input: EgressHostReachInput): (host: string) => EgressHostReach {
  if (!input.contained) return () => "allowed";

  // Without DNS control, grants cannot widen the fixed IP filter. Only its resolve list
  // can be classified by hostname; GitHub CIDR membership cannot.
  if (input.dnsControlDeployed === false) {
    return (host: string): EgressHostReach =>
      matches(host, EGRESS_TIER_A_RESOLVE_HOSTS) ? "allowed" : "blocked-by-deployment";
  }

  const entries = input.config
    ? [...(input.config.base ?? EGRESS_DEFAULT_ALLOWLIST), ...input.config.extraHosts]
    : [];

  const userHostsExcluded = input.config?.userHostsExcluded ?? false;
  const allowOnce = input.sessionId && !userHostsExcluded ? input.sessionId : null;
  const allowOnceSnapshot = userHostsExcluded ? [] : input.allowOnceHosts ?? [];

  return (host: string): EgressHostReach => {
    if (matches(host, entries)) return "allowed";
    // Read only allow-once grants; the durable store would bypass the resolved policy.
    if (allowOnce && isEgressAllowOnceHost(allowOnce, normalizeHost(host))) return "allowed";
    if (matches(host, allowOnceSnapshot)) return "allowed";
    return userHostsExcluded ? "blocked-by-session" : "grantable";
  };
}

function matches(host: string, entries: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return entries.some((entry) => hostMatchesEntry(h, normalizeHost(entry)));
}
