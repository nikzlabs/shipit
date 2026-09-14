import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The lock every settings write is taken under
 * (docs/299-agent-settings-access, plan.md → The target, and the lock).
 *
 * A conflict domain is **the stored object an operation writes**, which is
 * coarser than a declaration key: a role's model tuple, an edit to that role's
 * effort, and the dialog saving the whole role all write one stored role, so all
 * three take that role's domain. Every writer of that object takes it, including
 * whole-object dialog saves — which is the point, since serializing only the new
 * writers would leave the shipped ones interleaving with them.
 *
 * **Serialization buys ordering, not conflict detection.** The MCP editor
 * captures the whole server object when it opens and submits a complete
 * configuration, so a form opened before another write applies will overwrite it
 * — in correct order. That is pre-existing last-write-wins, which this neither
 * introduces nor closes.
 *
 * The queue is keyed by domain and lives for the process, never on a runner: a
 * settings write outlives the turn and the viewer that asked for it.
 */

export type ConflictDomain = string;

export const settingsPayloadDomain: ConflictDomain = "global-settings-payload";
export const gitIdentityDomain: ConflictDomain = "git-identity";
export const releaseChannelDomain: ConflictDomain = "release-channel";
export const reviewerSlotsDomain: ConflictDomain = "reviewer-slots";
export const providerAccountsDomain: ConflictDomain = "provider-accounts";

export function roleDomain(name: string): ConflictDomain {
  return `role:${name}`;
}

export function mcpServerDomain(name: string): ConflictDomain {
  return `mcp-server:${name}`;
}

/** One egress scope — the global allowlist, or one session's. */
export function egressScopeDomain(scope: string): ConflictDomain {
  return `egress:${scope}`;
}

export function repositoryDomain(url: string): ConflictDomain {
  return `repository:${url}`;
}

export function credentialRoutesDomain(serviceId: string, billingMode: string): ConflictDomain {
  return `credential-routes:${serviceId}:${billingMode}`;
}

/** One stored credential, addressed by route id — its label lives here. */
export function credentialRouteDomain(routeId: string): ConflictDomain {
  return `credential-route:${routeId}`;
}

const queues = new Map<ConflictDomain, Promise<unknown>>();

/**
 * What the current async context already holds.
 *
 * A settings proposal has to re-read the stored value, compare the baseline the
 * user approved against and write, all without releasing the lock in between —
 * otherwise a dialog save landing between the check and the write is exactly the
 * overwrite the baseline exists to prevent. The write itself is an operation in
 * `settings-apply.ts`, which takes the same domains, so the outer hold and the
 * inner one are the same domains and a plain re-acquisition would wait on
 * itself forever.
 */
const held = new AsyncLocalStorage<ReadonlySet<ConflictDomain>>();

/**
 * Run `work` with every named domain held, and release them when it settles.
 *
 * Every predecessor is waited on in ONE `allSettled` rather than acquired one
 * domain at a time, which is what makes the order the caller named them in
 * irrelevant: two operations naming overlapping sets in opposite orders cannot
 * each hold half of what the other is waiting for. Sorting is only for a
 * canonical, deduplicated set. Rejections do not poison a queue: the next waiter
 * chains off a settled promise either way.
 *
 * **A nested call may only name domains its caller already holds.** Re-entrancy
 * exists for one shape — a caller holding a target's domains across a check and
 * the `settings-apply.ts` operation that writes it — and there the two sets are
 * the same by construction. Acquiring a NEW domain while holding one is the
 * classic lock-ordering deadlock (this call waits for a domain another holder
 * wants, while that holder waits for one of ours), so it is refused by name
 * rather than left to hang: the outer caller has to name every domain its work
 * will take.
 */
export async function withConflictDomains<T>(
  domains: readonly ConflictDomain[],
  work: () => Promise<T> | T,
): Promise<T> {
  const outer = held.getStore();
  if (outer) {
    const fresh = domains.filter((domain) => !outer.has(domain));
    if (fresh.length === 0) return work();
    throw new Error(
      `A nested settings write asked for ${fresh.join(", ")}, which its caller does not hold. `
        + "The outer call must name every conflict domain its work takes.",
    );
  }
  const wanted = [...new Set(domains)].sort();
  if (wanted.length === 0) return work();

  const predecessors = wanted.map((domain) => queues.get(domain)).filter((p): p is Promise<unknown> => !!p);
  const run = (async () => {
    await Promise.allSettled(predecessors);
    return held.run(new Set(wanted), work);
  })();
  // Two-arg form on purpose: the successor must wait for the predecessor to
  // SETTLE, and awaiting a rejecting `run` here would leave the rejection
  // unhandled on a promise nobody else owns.
  // eslint-disable-next-line no-restricted-syntax -- Promise two-arg form
  const released = run.then(() => undefined, () => undefined);
  for (const domain of wanted) queues.set(domain, released);
  try {
    return await run;
  } finally {
    // Drop a queue nobody is waiting on, so the map does not grow per role,
    // per MCP server and per repository for the life of the process.
    for (const domain of wanted) {
      if (queues.get(domain) === released) queues.delete(domain);
    }
  }
}

/** Tests only: whether any domain is still held. */
export function conflictDomainsIdle(): boolean {
  return queues.size === 0;
}
