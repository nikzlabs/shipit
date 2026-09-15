import { describe, it, expect } from "vitest";
import { allServices } from "../catalogue/index.js";
import type { BillingMode, ModelSelection } from "../catalogue/index.js";
import { bool, collection, enumOf, gitIdentity, modelSelection, numeric, text } from "./value-types.js";

function firstLiveSelection(): ModelSelection | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      const model = mode.models[0];
      if (model) return { serviceId: service.id, billingMode: mode.kind as BillingMode, modelId: model.id };
    }
  }
  return undefined;
}

function firstRetiredSelection(): ModelSelection | undefined {
  for (const service of allServices()) {
    for (const mode of service.modes) {
      const retired = mode.retired[0];
      if (retired) return { serviceId: service.id, billingMode: mode.kind as BillingMode, modelId: retired.id };
    }
  }
  return undefined;
}

describe("bool", () => {
  it("reads anything that is not a boolean as the declared default", () => {
    const type = bool({ default: true });
    expect(type.read(undefined)).toBe(true);
    expect(type.read("false")).toBe(true);
    expect(type.read(false)).toBe(false);
  });

  it("refuses a non-boolean write, naming the setting", () => {
    const result = bool({ default: false }).validate("yes", "Multi-agent sessions");
    expect(result).toEqual({ ok: false, message: "Multi-agent sessions must be true or false" });
  });
});

describe("enumOf", () => {
  const type = enumOf({
    default: "native",
    options: [
      { value: "native", label: "Native" },
      { value: "external", label: "External" },
    ],
  });

  it("reads an unknown member as the default and keeps a known one", () => {
    expect(type.read("gibberish")).toBe("native");
    expect(type.read("external")).toBe("external");
  });

  it("carries its options as the shape, so the detail view needs no second list", () => {
    expect(type.shape.options).toEqual([
      { value: "native", label: "Native" },
      { value: "external", label: "External" },
    ]);
  });

  it("refuses a value outside the option set", () => {
    expect(type.validate("webhook", "Delivery")).toEqual({
      ok: false,
      message: "Delivery must be one of: native, external",
    });
  });
});

describe("numeric", () => {
  // The memory budget's shape: null is "follow the host", and a value under 1 MB
  // is not a budget of nearly nothing but the same "not set".
  const budget = numeric({ default: null, nullable: true, unsetBelow: 1, integer: true, unit: "MB" });

  it("reads a stored value under the unset threshold as not set", () => {
    expect(budget.read(0)).toBeNull();
    expect(budget.read(0.4)).toBeNull();
    expect(budget.read(8192)).toBe(8192);
    expect(budget.read("8192")).toBeNull();
    expect(budget.read(Infinity)).toBeNull();
    expect(budget.read(NaN)).toBeNull();
  });

  it("stores nothing for null or a value under the threshold", () => {
    expect(budget.serialize(null)).toBeUndefined();
    expect(budget.serialize(0)).toBeUndefined();
    expect(budget.serialize(8192.7)).toBe(8192);
  });

  it("answers null for a value that means unset, because that is what the store keeps", () => {
    expect(budget.validate(null, "Memory budget")).toEqual({ ok: true, value: null });
    // Accepted, as the shipped route always accepted it — but answered as the
    // "not set" it becomes, so a caller showing the validated value shows the
    // change the write makes (docs/299-agent-settings-access req 4).
    expect(budget.validate(-1, "Memory budget")).toEqual({ ok: true, value: null });
    expect(budget.validate(0, "Memory budget")).toEqual({ ok: true, value: null });
    // Without a null to answer with there is no value the store would hold, so
    // the same input is a refusal rather than a silently dropped write.
    expect(numeric({ default: 512, unsetBelow: 1, unit: "MB" }).validate(0, "Slice")).toEqual({
      ok: false,
      message: "Slice must be at least 1 MB",
    });
    for (const nonsense of ["8192", Infinity, NaN]) {
      expect(budget.validate(nonsense, "Memory budget")).toEqual({
        ok: false,
        message: "Memory budget must be a number or null",
      });
    }
  });
});

