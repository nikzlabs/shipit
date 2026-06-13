/**
 * Egress allow-once policy — Tier C decision state (docs/172 Gap 1, SHI-90).
 *
 * The policy decision point for the Tier C SNI proxy's allow-once flow. The
 * proxy queries the orchestrator for a host not in its static allowlist; this
 * module holds the per-session user decisions that answer that query:
 *
 *   - `allowed`  — hosts the user approved via the inline card (allow-once / add).
 *   - `carded`   — hosts already surfaced as a card, so a re-denied host doesn't
 *                  spam a new card every retry.
 *
 * Scope (C2): per-session and **in-memory** — a decision lasts the session/runner
 * lifetime. "Add to allowlist" reuses the same set; durable, cross-restart
 * persistence + an editor is the Settings-UI follow-up (see checklist). The chat
 * card itself persists (chat history), so the user's decision is never lost from
 * the transcript; only the live allow-set is ephemeral. A module-level Map is the
 * same orchestrator-process-singleton pattern as the GitHub-CIDR cache — no DI
 * wiring, reachable from both the HTTP decision route and the WS handler.
 */

import { hostMatchesEntry, normalizeHost } from "./egress-allowlist.js";

interface SessionPolicy {
  /** Hosts the user approved this session (allow-once or add). */
  allowed: Set<string>;
  /** Hosts already carded — dedupe so a retry loop doesn't spam cards. */
  carded: Set<string>;
}

const policies = new Map<string, SessionPolicy>();

function get(sessionId: string): SessionPolicy {
  let p = policies.get(sessionId);
  if (!p) {
    p = { allowed: new Set(), carded: new Set() };
    policies.set(sessionId, p);
  }
  return p;
}

/** Has the user allowed this host for the session (matches suffix entries too)? */
export function isEgressHostAllowed(sessionId: string, host: string): boolean {
  const p = policies.get(sessionId);
  if (!p) return false;
  const h = normalizeHost(host);
  for (const entry of p.allowed) {
    if (hostMatchesEntry(h, entry)) return true;
  }
  return false;
}

/** Record a user allow decision for a host (allow-once or add-to-allowlist). */
export function allowEgressHost(sessionId: string, host: string): void {
  get(sessionId).allowed.add(normalizeHost(host));
}

/**
 * Should the orchestrator surface a card for this denied host? True only if the
 * host is not already allowed AND hasn't been carded yet — and marks it carded so
 * the proxy's retry loop (it re-queries after a short negative cache) doesn't emit
 * a fresh card each time. A subsequent user "deny" leaves it carded (no re-card).
 */
export function shouldCardEgressHost(sessionId: string, host: string): boolean {
  const h = normalizeHost(host);
  if (isEgressHostAllowed(sessionId, h)) return false;
  const p = get(sessionId);
  if (p.carded.has(h)) return false;
  p.carded.add(h);
  return true;
}

/** Drop a session's policy (call on session dispose). Safe if absent. */
export function clearEgressPolicy(sessionId: string): void {
  policies.delete(sessionId);
}

/** Test-only: reset all policy state. */
export function _resetEgressPolicies(): void {
  policies.clear();
}
