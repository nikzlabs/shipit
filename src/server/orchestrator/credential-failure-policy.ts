import type { BillingMode } from "../shared/catalogue/index.js";
import { getService, loginIntegrationForService, nativeServiceForHarness } from "../shared/catalogue/index.js";
import type { SessionInfo } from "../shared/types.js";

export type CredentialFailureSubject = Pick<
  SessionInfo,
  "agentId" | "serviceId" | "billingMode"
>;

export interface CredentialFailurePolicy {
  billingMode: BillingMode | undefined;
  serviceId: string | undefined;
  stopsOnFailure: boolean;
  vendorOwnedRecovery: boolean;
}

// Use the turn's captured route: model changes can alter the session selection mid-turn.
export function credentialFailurePolicyForRoute(
  agentId: SessionInfo["agentId"] | undefined,
  billingMode: BillingMode | undefined,
  serviceId: string | undefined,
): CredentialFailurePolicy {
  const nativeService = nativeServiceForHarness(agentId);
  return {
    billingMode,
    serviceId,
    // Billing mode is independent of credential delivery; subscriptions can use API keys.
    stopsOnFailure: billingMode === "key",
    vendorOwnedRecovery:
      serviceId === undefined
      // eslint-disable-next-line no-restricted-syntax -- OpenCode needs an access-only ChatGPT projection in a private XDG home.
      || ((serviceId === nativeService || (agentId === "opencode" && serviceId === "openai" && billingMode === "sub")) && loginIntegrationForService(serviceId) !== undefined),
  };
}

// Fallback only when no route was captured; legacy provider_route_* pins are obsolete.
export function credentialFailurePolicyFor(
  session: CredentialFailureSubject | undefined,
): CredentialFailurePolicy {
  return credentialFailurePolicyForRoute(session?.agentId, session?.billingMode, session?.serviceId);
}

export function stopsOnCredentialFailure(session: CredentialFailureSubject | undefined): boolean {
  return credentialFailurePolicyFor(session).stopsOnFailure;
}

// Retry and error-row suppression must use the same answer or failures can become invisible.
export function quotaRefusalCanFailOver(
  capturedRoutePolicy: CredentialFailurePolicy | undefined,
  session: CredentialFailureSubject | undefined,
  servingCliStartedTurn = false,
): boolean {
  if (servingCliStartedTurn) return false;
  if (capturedRoutePolicy) return !capturedRoutePolicy.stopsOnFailure;
  return !stopsOnCredentialFailure(session);
}

export function credentialFailureStopMessage(policy: CredentialFailurePolicy): string {
  const name = policy.serviceId ? getService(policy.serviceId)?.name ?? policy.serviceId : undefined;
  const subject = name ? `${name}'s API key` : "this turn's API key";
  return (
    `Authentication failed for ${subject}, so this turn stopped. `
    + `ShipIt does not retry or re-authenticate an API key — check the credential in `
    + `Settings → Services, then resend your message.`
  );
}

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
