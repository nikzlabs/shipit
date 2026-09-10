import { hostMatchesEntry, normalizeHost } from "./egress-allowlist.js";

interface SessionPolicy {
  allowed: Set<string>;
  carded: Set<string>;
}

// Process lifetime: runner disposal and container recreation do not clear decisions.
const policies = new Map<string, SessionPolicy>();
let durableSource: ((sessionId: string) => string[]) | null = null;

export function setEgressDurableSource(fn: ((sessionId: string) => string[]) | null): void {
  durableSource = fn;
}

function get(sessionId: string): SessionPolicy {
  let p = policies.get(sessionId);
  if (!p) {
    p = { allowed: new Set(), carded: new Set() };
    policies.set(sessionId, p);
  }
  return p;
}

export function isEgressAllowOnceHost(sessionId: string, host: string): boolean {
  const h = normalizeHost(host);
  const p = policies.get(sessionId);
  if (!p) return false;
  for (const entry of p.allowed) {
    if (hostMatchesEntry(h, entry)) return true;
  }
  return false;
}

// Decision endpoint only. Reachability readers must use the resolved config plus allow-once,
// because sandbox policies can exclude durable hosts.
export function isEgressHostAllowed(sessionId: string, host: string): boolean {
  const h = normalizeHost(host);
  if (isEgressAllowOnceHost(sessionId, h)) return true;
  if (durableSource) {
    for (const entry of durableSource(sessionId)) {
      if (hostMatchesEntry(h, entry)) return true;
    }
  }
  return false;
}

export function listEgressAllowedHosts(sessionId: string): string[] {
  return [...(policies.get(sessionId)?.allowed ?? [])];
}

export function allowEgressHost(sessionId: string, host: string): void {
  get(sessionId).allowed.add(normalizeHost(host));
}

// Call only when the session can accept user grants. Also records the card to suppress retries.
export function shouldCardEgressHost(sessionId: string, host: string): boolean {
  const h = normalizeHost(host);
  if (isEgressHostAllowed(sessionId, h)) return false;
  const p = get(sessionId);
  if (p.carded.has(h)) return false;
  p.carded.add(h);
  return true;
}

export function clearEgressPolicy(sessionId: string): void {
  policies.delete(sessionId);
}

export function _resetEgressPolicies(): void {
  policies.clear();
}
