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
    // The page navigated within the preview, so the referrer is its OWN origin rather
    // than the host's. The handshake must not depend on it.
    Object.defineProperty(child.document, "referrer", { value: "https://session--3001.example.test/app", configurable: true });
    const parentOrigin = window.location.origin;
    const parentPost = vi.spyOn(child.parent, "postMessage").mockImplementation(() => undefined);
    child.eval(AGENT_INTERFACE_SDK_SOURCE);

    expect(child.shipit?.embedded).toBe(false);
    // The handshake carries no page data and the host origin is not yet known.
    expect(parentPost).toHaveBeenCalledWith({ source: "shipit-preview", type: "ready" }, "*");

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
    const agentCall = parentPost.mock.calls.find(([message]) =>
      (message as { type?: string }).type === "agent_message");
    const request = agentCall?.[0] as { requestId: string };
    expect(request.requestId).toBeTruthy();
    // Page-composed text goes to the origin the host proved, never to "*".
    expect(agentCall?.[1]).toBe(parentOrigin);
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

  it("pins the host origin after the first handshake message", async () => {
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const child = iframe.contentWindow as Window & {
      eval(source: string): unknown;
      MessageEvent: typeof MessageEvent;
      shipit?: { visibility: { current: boolean | null } };
    };
    vi.spyOn(child.parent, "postMessage").mockImplementation(() => undefined);
    child.eval(AGENT_INTERFACE_SDK_SOURCE);

    const post = (origin: string, visible: boolean) => child.dispatchEvent(new child.MessageEvent("message", {
      source: child.parent,
      origin,
      data: { source: "shipit-preview", type: "visibility", visible },
    }));

    post(window.location.origin, true);
    expect(child.shipit?.visibility.current).toBe(true);
    // A later message claiming a different origin cannot move the pinned host.
    post("https://attacker.example", false);
    expect(child.shipit?.visibility.current).toBe(true);
  });
});
