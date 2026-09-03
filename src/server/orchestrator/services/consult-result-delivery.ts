/**
 * Handing a finished background consult back to the agent that asked for it
 * (docs/287).
 *
 * `shipit agent run` is a synchronous primitive: the shim blocks, the sub-agent
 * runs, and its final text comes back on stdout. `/shipit-docs/agent.md` then
 * tells the agent to BACKGROUND anything review-sized, because a real consult
 * routinely outruns the harness's 10-minute foreground tool cap. That leaves the
 * result with two ways home, and both belong to the CLI rather than to ShipIt:
 *
 *  1. the shim is still alive in the foreground and prints the text, or
 *  2. the resident streaming CLI notices its `Bash(run_in_background)` job
 *     finished and starts a turn of its own (`agent_self_wake`, docs/235).
 *
 * **Neither exists on a turn ShipIt started.** `dispatched-turn.ts` forces
 * `useStreaming = false` for every `systemTurn`, a one-shot CLI reaps its
 * background jobs and exits at turn end, and `turn-executor` refuses to re-arm a
 * non-streaming turn — so `agent_self_wake` is structurally impossible there. The
 * consult still finishes correctly and its card is still persisted; the agent is
 * simply never told. That is the whole of the 2026-09-03 incident, and it applies
 * to every ShipIt-started turn: merge wakes (`merge-watch.ts`), child reports
 * (`services/session-report.ts`), the rebase driver, CI auto-fix.
 *
 * So the orchestrator delivers it, in exactly the shape those two callers
 * already use: the durable card is written first (`services/sub-agent.ts` owns
 * that), then a self-describing system turn is woken on top of it. The wake
 * prompt names the run id rather than carrying the output, because the card is
 * the artifact and `shipit agent result <id>` is how an agent reads it.
 */

import type { SubAgentConsultCard } from "../../shared/types.js";
import type { SessionRunnerRegistry } from "../session-runner.js";
import type { TurnOutcome } from "../turn-settlement.js";
import { wakeSessionWithTurn, type WakeSessionDeps } from "../wake-session.js";

/** The chat-history surface the stamp needs. Structural so tests can stub it. */
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
  /** The consult card in its TERMINAL state, as just persisted. */
  card: SubAgentConsultCard;
  /**
   * `runner.turnEpoch` captured when the spawn was admitted — i.e. the turn that
   * asked for this consult. Equality with the runner's current epoch is what
   * distinguishes "the originating turn is still waiting on stdout" from "some
   * later turn happens to be running".
   */
  originatingTurnEpoch: number;
}

/** Why a delivery was or wasn't attempted. Logged; also the unit-test surface. */
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

