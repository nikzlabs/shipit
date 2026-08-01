import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_INTERFACE_SDK_SOURCE } from "../../server/shared/agent-interface-sdk/bootstrap.js";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("window.shipit browser runtime", () => {
  it("handshakes, publishes visibility, and correlates an agent response", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const child = iframe.contentWindow as Window & {
      eval(source: string): unknown;
      MessageEvent: typeof MessageEvent;
      shipit?: {
        embedded: boolean;
        ready: Promise<void>;
        visibility: { current: boolean | null; subscribe(fn: (visible: boolean) => void): () => void };
        agent: { sendMessage(input: { text: string }): Promise<{ status: "submitted" }> };
      };
    };
    Object.defineProperty(child.document, "referrer", { value: window.location.href, configurable: true });
    const parentOrigin = window.location.origin;
    const parentPost = vi.spyOn(child.parent, "postMessage").mockImplementation(() => undefined);
    child.eval(AGENT_INTERFACE_SDK_SOURCE);

    expect(child.shipit?.embedded).toBe(false);
    expect(parentPost).toHaveBeenCalledWith(
      { source: "shipit-preview", type: "ready" },
      parentOrigin,
    );

    child.dispatchEvent(new child.MessageEvent("message", {
      source: child.parent,
      origin: parentOrigin,
      data: { source: "shipit-preview", type: "visibility", visible: true },
    }));
    await child.shipit?.ready;
    expect(child.shipit?.embedded).toBe(true);
    expect(child.shipit?.visibility.current).toBe(true);
    const listener = vi.fn();
    child.shipit?.visibility.subscribe(listener);
    expect(listener).toHaveBeenCalledWith(true);

    const sent = child.shipit!.agent.sendMessage({ text: "Build it" });
    await Promise.resolve();
    const request = parentPost.mock.calls.find(([message]) =>
      (message as { type?: string }).type === "agent_message")?.[0] as { requestId: string };
    expect(request.requestId).toBeTruthy();
    child.dispatchEvent(new child.MessageEvent("message", {
      source: child.parent,
      origin: parentOrigin,
      data: {
        source: "shipit-preview",
        type: "agent_message_result",
        requestId: request.requestId,
        ok: true,
        status: "submitted",
      },
    }));
    await expect(sent).resolves.toEqual({ status: "submitted" });
  });
});
