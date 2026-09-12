import type { WsInstallStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handleInstallStatus: Handler<WsInstallStatus> = (_ctx, data) => {
  const preview = usePreviewStore.getState();
  const stepStatus = data.status === "complete" || data.status === "skipped"
    ? "complete" as const
    : data.status === "error"
      ? "error" as const
      : "running" as const;
  preview.setStartupStep({
    stepId: "install",
    status: stepStatus,
    message: data.message,
  });

  if (stepStatus === "complete") {
    preview.setStartupStep({ stepId: "dev_server", status: "running" });

    setTimeout(() => {
      const steps = usePreviewStore.getState().startupSteps;
      const devStep = steps.find((s) => s.stepId === "dev_server");
      if (devStep?.status === "running") {
        usePreviewStore.getState().clearStartupSteps();
      }
    }, 6_000);
  }

};
