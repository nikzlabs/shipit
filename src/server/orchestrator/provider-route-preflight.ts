/**
 * Turn preflight for provider-account routing (docs/150 reqs 13, 17).
 *
 * `selectAccountForTurn` already answers "which account runs this turn, and if
 * none, why" — this module is the other half: turning a `{ ok: false }` answer
 * into something that actually stops the turn and tells the user, at the one
 * place every turn entrypoint passes through
 * (`prepareSessionAgentEnvironment`).
 *
 * **Which failures stop a turn.** Only the two the user cannot act on by
 * signing in:
 *
 *   - `all_exhausted` — every connected subscription for the provider has a
 *     window at 100%. Req 13: fail immediately and say when the earliest one
 *     resets. Notably we must NOT quietly roll onto the metered env/API-key
 *     route instead (req 12) — `selectAccountForTurn` already refuses to, and
 *     this is what makes that refusal visible rather than a silent stall.
 *   - `no_model_eligible_account` — accounts are healthy but none reports the
 *     requested model. Req 17: skip and report, never substitute a model the
 *     user did not ask for.
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

  constructor(provider: AgentId, failure: AccountSelectionFailure) {
    super(describeAccountSelectionFailure(provider, failure));
    this.name = "ProviderRouteUnavailableError";
    this.provider = provider;
    this.failure = failure;
  }
}

/**
 * True when a failed selection should stop the turn rather than fall through.
 * See the module docstring for why `auth_required` is excluded.
 */
export function isTurnBlockingFailure(failure: AccountSelectionFailure): boolean {
  return failure.reason === "all_exhausted" || failure.reason === "no_model_eligible_account";
}

/**
 * User-facing sentence for a failed selection. Deliberately ends with what the
 * user can do about it: req 13 says ShipIt does not hold the prompt, so the
 * message has to tell them the turn is theirs to resend.
 */
export function describeAccountSelectionFailure(
  provider: AgentId,
  failure: AccountSelectionFailure,
): string {
  const label = PROVIDER_LABEL[provider] ?? provider;
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
      return (
        `Every connected ${label} account is out of quota. ${resets} ` +
        `Send this message again once quota is back, or connect another ${label} account in Settings.`
      );
    }
    case "no_model_eligible_account":
      return (
        `No connected ${label} account can run ${failure.model}. ` +
        `ShipIt will not silently switch you to a different model — pick a model one of your ` +
        `accounts supports, or connect an account that has it.`
      );
    case "auth_required":
      return `No ${label} account is connected. Connect one in Settings to run this turn.`;
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
): ProviderRoute | undefined {
  if (selection.ok) return selection.route;
  if (isTurnBlockingFailure(selection)) throw new ProviderRouteUnavailableError(provider, selection);
  return undefined;
}

function formatResetAt(resetAt: string | null): string | null {
  if (!resetAt) return null;
  const parsed = new Date(resetAt);
  return Number.isNaN(parsed.getTime()) ? resetAt : parsed.toISOString();
}
