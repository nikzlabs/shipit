// Keep dependency-free: the serialized body runs outside the ShipIt bundle.
function installShipItPageSdk(): void {
  const hostWindow = window.parent;
  const source = "shipit-preview";
  const timeoutMs = 5_000;
  const existing = (window as Window & { shipit?: unknown }).shipit;
  if (existing) return;

  let embedded = false;
  let currentVisibility: boolean | null = null;
  let settleReady: (() => void) | undefined;
  let rejectReady: ((reason: Error) => void) | undefined;
  const listeners = new Set<(visible: boolean) => void>();
  const pending = new Map<string, {
    resolve: (result: { status: "submitted" }) => void;
    reject: (reason: Error) => void;
    timeout: number;
  }>();

  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  // Learn from the host: document.referrer may be the preview after navigation.
  let parentOrigin: string | null = null;

  // The empty handshake and opaque origins require "*"; otherwise pin the host origin.
  const postToHost = (message: unknown) => {
    hostWindow.postMessage(message, parentOrigin && parentOrigin !== "null" ? parentOrigin : "*");
  };

  const failHandshake = (message: string) => {
    if (embedded) return;
    rejectReady?.(new Error(message));
    rejectReady = undefined;
    settleReady = undefined;
  };

  const timeout = window.setTimeout(() => {
    failHandshake("ShipIt host handshake timed out");
  }, timeoutMs);

  const onMessage = (event: MessageEvent) => {
    if (event.source !== hostWindow) return;
    const data = event.data as {
      source?: unknown;
      type?: unknown;
      visible?: unknown;
      requestId?: unknown;
      ok?: unknown;
      status?: unknown;
      error?: unknown;
    } | null;
    if (data?.source !== source) return;
    if (parentOrigin === null) parentOrigin = event.origin;
    else if (event.origin !== parentOrigin) return;

    if (data.type === "visibility" && typeof data.visible === "boolean") {
      currentVisibility = data.visible;
      if (!embedded) {
        embedded = true;
        window.clearTimeout(timeout);
        settleReady?.();
        settleReady = undefined;
        rejectReady = undefined;
      }
      for (const listener of listeners) listener(data.visible);
      return;
    }

    if (data.type !== "agent_message_result" || typeof data.requestId !== "string") return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    window.clearTimeout(request.timeout);
    if (data.ok === true && data.status === "submitted") {
      request.resolve({ status: "submitted" });
    } else {
      request.reject(new Error(typeof data.error === "string" ? data.error : "ShipIt rejected the message"));
    }
  };
  window.addEventListener("message", onMessage);

  const sdk = {
    get embedded() { return embedded; },
    ready,
    visibility: {
      get current() { return currentVisibility; },
      subscribe(listener: (visible: boolean) => void) {
        listeners.add(listener);
        if (currentVisibility !== null) listener(currentVisibility);
        return () => listeners.delete(listener);
      },
    },
    agent: {
      async sendMessage(input: { text: string }) {
        if (!input || typeof input.text !== "string" || input.text.trim().length === 0) {
          throw new Error("ShipIt agent messages require non-empty text");
        }
        if (input.text.length > 50_000) {
          throw new Error("ShipIt agent messages cannot exceed 50000 characters");
        }
        await ready;
        const requestId = crypto.randomUUID();
        return await new Promise<{ status: "submitted" }>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("ShipIt agent message timed out"));
          }, 30_000);
          pending.set(requestId, { resolve, reject, timeout });
          postToHost({
            source,
            type: "agent_message",
            requestId,
            payload: { text: input.text },
          });
        });
      },
    },
  };

  Object.defineProperty(window, "shipit", {
    value: sdk,
    configurable: false,
    enumerable: true,
    writable: false,
  });

  if (hostWindow === window) {
    window.clearTimeout(timeout);
    failHandshake("This page is not embedded in ShipIt");
    return;
  }
  postToHost({ source, type: "ready" });
}

export const AGENT_INTERFACE_SDK_MARKER = "data-shipit-agent-interface-sdk";

// tsx keepNames inserts __name calls, but toString omits the module-level helper.
export const AGENT_INTERFACE_SDK_SOURCE =
  `(function(){var __name=function(value){return value};(${installShipItPageSdk.toString()})()})();`;
export const AGENT_INTERFACE_SDK_SCRIPT = `<script ${AGENT_INTERFACE_SDK_MARKER}>${AGENT_INTERFACE_SDK_SOURCE}</script>`;
