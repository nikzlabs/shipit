// One-shot CLIs cannot self-wake. Deliver their finished consults after card persistence.

import type { SubAgentConsultCard } from "../../shared/types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";

export interface ConsultDeliveryStore {
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
  ): boolean;
  listSubAgentConsultCards(sessionId: string): SubAgentConsultCard[];
}

export interface ConsultResultDeliveryDeps extends WakeSessionDeps {
  chatHistoryManager: ConsultDeliveryStore;
}

export interface ConsultResultDeliveryRequest {
  sessionId: string;
  card: SubAgentConsultCard;
  /** Capture runner.turnEpoch when the consult is admitted. */
  originatingTurnEpoch: number;
}

export type ConsultDeliveryDecision =
  | { woken: true }
  | {
      woken: false;
      reason:
        | "no-session"
        | "cancelled-status"
        | "originating-turn-live"
        | "resident-cli-delivers"
        | "already-delivered"
        | "wake-failed";
      detail?: string;
    };

// Wake failure must not prevent the caller from returning the consult result.
export async function deliverConsultResultByWake(
  deps: ConsultResultDeliveryDeps,
  req: ConsultResultDeliveryRequest,
): Promise<ConsultDeliveryDecision> {
  try {
    return await decideAndDeliver(deps, req);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[consult-delivery] wake for ${req.sessionId} threw:`, err);
    return { woken: false, reason: "wake-failed", detail };
  }
}

async function decideAndDeliver(
  deps: ConsultResultDeliveryDeps,
  req: ConsultResultDeliveryRequest,
): Promise<ConsultDeliveryDecision> {
  const { sessionId, card } = req;

  // Cancellation must not restart a container that was just stopped.
  if (card.status === "cancelled" || card.status === "pending") {
    return { woken: false, reason: "cancelled-status", detail: card.status };
  }

  const session = deps.sessionManager.get(sessionId);
  if (!session || session.archived === true || session.userArchived === true) {
    return { woken: false, reason: "no-session" };
  }

  const runner: Pick<
    NonNullable<ReturnType<SessionRunnerRegistry["get"]>>,
    "running" | "isStreamingActive" | "turnEpoch"
  > | undefined = deps.runnerRegistry.get(sessionId) ?? undefined;

  if (runner) {
    // Avoid duplicating stdout delivery. Known gap: dispatch sets running before
    // it advances the epoch, so a later turn can briefly match the originating one.
    if (runner.running && (runner.turnEpoch ?? 0) === req.originatingTurnEpoch) {
      return { woken: false, reason: "originating-turn-live" };
    }
    // Resident CLIs notify on background completion; task counts drain before that
    // notification. A timed-out foreground shim still needs manual result recovery.
    if (runner.isStreamingActive) {
      return { woken: false, reason: "resident-cli-delivers" };
    }
  }

  if (readStoredCard(deps, sessionId, card.cardId)?.wakeDelivery) {
    return { woken: false, reason: "already-delivered" };
  }

  try {
    await wakeSessionWithTurn(deps, session, {
      text: buildConsultWakePrompt(card),
      activity: "Reading a finished background consult…",
      onSettled: (outcome: TurnOutcome) => {
        stampDelivery(deps, sessionId, card.cardId, {
          at: new Date().toISOString(),
          outcome: outcome.status === "completed" ? "delivered" : "failed",
          ...(outcome.status === "completed" ? {} : { detail: outcome.detail ?? outcome.status }),
        });
      },
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    stampDelivery(deps, sessionId, card.cardId, {
      at: new Date().toISOString(),
      outcome: "failed",
      detail,
    });
    console.error(`[consult-delivery] wake-turn not delivered to ${sessionId}:`, err);
    return { woken: false, reason: "wake-failed", detail };
  }

  // Stamp after acceptance so a crash before dispatch does not suppress delivery.
  stampDelivery(deps, sessionId, card.cardId, { at: new Date().toISOString(), outcome: "queued" });

  console.log(
    `[consult-delivery] woke session=${sessionId} spawn=${card.spawnId} `
    + `card=${card.cardId} status=${card.status}`,
  );
  return { woken: true };
}

function readStoredCard(
  deps: ConsultResultDeliveryDeps,
  sessionId: string,
  cardId: string,
): SubAgentConsultCard | undefined {
  try {
    return deps.chatHistoryManager
      .listSubAgentConsultCards(sessionId)
      .find((c) => c.cardId === cardId);
  } catch (err) {
    console.warn(`[consult-delivery] could not read card ${cardId} of ${sessionId}:`, err);
    return undefined;
  }
}

function stampDelivery(
  deps: ConsultResultDeliveryDeps,
  sessionId: string,
  cardId: string,
  wakeDelivery: NonNullable<SubAgentConsultCard["wakeDelivery"]>,
): void {
  try {
    // Settlement can precede the queued stamp; do not overwrite its result.
    if (wakeDelivery.outcome === "queued" && readStoredCard(deps, sessionId, cardId)?.wakeDelivery) {
      return;
    }
    if (!deps.chatHistoryManager.updateSubAgentConsultCard(sessionId, cardId, { wakeDelivery })) {
      console.warn(
        `[consult-delivery] no persisted card ${cardId} in ${sessionId} to stamp `
        + `(outcome=${wakeDelivery.outcome}) — delivery is not deduplicated`,
      );
    }
  } catch (err) {
    console.warn(`[consult-delivery] could not stamp card ${cardId} of ${sessionId}:`, err);
  }
}

export function buildConsultWakePrompt(card: SubAgentConsultCard): string {
  const who = card.roleName ? `\`${card.roleName}\` (${card.subAgentId})` : card.subAgentId;
  return [
    `Your background consult ${card.spawnId} — ${who} — finished with status ${card.status}.`,
    `Read it with \`shipit agent result ${card.spawnId}\` and continue the work it was for.`,
    card.status === "success"
      ? "Its findings are advisory; judge them before acting."
      : "It produced no usable answer — decide whether to re-run it or continue without it.",
  ].join("\n");
}
