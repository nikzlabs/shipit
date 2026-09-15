import { describe, it, expect } from "vitest";
import {
  MAX_NEEDS_YOU_ITEMS,
  MAX_NEEDS_YOU_LEN,
  MAX_STATUS_LEN,
  validateSessionStatus,
} from "./session-status-validation.js";

const stored = { hasStoredCard: true };
const fresh = { hasStoredCard: false };

const item = (over: Record<string, unknown> = {}) => ({
  id: "wire-webhook",
  label: "Wire the Stripe webhook",
  payload: "Add the webhook route described in docs/303-session-status-card/plan.md.",
  ...over,
});

describe("validateSessionStatus", () => {
  it("accepts a bare call on a session that has a card", () => {
    expect(validateSessionStatus({}, stored)).toEqual({});
  });

  it("refuses a call that would leave a session with no status at all", () => {
    const result = validateSessionStatus({ needsYou: ["Add the key."] }, fresh);
    expect(result).toEqual({ error: expect.stringContaining("`status` is required") });
  });

  it("takes the first status on a session that has no card", () => {
    expect(validateSessionStatus({ status: "Routes done." }, fresh)).toEqual({
      status: "Routes done.",
    });
  });

  it("treats an empty needsYou list as a clear and an omitted one as unchanged", () => {
    expect(validateSessionStatus({ needsYou: [] }, stored)).toEqual({ needsYou: [] });
    expect(validateSessionStatus({ status: "Done." }, stored)).toEqual({ status: "Done." });
  });

  it("takes needsYou as a list of entries, trimmed, and refuses a bare string", () => {
    expect(validateSessionStatus({ needsYou: [" Add the key. ", "Merge #212."] }, stored)).toEqual({
      needsYou: ["Add the key.", "Merge #212."],
    });
    expect(validateSessionStatus({ needsYou: "Add the key." }, stored)).toEqual({
      error: expect.stringContaining("list of strings"),
    });
    expect(validateSessionStatus({ needsYou: ["Add the key.", "  "] }, stored)).toEqual({
      error: expect.stringContaining("cannot be empty"),
    });
    expect(validateSessionStatus({ needsYou: [7] }, stored)).toEqual({
      error: expect.stringContaining("must be a string"),
    });
  });

  it("caps how many things the card can put on the user", () => {
    expect(validateSessionStatus({ needsYou: Array(MAX_NEEDS_YOU_ITEMS + 1).fill("Do it") }, stored))
      .toEqual({ error: expect.stringContaining(`the cap is ${MAX_NEEDS_YOU_ITEMS}`) });
  });

  it("takes a status long enough to carry a markdown list (req 27)", () => {
    const markdown = "Billing service:\n\n- routes and tests done\n- PR #212 ready to merge\n- webhook not started";
    expect(validateSessionStatus({ status: markdown }, stored)).toEqual({ status: markdown });
  });

  it("refuses an empty status rather than reading it as a clear", () => {
    expect(validateSessionStatus({ status: "   " }, stored)).toEqual({
      error: expect.stringContaining("non-empty"),
    });
  });

  it("caps the two fields", () => {
    expect(validateSessionStatus({ status: "s".repeat(MAX_STATUS_LEN + 1) }, stored)).toEqual({
      error: expect.stringContaining(`the cap is ${MAX_STATUS_LEN}`),
    });
    expect(validateSessionStatus({ needsYou: ["n".repeat(MAX_NEEDS_YOU_LEN + 1)] }, stored)).toEqual({
      error: expect.stringContaining(`the cap is ${MAX_NEEDS_YOU_LEN}`),
    });
    expect(validateSessionStatus({ status: "s".repeat(MAX_STATUS_LEN) }, stored)).toEqual({
      status: "s".repeat(MAX_STATUS_LEN),
    });
  });

  it("refuses a non-string field", () => {
    expect(validateSessionStatus({ status: 7 }, stored)).toEqual({ error: expect.any(String) });
    expect(validateSessionStatus({ needsYou: null }, stored)).toEqual({ error: expect.any(String) });
    expect(validateSessionStatus({ replaceActions: "yes" }, stored)).toEqual({
      error: expect.any(String),
    });
  });

  it("clears the offers only with replaceActions", () => {
    expect(validateSessionStatus({ actions: [] }, stored)).toEqual({
      error: expect.stringContaining("replaceActions"),
    });
    expect(validateSessionStatus({ actions: [], replaceActions: true }, stored)).toEqual({
      actions: [],
      replaceActions: true,
    });
  });

  it("validates items through the shared item validator", () => {
    expect(validateSessionStatus({ actions: [item({ label: "" })] }, stored)).toEqual({
      error: expect.stringContaining("label is required"),
    });
    expect(validateSessionStatus({ actions: [item(), item()] }, stored)).toEqual({
      error: expect.stringContaining("Duplicate action id"),
    });
    expect(validateSessionStatus({ actions: [item({ payload: "p".repeat(4001) })] }, stored)).toEqual({
      error: expect.stringContaining("call session_status again"),
    });
    expect(validateSessionStatus({ actions: "nope" }, stored)).toEqual({
      error: expect.stringContaining("must be an array"),
    });
  });

  it("offers no count cap, because the card shows every relevant action", () => {
    const many = Array.from({ length: 12 }, (_, i) => item({ id: `offer-${i}` }));
    const result = validateSessionStatus({ actions: many }, stored);
    expect("error" in result ? result.error : result.actions).toHaveLength(12);
  });

  it("keeps the optional item fields", () => {
    const result = validateSessionStatus(
      { actions: [item({ description: "Why", defaultChecked: true })] },
      stored,
    );
    expect(result).toEqual({
      actions: [expect.objectContaining({ description: "Why", defaultChecked: true })],
    });
  });
});
