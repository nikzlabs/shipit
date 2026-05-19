import type { WsPreviewStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handlePreviewStatus: Handler<WsPreviewStatus> = (_ctx, data) => {
  const preview = usePreviewStore.getState();
  // Discard stale preview_status from a previous session's WS connection.
  // During session switching, React may batch a setLastMessage() from the
  // closing WS and process it after stores have been reset for the new session.
  const currentSessionId = useSessionStore.getState().sessionId;
  if (data.sessionId && currentSessionId && data.sessionId !== currentSessionId) {
    return;
  }
  preview.setStatus({
    running: data.running,
    port: data.port,
    url: data.url,
    source: data.source,
    detectedPorts: data.detectedPorts,
  });
  const currentPort = usePreviewStore.getState().selectedPort;
  if (currentPort !== null) {
    const allAvailable = [...(data.detectedPorts ?? [])];
    if (data.source === "vite" || data.source === "managed") allAvailable.push(data.port);
    if (!allAvailable.includes(currentPort)) {
      preview.setSelectedPort(null);
    }
  }
  // Once the dev server is actually serving, complete the dev_server
  // step and then clear the startup-steps overlay so it doesn't sit on
  // top of the (now-running) iframe. Same intent as the service_status
  // handler below — covers the non-compose preview path (vite-detected).
  if (data.running) {
    const steps = usePreviewStore.getState().startupSteps;
    const devStep = steps.find((s) => s.stepId === "dev_server");
    if (devStep && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "complete" });
      setTimeout(() => {
        usePreviewStore.getState().clearStartupSteps();
      }, 800);
    }
  }
};
