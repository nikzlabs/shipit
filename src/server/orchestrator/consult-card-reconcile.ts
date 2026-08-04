/**
 * Boot reconcile for sub-agent consult cards stranded by an orchestrator
 * restart (SHI-307, docs/249).
 *
 * ## The strand
 *
 * `runSubAgent` (`services/sub-agent.ts`) is the ONLY writer of a consult card's
 * `pending` → terminal patch, and it writes it when the worker's synchronous
 * `/agent/spawn` response returns. That response is an in-memory promise. The
 * worker keeps no durable record of the run (`agent-controller.ts` returns the
 * result inline and drops the handle in a `finally`), so when the orchestrator
 * process dies mid-run there is nobody left to finish the card:
 *
 *  - the card stays `pending` in the DB forever,
 *  - the UI renders a consult that is permanently in flight,
 *  - `shipit agent result` answers `pending` on every call — exit `4`, "still
 *    running" — so a caller polling until the run finishes never stops, and
 *    `--wait` burns its whole timeout against it every time.
 *
 * Session containers outlive an orchestrator restart (docs/240), so the
 * sub-agent itself usually runs to completion — writing its output into a
 * socket whose other end is gone. That output is not recoverable here: this
 * sweep makes the card HONEST, it does not bring the work back. Recovering it
 * would take a durable worker-side record plus a re-attach path, which is
 * deliberately out of scope (docs/249 requirements, resolved 2026-08-04).
 *
 * ## Why a boot sweep is safe
 *
 * The hazard with any "mark the stale ones failed" pass is marking a LIVE run
 * failed. That cannot happen here, because of when it runs rather than because
 * of what it checks: `runSubAgent` holds its card's only in-memory handle, so a
 * card can only be finished by the process that started it. In a process that
 * has just booted, every `pending` card in the DB is by construction owned by a
 * dead process. The sweep runs once, during boot, before any route can accept a
 * new spawn — so there is no live consult for it to race with, and no need for
 * a heuristic about age or liveness.
 *
 * That reasoning is load-bearing: this must NOT be moved onto a periodic timer
 * or a per-activation hook, where a genuinely in-flight consult would be in
 * scope and would be cancelled out from under its caller.
 */

import type { SubAgentConsultCard } from "../shared/types.js";

/**
 * The chat-history surface the sweep needs. Structural so tests can pass a stub
 * without a real SQLite-backed `ChatHistoryManager`.
 */
export interface ConsultCardReconcileStore {
  listPendingSubAgentConsultCards(): { sessionId: string; card: SubAgentConsultCard }[];
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
    opts?: { finalize?: boolean },
  ): boolean;
}

/**
 * What the reconciled card says happened.
 *
 * `cancelled` rather than `error`: nothing went wrong with the sub-agent — we
 * cut the run short by restarting — and an error-shaped card would send the
 * reader looking for a fault in Codex that isn't there. The card's verb alone
 * ("Cancelled Codex") is then indistinguishable from a consult the USER
 * cancelled, which is what `statusDetail` exists to fix.
 */
export const ORPHANED_CONSULT_STATUS = "cancelled" as const;

/**
 * ShipIt's own words, never the sub-agent's — hence `statusDetail` and not
 * `outputMarkdown` (see the field's docstring). Written to be actionable by
 * both readers of the card: the human, and the agent that gets it back from
 * `shipit agent result`.
 */
export const ORPHANED_CONSULT_DETAIL =
  "ShipIt restarted while this consult was running, so its result was lost. "
  + "The sub-agent's output cannot be recovered — re-run the consult if you still need it.";

export interface ReconcileOrphanedConsultsResult {
  /** How many cards were flipped out of `pending`. */
  reconciled: number;
}

/**
 * Mark every consult card left `pending` by a previous orchestrator terminal.
 *
 * Call once at boot, and BEFORE `reattachInFlightTurns` (docs/240): a consult
 * spawned by a foreground `shipit agent run` is still inside its originating
 * turn, so its row is `in_progress=1`, and the adopted turn's `replaceInProgress`
 * deletes every such row in the session. Finalizing the row here — which is what
 * the `finalize` option does — is what keeps the card from being deleted instead
 * of merely being left pending. Running after the adoption would be a race
 * against that delete.
 *
 * Never throws: a boot sweep that fails must not take the orchestrator with it.
 */
export function reconcileOrphanedConsultCards(
  store: ConsultCardReconcileStore,
): ReconcileOrphanedConsultsResult {
  let pending: { sessionId: string; card: SubAgentConsultCard }[];
  try {
    pending = store.listPendingSubAgentConsultCards();
  } catch (err) {
    console.error("[consult-reconcile] failed to read pending consult cards:", err);
    return { reconciled: 0 };
  }
  if (pending.length === 0) return { reconciled: 0 };

  let reconciled = 0;
  for (const { sessionId, card } of pending) {
    try {
      const patched = store.updateSubAgentConsultCard(
        sessionId,
        card.cardId,
        {
          status: ORPHANED_CONSULT_STATUS,
          statusDetail: ORPHANED_CONSULT_DETAIL,
          // No duration or cost is claimed: the run's real numbers died with the
          // response, and inventing a wall-clock figure from `createdAt` would
          // report time the consult may never have spent working.
          costUsd: 0,
          truncated: false,
        },
        { finalize: true },
      );
      if (!patched) continue;
      reconciled += 1;
      console.warn(
        `[consult-reconcile] stranded session=${sessionId} spawn=${card.spawnId} `
        + `card=${card.cardId} agent=${card.subAgentId} createdAt=${card.createdAt} `
        + `→ ${ORPHANED_CONSULT_STATUS}`,
      );
    } catch (err) {
      console.error(
        `[consult-reconcile] failed to reconcile session=${sessionId} card=${card.cardId}:`,
        err,
      );
    }
  }
  if (reconciled > 0) {
    console.warn(
      `[consult-reconcile] marked ${reconciled} consult card(s) cancelled — `
      + "stranded pending by a previous orchestrator run",
    );
  }
  return { reconciled };
}
