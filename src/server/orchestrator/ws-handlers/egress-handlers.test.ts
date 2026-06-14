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
});
