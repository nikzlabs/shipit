/**
 * docs/252 phase 8 — a session pinned to a model the catalogue has retired
 * keeps working (req 13).
 *
 * The shipped catalogue declares one retirement, `gpt-5.6 → gpt-5.6-sol` under
 * both OpenAI modes, and these tests use it: a session is put on `gpt-5.6`,
 * which `selectionExists` reports false for, and must come back running the
 * successor with the row updated to match.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseManager } from "../shared/database.js";
import { SessionManager } from "./sessions.js";
import { applyModelRetirement } from "./model-retirement.js";
import { selectionExists, type ModelSelection } from "../shared/catalogue/index.js";

describe("applyModelRetirement", () => {
  let dbManager: DatabaseManager;
  let mgr: SessionManager;

  beforeEach(() => {
    dbManager = new DatabaseManager(":memory:");
    mgr = new SessionManager(dbManager);
    mgr.track("s1");
  });

  afterEach(() => {
    dbManager.close();
  });

  /**
   * Write a triple the catalogue no longer contains — which is exactly what a
   * row written *before* the retirement holds, and the only way to produce one
   * now that every write path refuses to invent an unresolvable triple.
   */
  function pinRetired(selection: ModelSelection): void {
    expect(selectionExists(selection)).toBe(false);
    mgr.setModelSelection("s1", selection);
  }

  it("moves a session whose selected model no longer exists onto the successor", () => {
    pinRetired({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" });

    const model = applyModelRetirement(mgr, mgr.get("s1"), "codex");

    expect(model).toBe("gpt-5.6-sol");
    // …and the move is WRITTEN THROUGH, not applied at read time. This is the
    // half the shim it generalizes never did: the picker gives the persisted
    // model precedence over the live one the CLI reports, so a read-time remap
    // would run the successor while displaying the retired id (reqs 11, 13).
    const session = mgr.get("s1");
    expect(session?.model).toBe("gpt-5.6-sol");
    expect(session?.serviceId).toBe("openai");
    expect(session?.billingMode).toBe("sub");
  });

  it("keeps the billing mode, so included work never becomes billed work", () => {
    pinRetired({ serviceId: "openai", billingMode: "key", modelId: "gpt-5.6" });

    expect(applyModelRetirement(mgr, mgr.get("s1"), "codex")).toBe("gpt-5.6-sol");
    expect(mgr.get("s1")?.billingMode).toBe("key");
  });

  it("keeps the pinned credential route, because its owner has not changed", () => {
    // The successor is in the same `(service, mode)` by construction, so the
    // route still fits. Dropping it would re-pin the session onto whatever
    // account the next turn resolves — a cost with nothing to buy it.
    pinRetired({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" });
    mgr.setProviderRoute("s1", "account", "acct_1");

    applyModelRetirement(mgr, mgr.get("s1"), "codex");

    expect(mgr.get("s1")?.providerRouteId).toBe("acct_1");
  });

  it("resolves a legacy row that carries the bare id and no service", () => {
    dbManager.db
      .prepare("UPDATE sessions SET model = ?, service_id = NULL, billing_mode = NULL WHERE id = ?")
      .run("gpt-5.6", "s1");

    expect(applyModelRetirement(mgr, mgr.get("s1"), "codex")).toBe("gpt-5.6-sol");
    expect(mgr.get("s1")?.serviceId).toBe("openai");
  });

  it("is a no-op for a current model, an unknown model, and no model at all", () => {
    mgr.setModel("s1", "gpt-5.6-sol");
    expect(applyModelRetirement(mgr, mgr.get("s1"), "codex")).toBe("gpt-5.6-sol");

    // A versioned slug the picker never surfaced. Nothing retired it, so there
    // is no successor to move to and the session keeps what it has.
    mgr.setModel("s1", "gpt-5.5-2025-01-01");
    expect(applyModelRetirement(mgr, mgr.get("s1"), "codex")).toBe("gpt-5.5-2025-01-01");

    mgr.track("s2");
    expect(applyModelRetirement(mgr, mgr.get("s2"), "codex")).toBeUndefined();
    expect(applyModelRetirement(mgr, null, "codex")).toBeUndefined();
  });

  it("moves nothing when the successor is unreachable from the session's harness", () => {
    // A successor must be runnable on the session's pinned harness (req 13).
    // Claude Code speaks `anthropic-messages` and OpenAI's retirement is
    // declared under `openai-responses`, so there is nothing to move to — and a
    // retirement with no successor for a harness is a catalogue mistake to fix,
    // not a case to fall back from. This resolver declines to guess.
    //
    // Scoped to THIS function on purpose: downstream, WS connect still replaces
    // a model the harness cannot list with its first one, exactly as it does for
    // any alias or versioned slug. That is pre-existing behaviour phase 8 does
    // not change, so "moves nothing" is the claim here, not "nothing moves".
    pinRetired({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" });

    expect(applyModelRetirement(mgr, mgr.get("s1"), "claude")).toBe("gpt-5.6");
    expect(mgr.get("s1")?.model).toBe("gpt-5.6");
  });

  it("still runs the successor when the write fails", () => {
    // A failed persist is not a reason to spawn a model the service has
    // retired. The turn runs; the row is retried on the next read.
    const failing = {
      setModelSelection: vi.fn(() => {
        throw new Error("database is closed");
      }),
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const model = applyModelRetirement(
      failing,
      { id: "s1", model: "gpt-5.6", serviceId: "openai", billingMode: "sub" },
      "codex",
    );

    expect(model).toBe("gpt-5.6-sol");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("writes only when something actually moved", () => {
    const writer = { setModelSelection: vi.fn() };
    applyModelRetirement(
      writer,
      { id: "s1", model: "gpt-5.6-sol", serviceId: "openai", billingMode: "sub" },
      "codex",
    );
    expect(writer.setModelSelection).not.toHaveBeenCalled();
  });
});