describe("text", () => {
  it("refuses content over the declared length, in the words the setting chose", () => {
    const type = text({ maxLength: 50_000, noun: "System prompt" });
    expect(type.validate("x".repeat(50_001), "Your Instructions")).toEqual({
      ok: false,
      message: "System prompt is too long (max 50,000 characters)",
    });
    expect(type.validate("x".repeat(50_000), "Your Instructions").ok).toBe(true);
  });

  it("does not trim unless asked, so stored prose keeps its shape", () => {
    const untrimmed = text({ maxLength: 100 });
    expect(untrimmed.validate("  keep me  ", "Notes")).toEqual({ ok: true, value: "  keep me  " });
    const trimmed = text({ maxLength: 100, trim: true });
    expect(trimmed.validate("  keep me  ", "Notes")).toEqual({ ok: true, value: "keep me" });
  });

  it("refuses a required field that is blank after trimming", () => {
    const type = text({ maxLength: 200, noun: "Git user name", required: true, trim: true });
    expect(type.validate("   ", "Git identity")).toEqual({
      ok: false,
      message: "Git user name cannot be empty",
    });
  });

  it("reads a non-text value as the default, so null still clears an instructions box", () => {
    const type = text({ maxLength: 100 });
    expect(type.validate(null, "Your Instructions")).toEqual({ ok: true, value: "" });
    expect(type.validate(42, "Your Instructions")).toEqual({ ok: true, value: "" });
  });
});

describe("gitIdentity", () => {
  const type = gitIdentity();

  it("reads a missing identity as an empty pair", () => {
    expect(type.read(null)).toEqual({ name: "", email: "" });
    expect(type.read({ name: "Nik" })).toEqual({ name: "Nik", email: "" });
  });

  it("trims both halves and reports which one is wrong", () => {
    expect(type.validate({ name: " Nik ", email: " nik@example.com " }, "Git identity")).toEqual({
      ok: true,
      value: { name: "Nik", email: "nik@example.com" },
    });
    expect(type.validate({ name: "Nik", email: "" }, "Git identity")).toEqual({
      ok: false,
      message: "Git email cannot be empty",
    });
    expect(type.validate({ name: "x".repeat(201), email: "a@b.com" }, "Git identity")).toEqual({
      ok: false,
      message: "Git user name is too long (max 200 characters)",
    });
  });
});

describe("modelSelection", () => {
  const type = modelSelection();

  it("keeps a retired pin on read, so the resolver can follow its successor", () => {
    const retired = firstRetiredSelection();
    if (!retired) return;
    expect(type.read(retired)).toEqual(retired);
  });

  it("reads a selection the catalogue never had as not set", () => {
    expect(type.read({ serviceId: "nope", billingMode: "key", modelId: "nope" })).toBeNull();
    expect(type.read(undefined)).toBeNull();
  });

  it("accepts null and a live selection, and refuses one the catalogue does not have", () => {
    expect(type.validate(null, "Background work")).toEqual({ ok: true, value: null });
    const live = firstLiveSelection();
    if (live) expect(type.validate(live, "Background work").ok).toBe(true);
    expect(type.validate({ serviceId: "nope", billingMode: "key", modelId: "gone" }, "Background work"))
      .toEqual({ ok: false, message: "No catalogue entry for nope/key/gone" });
  });

  it("stores nothing for a cleared pin", () => {
    expect(type.serialize(null)).toBeUndefined();
  });
});

describe("collection", () => {
  it("refuses a whole-list write and names the operations instead", () => {
    const type = collection({ operations: ["add", "remove"], patchableFields: ["enabled"] });
    expect(type.validate([{ enabled: true }], "MCP servers")).toEqual({
      ok: false,
      message:
        "MCP servers is a collection: change one item at a time with add, remove, "
        + "never by replacing the list",
    });
  });
});
