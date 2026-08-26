import type { WsPreviewStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { isForeignSession } from "./session-scope.js";
import type { Handler } from "./types.js";

export const handlePreviewStatus: Handler<WsPreviewStatus> = (_ctx, data) => {
  const preview = usePreviewStore.getState();
  // Discard stale preview_status from a previous session's WS connection.
  // During session switching, React may batch a setLastMessage() from the
  // closing WS and process it after stores have been reset for the new session.
  // Shared with the service messages, which carry the same routing keys — and
  // strict about the no-active-session window, which is where a claim leaves
  // the store (see `isForeignSession`).
  if (isForeignSession(data.sessionId)) return;
  // `setStatus` re-derives `selectedPort` from the session's remembered target
  // (planning#478). It deliberately does NOT forget a choice whose port is
  // missing from this message: a service that is restarting, or a container
  // that was reclaimed while the session sat off screen, drops out of
  // `detectedPorts` for a while and comes back — and clearing here is what used
  // to hand the pane to whichever other service was up at that moment.
  preview.setStatus({
    running: data.running,
    port: data.port,
    url: data.url,
    source: data.source,
    detectedPorts: data.detectedPorts,
  });
  // Once the dev server is actually serving, complete the dev_server
  // step and then clear the startup-steps overlay so it doesn't sit on
  // top of the (now-running) iframe. Same intent as the service_status
  // handler below — covers the non-compose preview path (vite-detected).
  if (data.running) {
    const steps = usePreviewStore.getState().startupSteps;
    const devStep = steps.find((s) => s.stepId === "dev_server");
    if (devStep && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "complete" });
      // Re-checked on fire, like the `service_status` twin: a switch inside the
      // 800ms would otherwise clear the INCOMING session's overlay.
      setTimeout(() => {
        if (isForeignSession(data.sessionId)) return;
        usePreviewStore.getState().clearStartupSteps();
      }, 800);
    }
  }
};
