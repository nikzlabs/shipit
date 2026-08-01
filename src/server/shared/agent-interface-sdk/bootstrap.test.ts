import { describe, expect, it } from "vitest";
import {
  AGENT_INTERFACE_SDK_MARKER,
  AGENT_INTERFACE_SDK_SCRIPT,
  AGENT_INTERFACE_SDK_SOURCE,
} from "./bootstrap.js";

describe("Agent Interface SDK bootstrap", () => {
  it("serializes as standalone browser JavaScript", () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- syntax-check the exact serialized script injected into child documents
    expect(() => new Function(AGENT_INTERFACE_SDK_SOURCE)).not.toThrow();
  });

  it("carries a stable exactly-once marker", () => {
    expect(AGENT_INTERFACE_SDK_SCRIPT).toContain(AGENT_INTERFACE_SDK_MARKER);
    expect(AGENT_INTERFACE_SDK_SCRIPT.match(new RegExp(AGENT_INTERFACE_SDK_MARKER, "g"))).toHaveLength(1);
  });

  it("uses the immediate parent and never window.top", () => {
    expect(AGENT_INTERFACE_SDK_SOURCE).toContain("window.parent");
    expect(AGENT_INTERFACE_SDK_SOURCE).not.toContain("window.top");
  });
});
