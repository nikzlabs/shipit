/**
 * Browser runtime shared by proxied Preview pages and rendered Present HTML.
 * Keep this function dependency-free: its serialized body executes in the
 * child document, outside the ShipIt bundle.
 */
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

  let parentOrigin: string | null = null;
  try {
    parentOrigin = document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    parentOrigin = null;
  }

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
    if (event.source !== hostWindow || !parentOrigin || event.origin !== parentOrigin) return;
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
        if (!parentOrigin) throw new Error("ShipIt parent origin is unavailable");
        const requestId = crypto.randomUUID();
        return await new Promise<{ status: "submitted" }>((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pending.delete(requestId);
            reject(new Error("ShipIt agent message timed out"));
          }, 30_000);
          pending.set(requestId, { resolve, reject, timeout });
          hostWindow.postMessage({
            source,
            type: "agent_message",
            requestId,
            payload: { text: input.text },
          }, parentOrigin);
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

  if (hostWindow === window || !parentOrigin) {
    window.clearTimeout(timeout);
    failHandshake("This page is not embedded in ShipIt");
    return;
  }
  hostWindow.postMessage({ source, type: "ready" }, parentOrigin);
}

export const AGENT_INTERFACE_SDK_MARKER = "data-shipit-agent-interface-sdk";
export const AGENT_INTERFACE_SDK_SOURCE = `(${installShipItPageSdk.toString()})();`;
export const AGENT_INTERFACE_SDK_SCRIPT = `<script ${AGENT_INTERFACE_SDK_MARKER}>${AGENT_INTERFACE_SDK_SOURCE}</script>`;
