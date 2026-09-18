import type { WsPreviewStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { isForeignSession } from "./session-scope.js";
import type { Handler } from "./types.js";

export const handlePreviewStatus: Handler<WsPreviewStatus> = (_ctx, data) => {
  const preview = usePreviewStore.getState();

  if (isForeignSession(data.sessionId)) return;

  preview.setStatus({
    running: data.running,
    port: data.port,
    url: data.url,
    source: data.source,
    detectedPorts: data.detectedPorts,
  });

  if (data.running) {
    const steps = usePreviewStore.getState().startupSteps;
    const devStep = steps.find((s) => s.stepId === "dev_server");
    if (devStep && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "complete" });

      setTimeout(() => {
        if (isForeignSession(data.sessionId)) return;
        usePreviewStore.getState().clearStartupSteps();
      }, 800);
    }
  }
};
