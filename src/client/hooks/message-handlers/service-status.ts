import type { WsServiceStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { isForeignSession } from "./session-scope.js";
import type { Handler } from "./types.js";

export const handleServiceStatus: Handler<WsServiceStatus> = (_ctx, data) => {
  if (isForeignSession(data.sessionId)) return;
  const preview = usePreviewStore.getState();
  preview.updateService({
    name: data.name,
    status: data.status,
    port: data.port,
    preview: data.preview,
    error: data.error,
    ...(data.origin ? { origin: data.origin } : {}),
  });

  const steps = usePreviewStore.getState().startupSteps;
  const devStep = steps.find((s) => s.stepId === "dev_server");
  if (devStep) {
    if (data.status === "starting" && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "running" });
    } else if (data.status === "running" && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "complete" });

      // server (review finding). The dispatch-time guard cannot cover a delayed

      setTimeout(() => {
        if (isForeignSession(data.sessionId)) return;
        usePreviewStore.getState().clearStartupSteps();
      }, 800);
    } else if (data.status === "error" && devStep.status === "running") {
      preview.setStartupStep({
        stepId: "dev_server",
        status: "error",
        message: data.error,
      });
    }
  }
};
