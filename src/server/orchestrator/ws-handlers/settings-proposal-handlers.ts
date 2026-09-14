import type { AppCtx, ConnectionCtx, RunnerCtx } from "./types.js";
import type { WsSettingsProposalDecision } from "../../shared/types/ws-client-messages.js";
import { resolveSettingsProposal } from "../services/settings-decision.js";
import { settingsProposalDeps } from "../services/settings-proposal-deps.js";
import { ServiceError } from "../services/types.js";
import { getErrorMessage } from "../validation.js";

/**
 * The user's click on a settings proposal card
 * (docs/299-agent-settings-access req 4).
 *
 * The egress prompt card is the nearest existing machinery and deliberately not
 * the template: it mutates from the client's message without loading or claiming
 * a card, which is safe only because its decision is one idempotent host add. A
 * settings decision loads the proposal, claims it atomically and applies it
 * under the target's lock — all of which lives in `settings-decision.ts`, so
 * this handler is only the transport.
 *
 * Two things it deliberately does NOT do. It does not resolve a runner: a card
 * is clicked hours after its turn as often as during it, and the decision path
 * settles without one. And it does not take the session from the message: the
 * connection is already scoped to one session, so a card id arriving on it can
 * only ever mean that session's card.
 */

type SettingsProposalCtx = ConnectionCtx & RunnerCtx & AppCtx;

export async function handleSettingsProposalDecision(
  ctx: SettingsProposalCtx,
  msg: WsSettingsProposalDecision,
): Promise<void> {
  const sessionId = ctx.getActiveAppSessionId();
  if (!sessionId) {
    ctx.send({ type: "error", message: "No active session for a settings decision" });
    return;
  }
  if (!msg.cardId || (msg.action !== "apply" && msg.action !== "dismiss")) {
    ctx.send({ type: "error", message: "A settings decision needs a cardId and an action" });
    return;
  }
  const deps = settingsProposalDeps(ctx);
  if (!deps) {
    ctx.send({ type: "error", message: "This install cannot resolve settings proposals." });
    return;
  }
  try {
    await resolveSettingsProposal(deps, sessionId, msg.cardId, msg.action);
  } catch (err) {
    // The card carries its own outcome, so an error here is about the decision
    // never reaching one — a card that is not in this session, a store this
    // install does not have.
    console.error(`[settings-proposal] ${msg.action} on ${msg.cardId} failed:`, err);
    ctx.send({
      type: "error",
      message: err instanceof ServiceError ? err.message : `Failed to resolve: ${getErrorMessage(err)}`,
    });
  }
}
