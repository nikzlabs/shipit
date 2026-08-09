/**
 * docs/252 phase 5 — req 12: what ShipIt does when a credential stops working
 * mid-session.
 *
 * **The branch is the billing mode, and nothing else.** Not the error text —
 * ShipIt never has to decide whether a 401 means "quota spent" or "key is bad",
 * which is fortunate because that text is not reliable and Claude's is reduced
 * to a payload-free `auth_required` before the orchestrator sees it. And not how
 * the credential is *delivered* either: `via` is delivery, `billingMode` is
 * billing, and this repository holds counter-examples in both directions —
 * `claude-env-oauth` is a subscription delivered as an environment string, and
 * GLM's coding plan is a subscription authenticated by an API key. A rule keyed
 * on "is this a key?" would turn a plan outage into a stopped session.
 *
 * So there are exactly two behaviours:
 *
 *   - **`sub` — fail over.** Another credential of the *same* `(service, billing
 *     mode)`, ShipIt's own recovery flows included. Never another service, never
 *     the other mode.
 *   - **`key` — stop and say so.** No vendor re-auth, no token heal, no
 *     same-turn retry, no failover. Recovering from a bad key is the harness's
 *     job; ShipIt runs no recovery or re-prompt flow of its own.
 *
 * **`undefined` keeps today's behaviour.** A session that has pinned no route
 * and holds no selection — a pre-feature row, a first turn that failed before
 * pinning — cannot answer the question, and answering it wrongly in the `key`
 * direction would stop turns that recover fine today. The fallback direction is
 * chosen to be a no-op on the installs that predate this feature, not because
 * `sub` is the safer billing answer.
 */

import type { BillingMode } from "../shared/catalogue/index.js";
import { getService, nativeServiceForHarness } from "../shared/catalogue/index.js";
import type { SessionInfo } from "../shared/types.js";

/** The session fields that answer "what is this turn billed to?". */
export type CredentialFailureSubject = Pick<
  SessionInfo,
  "agentId" | "serviceId" | "billingMode" | "providerRouteServiceId" | "providerRouteBillingMode"
>;

export interface CredentialFailurePolicy {
  /** The billing mode in force, or `undefined` when the session names none. */
  billingMode: BillingMode | undefined;
  /** The service the failing credential belongs to, for the message. */
  serviceId: string | undefined;
  /**
   * True when a credential failure must STOP this turn: no vendor re-auth, no
   * token heal, no same-turn quota retry, no failover.
   */
  stopsOnFailure: boolean;
  /**
   * True when the failing credential belongs to the **harness's own vendor**, so
   * that vendor's OAuth healer and silent refresher can act on it.
   *
   * A separate question from the billing one, and it has to be: the recovery
   * flows are per-vendor machinery (`ensureAgentTokenFresh`,
   * `onAgentAuthRequired` — Anthropic's and OpenAI's, wired by `AgentId`), so
   * running them for a GLM subscription heals a token that has nothing to do
   * with the failure and can broadcast a global "Sign in" toast naming the wrong
   * service. False here means *ShipIt's* answer is the one that applies: set the
   * credential aside and let the next turn fail over (req 12).
   *
   * `undefined` service — a pre-feature row, or a turn that failed before
   * pinning — answers TRUE, so an install that predates this feature behaves
   * exactly as it did.
   */
  vendorOwnedRecovery: boolean;
}

/**
 * The policy for `session`, read from **the route in force** and only then from
 * the selection.
 *
 * The order matters and is phase 1's rule restated: a route's billing mode is a
 * property of the route, not of the selection that was in force when it was
 * pinned, and the two can disagree — routing can land a session that selected a
 * subscription on a metered key when no account is connected. The credential
 * that just failed is the pinned one, so the pinned one is what decides.
 */
export function credentialFailurePolicyFor(
  session: CredentialFailureSubject | undefined,
): CredentialFailurePolicy {
  const billingMode = session?.providerRouteBillingMode ?? session?.billingMode;
  const serviceId = session?.providerRouteServiceId ?? session?.serviceId;
  const nativeService = nativeServiceForHarness(session?.agentId);
  return {
    billingMode,
    serviceId,
    stopsOnFailure: billingMode === "key",
    vendorOwnedRecovery: serviceId === undefined || serviceId === nativeService,
  };
}

/** Shorthand for the one question every gate asks. */
export function stopsOnCredentialFailure(session: CredentialFailureSubject | undefined): boolean {
  return credentialFailurePolicyFor(session).stopsOnFailure;
}

/**
 * The sentence a stopped turn leaves in the transcript (req 12: "ShipIt stops
 * and says so").
 *
 * It replaces the account-shaped "Open Settings → Agents to sign in", which is
 * not something a user of a key-authenticated service can act on: there is no
 * account to sign into, and no ShipIt flow that could fix the key. Naming the
 * service is what makes it actionable on an install holding several — "the
 * credential failed" says nothing about *which* card to open.
 */
export function credentialFailureStopMessage(policy: CredentialFailurePolicy): string {
  const name = policy.serviceId ? getService(policy.serviceId)?.name ?? policy.serviceId : undefined;
  const subject = name ? `${name}'s API key` : "this turn's API key";
  return (
    `Authentication failed for ${subject}, so this turn stopped. `
    + `ShipIt does not retry or re-authenticate an API key — check the credential in `
    + `Settings → Services, then resend your message.`
  );
}

/**
 * The sentence for the other half of req 12: a **subscription** credential ShipIt
 * cannot heal, because it is not the harness vendor's.
 *
 * ShipIt sets it aside rather than retrying the turn — a re-run on an auth
 * failure is docs/179's flow, which exists for a stale OAuth token and has
 * nothing to heal here — and the next message routes to another credential of
 * the same `(service, mode)` if there is one. If there is not, that next turn
 * stops with req 13's message instead, which is the honest ordering: ShipIt does
 * not promise a credential it has not yet tried to resolve.
 */
export function credentialSetAsideMessage(policy: CredentialFailurePolicy): string {
  const name = policy.serviceId
    ? getService(policy.serviceId)?.name ?? policy.serviceId
    : "this service";
  return (
    `Authentication failed for the ${name} credential this turn was using, so the turn stopped. `
    + `ShipIt has set that credential aside — send your message again and it will use another `
    + `${name} credential if you have one.`
  );
}
