// eslint-disable-next-line no-restricted-imports -- useEffect: drives a Compose service start and port selection from store state (external system sync)
import { useEffect } from "react";
import {
  usePreviewStore,
  PREVIEW_LINK_INTENT_TTL_MS,
} from "../stores/preview-store.js";
import { useUiStore } from "../stores/ui-store.js";

/**
 * Drives an agent-authored preview pointer to the point where the panel can take
 * over (docs/258 req 12): start the named service if it isn't running, then
 * select its port.
 *
 * **Why this lives in `App`.** `start_service` is a WebSocket message and the
 * socket is held by `App`, which threads `send` down as props. A markdown link's
 * click handler is nowhere near it, and a module-level `send` singleton would be
 * a new global for one call site — so the click records a destination in the
 * store and this hook, mounted where the socket already is, acts on it.
 *
 * **The port must be reselected when the service reaches `running`.** This is
 * the part that does not fall out for free. Starting a service emits a
 * `preview_status` carrying only the ports currently running, and the client's
 * handler clears `selectedPort` when the selected one isn't among them. In a
 * session where service A is already running and the pointer targets stopped
 * service B, the panel would therefore stay on A after B starts — unless Compose
 * ordering happened to put B first. `selectedPort` is a view of the present,
 * never durable pending state, so the intent selects its own port explicitly.
 *
 * Navigating the slot itself belongs to `PreviewFrame`, which owns the iframe
 * pool; this hook stops once the right port is selected.
 */
export function usePreviewLinkIntent(
  sessionId: string | undefined,
  send: (data: unknown) => boolean,
): void {
  const intent = usePreviewStore((s) => s.previewLinkIntent);
  const services = usePreviewStore((s) => s.services);

  // eslint-disable-next-line no-restricted-syntax -- reacts to service status arriving over WS
  useEffect(() => {
    if (!intent) return;
    const store = usePreviewStore.getState();

    // The intent describes a destination in one session and means nothing in
    // another. `service_list` / `service_status` handlers ignore their own
    // `sessionId`, so this check cannot be delegated to them.
    if (!sessionId || intent.sessionId !== sessionId) {
      store.clearPreviewLinkIntent(intent.clickId);
      return;
    }

    // Not a failure detector — an expired intent is dropped silently. Without
    // it, a service that never starts would leave the destination armed, and
    // selecting that port by hand an hour later would yank the user to a place
    // they no longer remember asking for.
    if (Date.now() - intent.startedAt > PREVIEW_LINK_INTENT_TTL_MS) {
      store.clearPreviewLinkIntent(intent.clickId);
      return;
    }

    const service = services.find((s) => s.name === intent.service);
    if (!service) {
      // Declared at click time, gone now — the compose file changed under it.
      fail(store, intent.clickId, `This project declares no service named "${intent.service}".`);
      return;
    }

    if (service.status === "running") {
      store.setSelectedPort(intent.port);
      if (intent.phase !== "navigating") store.setPreviewLinkIntentPhase(intent.clickId, "navigating");
      return;
    }

    if (service.status === "error") {
      fail(store, intent.clickId, `Service "${intent.service}" failed to start.`);
      return;
    }

    // A boot is already in flight — from this intent or from the user. Waiting
    // rather than re-sending is the point: a click arriving during a start must
    // not queue a second one.
    if (service.status === "starting" || intent.phase === "starting") return;

    if (!send({ type: "start_service", name: intent.service })) {
      fail(store, intent.clickId, "That link can't be opened — this session isn't connected.");
      return;
    }
    store.setPreviewLinkIntentPhase(intent.clickId, "starting");
  }, [intent, services, sessionId, send]);
}

function fail(
  store: ReturnType<typeof usePreviewStore.getState>,
  clickId: number,
  message: string,
): void {
  store.clearPreviewLinkIntent(clickId);
  useUiStore.getState().setToast({ message, variant: "error" });
}
