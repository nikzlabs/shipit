// eslint-disable-next-line no-restricted-imports -- useEffect: drives a Compose service start and port selection from store state (external system sync)
import { useEffect, useRef } from "react";
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
  /**
   * Services this feature has asked to start, by name — the one durable fact
   * the flow needs, and the thing that tells req 12's case apart from req 10's:
   * a service sitting in `error` that we have NOT asked about is simply not
   * running (so start it), while one that reaches `error` after our request is
   * a start that failed (so report it).
   *
   * A ref rather than a field on the intent, deliberately. Writing it to the
   * store would re-run this effect with the service status unchanged — still
   * `stopped`, because the server has not answered yet — and the "did it take?"
   * branch would fire against its own write every single time. It also survives
   * a second click replacing the intent, which is what stops two rapid clicks
   * on one stopped service from sending two starts.
   */
  const startRequested = useRef<Set<string>>(new Set());

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
      startRequested.current.delete(service.name);
      store.setSelectedPort(intent.port);
      return;
    }

    // A boot is in flight — ours or the user's. Waiting rather than re-sending
    // is the point: a click arriving during a start must not queue a second one.
    if (service.status === "starting") return;

    // `stopped` and `error` both mean "not running", and req 12 says a pointer
    // to a service that is not running starts it — including one sitting in
    // `error` from an earlier attempt of its own. Refusing that would leave the
    // user holding a link that can never work again.
    if (!startRequested.current.has(service.name)) {
      if (!send({ type: "start_service", name: intent.service })) {
        fail(store, intent.clickId, "That link can't be opened — this session isn't connected.");
        return;
      }
      startRequested.current.add(service.name);
      return;
    }

    // We asked, and it is not running. `error` is a definite verdict, so it is
    // reported (req 10). `stopped` is not: it is also what the service reads as
    // in the moment before the server answers, and a start that quietly never
    // takes is the undetectable class req 10 is best-effort about. The intent's
    // TTL clears that case rather than a timeout built to preserve a phrase.
    if (service.status === "error") {
      startRequested.current.delete(service.name);
      fail(store, intent.clickId, `Service "${intent.service}" failed to start.`);
    }
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
