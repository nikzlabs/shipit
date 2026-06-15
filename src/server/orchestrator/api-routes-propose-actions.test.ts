import { describe, it, expect } from "vitest";
import { validateProposeActions, MAX_ACTIONS } from "./api-routes-propose-actions.js";

/**
 * docs/207 / SHI-153 — input validation for the `propose_actions` payload. The
 * pure validator is shared semantics for both the tool's fail-fast pre-check and
 * the authoritative route, so it carries the contract: 1–5 actions, unique
 * non-empty ids, non-empty labels/payloads, length caps, deterministic order.
 */
describe("validateProposeActions", () => {
  const action = (over: Partial<{ id: string; label: string; payload: string }> = {}) => ({
    id: "a1",
    label: "Open a PR",
    payload: "Open a PR for this change.",
    ...over,
  });

  it("accepts a well-formed single action and preserves order + optional fields", () => {
    const result = validateProposeActions({
      title: "  Optional follow-ups  ",
      actions: [
        { id: "a1", label: "Open a PR", description: "  from branch ", defaultChecked: true, payload: " do it " },
      ],
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.title).toBe("Optional follow-ups");
    expect(result.actions).toEqual([
      { id: "a1", label: "Open a PR", payload: "do it", description: "from branch", defaultChecked: true },
    ]);
  });

  it("keeps multiple actions in input order", () => {
    const result = validateProposeActions({
      actions: [action({ id: "x" }), action({ id: "y" }), action({ id: "z" })],
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.actions.map((a) => a.id)).toEqual(["x", "y", "z"]);
  });

  it("omits title when absent or blank", () => {
    const r1 = validateProposeActions({ actions: [action()] });
    const r2 = validateProposeActions({ title: "   ", actions: [action()] });
    if ("error" in r1 || "error" in r2) throw new Error("unexpected error");
    expect(r1.title).toBeUndefined();
    expect(r2.title).toBeUndefined();
  });

  it("rejects an empty or missing actions array", () => {
    expect("error" in validateProposeActions({})).toBe(true);
    expect("error" in validateProposeActions({ actions: [] })).toBe(true);
    expect("error" in validateProposeActions({ actions: "nope" })).toBe(true);
  });

  it(`rejects more than ${MAX_ACTIONS} actions`, () => {
    const many = Array.from({ length: MAX_ACTIONS + 1 }, (_, i) => action({ id: `a${i}` }));
    const result = validateProposeActions({ actions: many });
    expect("error" in result).toBe(true);
  });

  it("rejects duplicate ids", () => {
    const result = validateProposeActions({ actions: [action({ id: "dup" }), action({ id: "dup" })] });
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/Duplicate action id/);
  });

  it("rejects a missing/blank id, label, or payload", () => {
    expect("error" in validateProposeActions({ actions: [action({ id: "  " })] })).toBe(true);
    expect("error" in validateProposeActions({ actions: [action({ label: "" })] })).toBe(true);
    expect("error" in validateProposeActions({ actions: [action({ payload: "   " })] })).toBe(true);
  });

  it("rejects over-length fields", () => {
    const long = "x".repeat(5000);
    expect("error" in validateProposeActions({ actions: [action({ payload: long })] })).toBe(true);
    expect("error" in validateProposeActions({ actions: [action({ label: long })] })).toBe(true);
  });

  it("ignores a non-string description rather than throwing", () => {
    const result = validateProposeActions({
      actions: [{ id: "a1", label: "L", payload: "P", description: 42 }],
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.actions[0].description).toBeUndefined();
  });
});
