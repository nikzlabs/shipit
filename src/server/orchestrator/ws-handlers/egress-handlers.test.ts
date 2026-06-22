/**
 * Tests for the Tier C egress allow-once WS handler (docs/172, SHI-90),
 * focusing on the durable write-through + live reload on "Add to allowlist".
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { handleEgressDecision } from "./egress-handlers.js";
import { DatabaseManager } from "../../shared/database.js";
import { EgressAllowlistStore, EGRESS_GLOBAL_SCOPE } from "../egress-allowlist-store.js";
import { isEgressHostAllowed, _resetEgressPolicies, setEgressDurableSource } from "../egress-policy.js";
import type { WsEgressDecision } from "../../shared/types/ws-client-messages.js";

function makeCtx(store: EgressAllowlistStore, reloadEgress: ReturnType<typeof vi.fn>) {
  const emitted: unknown[] = [];
  const updates: unknown[] = [];
  const runner = { emitMessage: (m: unknown) => emitted.push(m) };
  const ctx = {
    getActiveAppSessionId: () => "s1",
    getRunnerRegistry: () => ({ get: () => runner }),
    getRunner: () => runner,
    send: vi.fn(),
    chatHistoryManager: {
      updateEgressPromptCard: (_sid: string, _cardId: string, patch: unknown) => updates.push(patch),
    },
    egressAllowlistStore: store,
    containerManager: { reloadEgress },
  } as never;
  return { ctx, emitted, updates };
}

describe("handleEgressDecision", () => {
  let db: DatabaseManager;
  let store: EgressAllowlistStore;
  let reloadEgress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    _resetEgressPolicies();
    setEgressDurableSource(null);
    db = new DatabaseManager(":memory:");
    store = new EgressAllowlistStore(db);
    reloadEgress = vi.fn(async () => true);
  });

  it("'add' grants live, writes the host to the durable global allowlist, and reloads the session", () => {
    const { ctx, updates } = makeCtx(store, reloadEgress);
    const msg: WsEgressDecision = { type: "egress_decision", action: "add", host: "cdn.example.com", cardId: "egress-s1-cdn.example.com" };
    handleEgressDecision(ctx, msg);

    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(true);
    expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual(["cdn.example.com"]);
    expect(reloadEgress).toHaveBeenCalledWith("s1");
    expect(updates).toContainEqual({ phase: "added" });
  });

  it("'allow-once' grants live but does NOT persist or reload", () => {
    const { ctx, updates } = makeCtx(store, reloadEgress);
    handleEgressDecision(ctx, { type: "egress_decision", action: "allow-once", host: "cdn.example.com", cardId: "c1" });

    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(true);
    expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual([]);
    expect(reloadEgress).not.toHaveBeenCalled();
    expect(updates).toContainEqual({ phase: "allowed-once" });
  });

  it("'deny' grants nothing and marks the card denied", () => {
    const { ctx, updates } = makeCtx(store, reloadEgress);
    handleEgressDecision(ctx, { type: "egress_decision", action: "deny", host: "cdn.example.com", cardId: "c1" });

    expect(isEgressHostAllowed("s1", "cdn.example.com")).toBe(false);
    expect(store.listHosts(EGRESS_GLOBAL_SCOPE)).toEqual([]);
    expect(reloadEgress).not.toHaveBeenCalled();
    expect(updates).toContainEqual({ phase: "denied" });
  });

  it("patches the recorded card in place (not the DB row) when the proposing turn is still in flight", () => {
    // A pending egress card recorded on an IN-FLIGHT turn, mirroring emitChatCard.
    // The decision must not be lost when that turn finalizes from recordedCards.
    const dbUpdates: unknown[] = [];
    const flushed: unknown[] = [];
    const runner = {
      running: true,
      emitMessage: vi.fn(),
      recordedCards: [
        { afterGroupIndex: 0, message: { role: "assistant", text: "", egressPrompt: { cardId: "c1", host: "cdn.example.com", phase: "pending" } } },
      ],
      chatMessageGroups: [{ text: "fetching a dependency", toolUse: [{}] }],
      steeredMessages: [],
    };
    const ctx = {
      getActiveAppSessionId: () => "s1",
      getRunnerRegistry: () => ({ get: () => runner }),
      getRunner: () => runner,
      send: vi.fn(),
      chatHistoryManager: {
        updateEgressPromptCard: (_s: string, _c: string, patch: unknown) => dbUpdates.push(patch),
        replaceInProgress: (_s: string, m: unknown) => flushed.push(m),
      },
      egressAllowlistStore: store,
      containerManager: { reloadEgress },
    } as never;

    handleEgressDecision(ctx, { type: "egress_decision", action: "allow-once", host: "cdn.example.com", cardId: "c1" });

    // In-flight → recorded card patched to the resolved phase, DB-row patch skipped.
    expect((runner.recordedCards[0].message as { egressPrompt?: { phase?: string } }).egressPrompt?.phase).toBe("allowed-once");
    expect(dbUpdates).toHaveLength(0);
    // ...and the patched in-progress set was flushed so a reload sees it.
    expect(flushed.length).toBeGreaterThan(0);
  });
});
