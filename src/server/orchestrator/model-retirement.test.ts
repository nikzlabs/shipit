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

  function pinRetired(selection: ModelSelection): void {
    expect(selectionExists(selection)).toBe(false);
    mgr.setModelSelection("s1", selection);
  }

  it("moves a session whose selected model no longer exists onto the successor", () => {
    pinRetired({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" });

    const model = applyModelRetirement(mgr, mgr.get("s1"), "codex");

    expect(model).toBe("gpt-5.6-sol");
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

    mgr.setModel("s1", "gpt-5.5-2025-01-01");
    expect(applyModelRetirement(mgr, mgr.get("s1"), "codex")).toBe("gpt-5.5-2025-01-01");

    mgr.track("s2");
    expect(applyModelRetirement(mgr, mgr.get("s2"), "codex")).toBeUndefined();
    expect(applyModelRetirement(mgr, null, "codex")).toBeUndefined();
  });

  it("moves nothing when the successor is unreachable from the session's harness", () => {
    pinRetired({ serviceId: "openai", billingMode: "sub", modelId: "gpt-5.6" });

    expect(applyModelRetirement(mgr, mgr.get("s1"), "claude")).toBe("gpt-5.6");
    expect(mgr.get("s1")?.model).toBe("gpt-5.6");
  });

  it("still runs the successor when the write fails", () => {
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
