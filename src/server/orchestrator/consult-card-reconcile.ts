import type { SubAgentConsultCard } from "../shared/types.js";

export interface ConsultCardReconcileStore {
  listPendingSubAgentConsultCards(): { sessionId: string; card: SubAgentConsultCard }[];
  updateSubAgentConsultCard(
    sessionId: string,
    cardId: string,
    patch: Partial<SubAgentConsultCard>,
    opts?: { finalize?: boolean },
  ): boolean;
}

export const ORPHANED_CONSULT_STATUS = "cancelled" as const;

export const ORPHANED_CONSULT_DETAIL =
  "ShipIt restarted while this consult was running, so its result was lost. "
  + "The sub-agent's output cannot be recovered — re-run the consult if you still need it.";

export interface ReconcileOrphanedConsultsResult {
  reconciled: number;
}

/**
 * Boot only, before turn adoption or new consults. Assumes one orchestrator per database.
 * The previous process held the only result handles; their output cannot be recovered.
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
          // Missing telemetry means unknown; zero would claim a measured result.
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
