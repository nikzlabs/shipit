// @vitest-environment jsdom

/**
 * An embedded service is not the active ShipIt surface
 * (docs/313-embedded-preview-services req 7).
 *
 * The SDK takes `window.parent` as its host. For a top-level previewed page that
 * is the ShipIt page; for a service framed inside another service's page it is
 * the **embedding page**, which never sends the `visibility` message the
 * handshake waits on. So the embed never reports itself as embedded in ShipIt
 * and `sendMessage` — which awaits that handshake — never reaches the agent.
 *
 * Nothing in the SDK detects nesting on purpose, and it must not start: under
 * the dogfood loop an inner ShipIt is itself framed, so a legitimately top-level
 * previewed page inside it has `parent !== top`.
 */

import { describe, expect, it } from "vitest";
import { AGENT_INTERFACE_SDK_SOURCE } from "./bootstrap.js";

interface PageSdk {
  embedded: boolean;
  ready: Promise<void>;
  agent: { sendMessage(input: { text: string }): Promise<unknown> };
}

function installInNestedFrame(): { sdk: PageSdk; posted: unknown[] } {
  const posted: unknown[] = [];
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);

  const inner = frame.contentWindow as Window & { shipit?: PageSdk };
  // The embedding page: it receives the handshake and, being an ordinary app,
  // does nothing with it.
  Object.defineProperty(inner, "parent", {
    configurable: true,
    value: { postMessage: (message: unknown) => posted.push(message) },
  });

  const doc = frame.contentDocument!;
  const script = doc.createElement("script");
  script.textContent = AGENT_INTERFACE_SDK_SOURCE;
  doc.head.appendChild(script);

  return { sdk: inner.shipit!, posted };
}

describe("the SDK inside an embedded service", () => {
  it("does not report itself as embedded in ShipIt", () => {
    const { sdk, posted } = installInNestedFrame();

    expect(sdk).toBeTypeOf("object");
    expect(sdk.embedded).toBe(false);
    expect(posted).toEqual([{ source: "shipit-preview", type: "ready" }]);
  });

  it("sends nothing to the agent, because the handshake never completes", async () => {
    const { sdk, posted } = installInNestedFrame();
    posted.length = 0;

    void sdk.agent.sendMessage({ text: "start a release" }).catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(posted).toEqual([]);
  });
});