/**
 * Wake `sessionId` so its agent picks up a finished consult — but only when
 * nothing else will.
 *
 * Never throws and never rejects: result delivery, the card, and `shipit agent
 * result` all have to keep working when this cannot run.
 */
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

  // A `cancelled` consult was ended by ShipIt taking the session away from it —
  // a container teardown, a forced dispose, an orchestrator restart's boot
  // reconcile. There is no result to act on, and the wake would BOOT a container
  // the user (or the idle enforcer) just stopped. Every other terminal status is
  // an answer the agent asked for, including `error` and `timeout`: what to do
  // next differs, but not knowing at all is the failure this closes.
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
    // The ORIGINATING turn is still in flight, so the caller is blocked on the
    // shim's own HTTP call and gets the text on stdout. Comparing the epoch
    // rather than just `running` is deliberate: a LATER turn running is not the
    // same thing, and skipping there would lose the result all over again — a
    // second child PR merging while the first consult is still going is an
    // ordinary shape in an orchestrating session. `dispatch` enqueues behind a
    // running turn, so waking is safe in that case.
    //
    // KNOWN RESIDUAL (cross-agent review, 2026-09-03). `runner.dispatch` and
    // `drainNextQueuedMessage` both set `running = true` synchronously and only
    // bump the epoch later, inside `executeAgentTurn`. A consult finishing
    // inside that window reads `running=true, epoch=<originating>` and stands
    // down, so the result is not delivered. That is today's behavior rather than
    // a new failure, and the alternative — waking whenever we are unsure — would
    // add a redundant turn to every ordinary FOREGROUND consult, which is the
    // common case. Narrowing it needs a turn identity that moves atomically with
    // `running`; tracked as follow-up work in the doc.
    if (runner.running && (runner.turnEpoch ?? 0) === req.originatingTurnEpoch) {
      return { woken: false, reason: "originating-turn-live" };
    }
    // A resident streaming CLI delivers this itself: the finished background job
    // produces a `task_notification`, which the adapter turns into
    // `agent_self_wake` and `turn-executor` re-arms into a real turn. Waking on
    // top of that would run a second, redundant turn saying the same thing.
    //
    // This is a property of the PROCESS, not of the shim: a foreground shim that
    // its tool timeout SIGTERMed leaves the resident CLI in place, and that CLI
    // raises no notification for a job it never backgrounded — so a consult
    // whose shim died that way still gets no wake. Deliberate. The alternative
    // signal (`backgroundTaskCount > 0`) is drained by the CLI ~1ms BEFORE the
    // notification it wakes on, so keying on it would fire a duplicate wake on
    // the ordinary streaming path — the common case — to cover a shape that
    // already has a documented recovery (`shipit agent result --wait`).
    if (runner.isStreamingActive) {
      return { woken: false, reason: "resident-cli-delivers" };
    }
  }

  // Fire-once, read from the durable card rather than from memory. In-process
  // this cannot double-fire (one `runSubAgent` call owns the card's only
  // handle), so this is the guard against a SECOND process ever reaching here —
  // a hand-run recovery path, a future retry — writing a duplicate wake.
  if (readStoredCard(deps, sessionId, card.cardId)?.wakeDelivery) {
    return { woken: false, reason: "already-delivered" };
  }

  try {
    await wakeSessionWithTurn(deps, session, {
      text: buildConsultWakePrompt(card),
      activity: "Reading a finished background consult…",
      // docs/240 — only `completed` counts as delivered; everything else means
      // the wake turn never ran and the card should say so rather than claim a
      // hand-over that did not happen.
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

  // Stamped only once the dispatch is ACCEPTED, never before it. The stamp is
  // also the fire-once guard, so writing it up front would turn an orchestrator
  // exit between the write and the dispatch into a permanent "already
  // delivered" for a wake that never happened.
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
    // Diagnostic-grade: an unreadable history must not stop the delivery this
    // whole module exists to make.
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
    // A settlement can only ever be an UPGRADE over `queued`, and a dispatch that
    // settles before this function's own `queued` stamp is written (an empty
    // queue cleared under it, a synchronous refusal) would otherwise be
    // overwritten by it — a card reporting a turn as in flight forever.
    if (wakeDelivery.outcome === "queued" && readStoredCard(deps, sessionId, cardId)?.wakeDelivery) {
      return;
    }
    if (!deps.chatHistoryManager.updateSubAgentConsultCard(sessionId, cardId, { wakeDelivery })) {
      // No persisted row carries this card — the fire-once guard and the audit
      // trail are both gone with it. Say so rather than failing silently; the
      // wake itself is unaffected and still worth making.
      console.warn(
        `[consult-delivery] no persisted card ${cardId} in ${sessionId} to stamp `
        + `(outcome=${wakeDelivery.outcome}) — delivery is not deduplicated`,
      );
    }
  } catch (err) {
    console.warn(`[consult-delivery] could not stamp card ${cardId} of ${sessionId}:`, err);
  }
}

/**
 * The wake prompt. Self-describing because it may run much later, and
 * deliberately NOT carrying the output: the card is the artifact, and `shipit
 * agent result` is the one way an agent reads it back (planning#247), so pasting
 * a second copy here would be the drift that guarantee exists to prevent.
 */
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
