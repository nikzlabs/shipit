/**
 * Turn preflight for provider-account routing (docs/150 req 13).
 *
 * `selectAccountForTurn` already answers "which account runs this turn, and if
 * none, why" — this module is the other half: turning a `{ ok: false }` answer
 * into something that actually stops the turn and tells the user, at the one
 * place every turn entrypoint passes through
 * (`prepareSessionAgentEnvironment`).
 *
 * **Which failures stop a turn.** Only the one the user cannot act on by
 * signing in:
 *
 *   - `all_exhausted` — every connected subscription for the provider has a
 *     window at 100%. Req 13: fail immediately and say when the earliest one
 *     resets. Notably we must NOT quietly roll onto the metered env/API-key
 *     route instead (req 12) — `selectAccountForTurn` already refuses to, and
 *     this is what makes that refusal visible rather than a silent stall.
 *
 * `auth_required` is deliberately NOT a blocking failure here. "You are not
 * signed in" already has its own surface — `authConfigured`, the auth prompts,
 * the Settings account rows — and turning it into a thrown turn error at
 * env-prep would replace a guided sign-in flow with a bare error string.
 * Selection returning `auth_required` keeps today's behavior: fall through to
 * the legacy provisioning path and let the agent's own auth handling take it.
 */

import type { AgentId } from "../shared/types.js";
import type {
  AccountSelection,
  AccountSelectionFailure,
  ProviderRoute,
} from "./provider-account-manager.js";

const PROVIDER_LABEL: Record<AgentId, string> = {
  claude: "Claude",
  codex: "Codex",
};

/**
 * Thrown from env-prep when no connected account can serve the turn. Carries
 * the structured failure so a caller that wants to render something richer
 * than `message` (a card, a Settings deep-link) has the reason and the reset
 * time without re-parsing prose.
 */
export class ProviderRouteUnavailableError extends Error {
  readonly provider: AgentId;
  readonly failure: AccountSelectionFailure;

  constructor(provider: AgentId, failure: AccountSelectionFailure, subject?: string) {
    super(describeAccountSelectionFailure(provider, failure, subject));
    this.name = "ProviderRouteUnavailableError";
    this.provider = provider;
    this.failure = failure;
  }
}

/**
 * True when a failed selection should stop the turn rather than fall through.
 * See the module docstring for why `auth_required` is excluded.
 *
 * Model eligibility is not a selection failure at all — routing around an
 * account that cannot run the requested model is a non-goal, so the turn runs
 * and the provider's own error is what the user sees.
 */
export function isTurnBlockingFailure(failure: AccountSelectionFailure): boolean {
  return failure.reason === "all_exhausted";
}

/**
 * User-facing sentence for a failed selection. Deliberately ends with what the
 * user can do about it: req 13 says ShipIt does not hold the prompt, so the
 * message has to tell them the turn is theirs to resend.
 */
export function describeAccountSelectionFailure(
  provider: AgentId,
  failure: AccountSelectionFailure,
  /**
   * docs/252 phase 5 — what ran out, when it is not the harness's own vendor.
   * Once a subscription can belong to any catalogue service, "every connected
   * Claude account is out of quota" is simply the wrong sentence for a spent GLM
   * coding plan running on the Claude harness. The caller supplies the service's
   * name because it is the one that knows the selection; absent, the harness
   * label is the pre-feature answer and stays correct for the first-party case.
   */
  subject?: string,
): string {
  const label = subject ?? PROVIDER_LABEL[provider] ?? provider;
  switch (failure.reason) {
    case "all_exhausted": {
      // ISO, matching the existing quota message in
      // `ws-handlers/agent-rate-limits.ts` — the orchestrator has no idea what
      // timezone the viewer is in, and two quota messages formatting the same
      // instant differently is worse than one that is unambiguous.
      const when = formatResetAt(failure.earliestResetAt);
      const resets = when
        ? `The earliest window resets at ${when}.`
        : `None of them reported when its window resets.`;
      // "account" is the right noun only for a login-flow subscription. A
      // supplied-key subscription has credentials, and they are added in
      // Settings → Services rather than connected.
      if (subject) {
        return (
          `Every ${subject} credential is out of quota. ${resets} ` +
          `Send this message again once quota is back, or add another ${subject} credential in Settings → Services.`
        );
      }
      return (
        `Every connected ${label} account is out of quota. ${resets} ` +
        `Send this message again once quota is back, or connect another ${label} account in Settings.`
      );
    }
    case "auth_required":
      return subject
        ? `No ${subject} credential is configured. Add one in Settings → Services to run this turn.`
        : `No ${label} account is connected. Connect one in Settings to run this turn.`;
  }
}

/**
 * Turn a selection result into either the chosen route or a thrown block.
 * Returns `undefined` for the non-blocking `auth_required` case so the caller
 * keeps its existing "no route, use the legacy path" behavior.
 */
export function routeFromSelection(
  provider: AgentId,
  selection: AccountSelection,
  /** See {@link describeAccountSelectionFailure}'s `subject`. */
  subject?: string,
): ProviderRoute | undefined {
  if (selection.ok) return selection.route;
  if (isTurnBlockingFailure(selection)) {
    throw new ProviderRouteUnavailableError(provider, selection, subject);
  }
  return undefined;
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const parsed = new Date(resetAt);
  return Number.isNaN(parsed.getTime()) ? resetAt : parsed.toISOString();
}
