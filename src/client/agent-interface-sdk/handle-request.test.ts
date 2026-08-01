import { describe, expect, it, vi } from "vitest";
import { handleAgentInterfaceRequest } from "./handle-request.js";

function setup(origin = "https://preview.example") {
  const postMessage = vi.fn();
  const contentWindow = { postMessage } as unknown as Window;
  const iframe = document.createElement("iframe");
  Object.defineProperty(iframe, "contentWindow", { value: contentWindow });
  const event = new MessageEvent("message", {
    origin,
    source: contentWindow,
    data: {
      source: "shipit-preview",
      type: "agent_message",
      requestId: "request-1",
      payload: { text: "Build it" },
    },
  });
  return { iframe, event, postMessage };
}

describe("handleAgentInterfaceRequest", () => {
  it("dispatches host-owned provenance and replies to the same frame", async () => {
    const { iframe, event, postMessage } = setup();
    const dispatch = vi.fn().mockResolvedValue(undefined);
    expect(await handleAgentInterfaceRequest({
      event,
      iframe,
      expectedOrigin: "https://preview.example",
      surface: "preview",
      dispatch,
    })).toBe(true);
    expect(dispatch).toHaveBeenCalledWith("Build it", {
      source: "agent_interface_sdk",
      surface: "preview",
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "agent_message_result",
      requestId: "request-1",
      ok: true,
    }), "https://preview.example");
  });

  it("rejects a mismatched origin without dispatching", async () => {
    const { iframe, event, postMessage } = setup("https://navigated.example");
    const dispatch = vi.fn();
    expect(await handleAgentInterfaceRequest({
      event,
      iframe,
      expectedOrigin: "https://preview.example",
      surface: "preview",
      dispatch,
    })).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("returns a sanitized correlated failure", async () => {
    const { iframe, event, postMessage } = setup();
    const dispatch = vi.fn().mockRejectedValue(new Error("Trust this repository"));
    await handleAgentInterfaceRequest({
      event,
      iframe,
      expectedOrigin: "https://preview.example",
      surface: "present",
      dispatch,
    });
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: "Trust this repository",
    }), "https://preview.example");
  });
});
