import { describe, expect, it } from "vitest";
import {
  AGENT_INTERFACE_MAX_TEXT_LENGTH,
  isAgentInterfaceRequest,
  formatAgentInterfacePrompt,
} from "./protocol.js";

const request = (text: string): unknown => ({
  source: "shipit-preview",
  type: "agent_message",
  requestId: "request-1",
  payload: { text },
});

describe("formatAgentInterfacePrompt", () => {
  it("identifies automatic Preview SDK input and preserves the authored text", () => {
    const result = formatAgentInterfacePrompt("Run the selected audit", {
      source: "agent_interface_sdk",
      surface: "preview",
    });
    expect(result).toContain("Agent Interface SDK message from the active Preview surface");
    expect(result).toContain("may have been invoked automatically");
    expect(result).toContain("<agent-interface-message>\nRun the selected audit\n</agent-interface-message>");
  });
});

describe("isAgentInterfaceRequest", () => {
  it("accepts a valid SDK message", () => {
    expect(isAgentInterfaceRequest(request("Build the selected report"))).toBe(true);
  });

  it.each(["", "   "])("rejects empty text %#", (text) => {
    expect(isAgentInterfaceRequest(request(text))).toBe(false);
  });

  it("rejects oversized text", () => {
    expect(isAgentInterfaceRequest(request("x".repeat(AGENT_INTERFACE_MAX_TEXT_LENGTH + 1)))).toBe(false);
  });

  it("rejects malformed envelopes", () => {
    expect(isAgentInterfaceRequest({ ...request("hello") as object, source: "other" })).toBe(false);
    expect(isAgentInterfaceRequest({ ...request("hello") as object, requestId: "" })).toBe(false);
    expect(isAgentInterfaceRequest({ source: "shipit-preview", type: "agent_message" })).toBe(false);
  });
});
