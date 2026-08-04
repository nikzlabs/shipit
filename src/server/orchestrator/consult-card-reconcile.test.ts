import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { ChatHistoryManager, type PersistedMessage } from "./chat-history.js";
import {
  reconcileOrphanedConsultCards,
  ORPHANED_CONSULT_DETAIL,
  type ConsultCardReconcileStore,
} from "./consult-card-reconcile.js";
import type { SubAgentConsultCard } from "../shared/types.js";

/**
 * SHI-307 / docs/249 — the boot sweep that finishes consult cards the previous
 * orchestrator could not, because the only handle able to finish them died with
 * it. These run against a REAL `ChatHistoryManager` where the point is the DB
 * round-trip, and against stubs where the point is failure isolation.
 */

const consult = (
  spawnId: string,
  over: Partial<SubAgentConsultCard> = {},
): PersistedMessage => ({
  role: "assistant",
  text: "",
  subAgentConsult: {
    cardId: `card-${spawnId}`,
    spawnId,
    subAgentId: "codex",
    status: "pending",
    createdAt: "2026-08-04T09:00:00.000Z",
    ...over,
  },
});

describe("reconcileOrphanedConsultCards (SHI-307)", () => {
  let dbManager: DatabaseManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    dbManager.close();
    vi.restoreAllMocks();
  });

  it("marks a stranded pending card cancelled, with an explanation, so it stops lying", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "review the diff with codex" });
    mgr.append("sess-1", consult("spawn-a"));

    expect(reconcileOrphanedConsultCards(mgr)).toEqual({ reconciled: 1 });

    // Read back through a fresh manager — the reload / `shipit agent result` path.
    const [card] = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
    expect(card.status).toBe("cancelled");
    expect(card.statusDetail).toBe(ORPHANED_CONSULT_DETAIL);
    // The identity of the run survives, so the user can still see WHICH consult
    // was lost and the agent can still name it.
    expect(card).toMatchObject({
      spawnId: "spawn-a",
      subAgentId: "codex",
      createdAt: "2026-08-04T09:00:00.000Z",
    });
  });

  it("claims no duration — the run's real numbers died with the response", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", consult("spawn-a"));
    reconcileOrphanedConsultCards(mgr);
    const [card] = mgr.listSubAgentConsultCards("sess-1");
    expect(card.durationMs).toBeUndefined();
    expect(card.costUsd).toBe(0);
  });

  it("sweeps every session, because it cannot know which ones were running", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", consult("spawn-a"));
    mgr.append("sess-2", consult("spawn-b"));
    mgr.append("sess-3", consult("spawn-c"));

    expect(reconcileOrphanedConsultCards(mgr).reconciled).toBe(3);
    for (const sid of ["sess-1", "sess-2", "sess-3"]) {
      expect(mgr.listSubAgentConsultCards(sid)[0].status).toBe("cancelled");
    }
  });

  it("leaves already-terminal cards completely alone", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", consult("spawn-done", {
      status: "success",
      durationMs: 900_000,
      costUsd: 0.42,
      outputMarkdown: "## Findings\n\n- a real report",
    }));

    expect(reconcileOrphanedConsultCards(mgr)).toEqual({ reconciled: 0 });
    expect(mgr.listSubAgentConsultCards("sess-1")[0]).toMatchObject({
      status: "success",
      durationMs: 900_000,
      costUsd: 0.42,
      outputMarkdown: "## Findings\n\n- a real report",
    });
  });

  it("survives an adopted turn's replaceInProgress (the foreground-consult strand)", () => {
    // A foreground `shipit agent run` blocks its own turn, so the card is still
    // an in_progress=1 row when the orchestrator dies. docs/240 then adopts that
    // turn, and its finalize deletes every in-progress row in the session. The
    // sweep must run BEFORE the adoption and must finalize the row, or the card
    // is not merely still-pending — it is gone, and `shipit agent result` says
    // "No sub-agent runs in this session yet".
    const mgr = new ChatHistoryManager(dbManager);
    mgr.replaceInProgress("sess-1", [
      { role: "assistant", text: "asking codex", inProgress: true },
      { ...consult("spawn-a"), inProgress: true },
    ]);

    reconcileOrphanedConsultCards(mgr);
    // …then the adopted turn rebuilds its rows.
    mgr.replaceInProgress("sess-1", [{ role: "assistant", text: "adopted turn", inProgress: true }]);

    const cards = new ChatHistoryManager(dbManager).listSubAgentConsultCards("sess-1");
    expect(cards).toHaveLength(1);
    expect(cards[0].status).toBe("cancelled");
  });

  it("is a no-op on a clean boot", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", { role: "user", text: "hello" });
    expect(reconcileOrphanedConsultCards(mgr)).toEqual({ reconciled: 0 });
  });

  it("is idempotent — a second boot finds nothing left to do", () => {
    const mgr = new ChatHistoryManager(dbManager);
    mgr.append("sess-1", consult("spawn-a"));
    expect(reconcileOrphanedConsultCards(mgr).reconciled).toBe(1);
    expect(reconcileOrphanedConsultCards(mgr).reconciled).toBe(0);
  });

  it("never throws when the read fails — a bad sweep must not take the boot down", () => {
    const store: ConsultCardReconcileStore = {
      listPendingSubAgentConsultCards: () => { throw new Error("db is on fire"); },
      updateSubAgentConsultCard: () => true,
    };
    expect(reconcileOrphanedConsultCards(store)).toEqual({ reconciled: 0 });
  });

  it("keeps going when one card's patch throws, and does not count it", () => {
    const cards = ["a", "b", "c"].map((id) => ({
      sessionId: `sess-${id}`,
      card: {
        cardId: `card-${id}`, spawnId: `spawn-${id}`, subAgentId: "codex" as const,
        status: "pending" as const, createdAt: "2026-08-04T09:00:00.000Z",
      },
    }));
    const patched: string[] = [];
    const store: ConsultCardReconcileStore = {
      listPendingSubAgentConsultCards: () => cards,
      updateSubAgentConsultCard: (_sessionId, cardId) => {
        if (cardId === "card-b") throw new Error("row vanished");
        patched.push(cardId);
        return true;
      },
    };
    expect(reconcileOrphanedConsultCards(store)).toEqual({ reconciled: 2 });
    expect(patched).toEqual(["card-a", "card-c"]);
  });

  it("does not count a card that no longer matches", () => {
    const store: ConsultCardReconcileStore = {
      listPendingSubAgentConsultCards: () => [{
        sessionId: "sess-1",
        card: {
          cardId: "card-a", spawnId: "spawn-a", subAgentId: "codex",
          status: "pending", createdAt: "2026-08-04T09:00:00.000Z",
        },
      }],
      updateSubAgentConsultCard: () => false,
    };
    expect(reconcileOrphanedConsultCards(store)).toEqual({ reconciled: 0 });
  });
});
