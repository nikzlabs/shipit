import { describe, it, expect } from "vitest";
import { START_PARAM_LABELS } from "./session-start-labels.js";

describe("START_PARAM_LABELS", () => {
  it("describes catalogue values by their names", () => {
    expect(START_PARAM_LABELS.agent.describe("codex")).toBe("Codex");
    expect(START_PARAM_LABELS.model.describe("claude-opus-5")).toBe("Opus 5");
    expect(START_PARAM_LABELS.billingMode.describe("sub")).toBe("Subscription");
    expect(START_PARAM_LABELS.permissionMode.describe("guarded")).toBe("Guarded");
  });

  it("falls back to the stored value when the catalogue no longer has it", () => {
    expect(START_PARAM_LABELS.model.describe("gone-model")).toBe("gone-model");
    expect(START_PARAM_LABELS.serviceId.describe("gone-service")).toBe("gone-service");
  });

  it("tells the three network modes apart, inherit included", () => {
    expect(START_PARAM_LABELS.networkMode.describe(true)).toBe("Contained");
    expect(START_PARAM_LABELS.networkMode.describe(false)).toBe("Open");
    expect(START_PARAM_LABELS.networkMode.describe(null)).toBe("Inherit global");
  });

  it("names SSH destinations through the caller's lookup", () => {
    const names = { sshHostLabel: (id: string) => (id === "h1" ? "prod" : undefined) };
    expect(START_PARAM_LABELS.sshHosts.describe(["h1", "h2"], names)).toBe("prod, h2");
    expect(START_PARAM_LABELS.sshHosts.describe([])).toBe("None");
  });
});
