import { describe, expect, it } from "vitest";
import {
  AGENT_INTERFACE_MAX_TEXT_LENGTH,
  isAgentInterfaceRequest,
} from "./protocol.js";

const request = (text: string): unknown => ({
  source: "shipit-preview",
  type: "agent_message",
  requestId: "request-1",
  payload: { text },
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
