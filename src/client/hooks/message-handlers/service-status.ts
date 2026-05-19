import type { WsServiceStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handleServiceStatus: Handler<WsServiceStatus> = (_ctx, data) => {
  const preview = usePreviewStore.getState();
  preview.updateService({
    name: data.name,
    status: data.status,
    port: data.port,
    preview: data.preview,
    error: data.error,
  });
  // Drive the dev_server startup step from real service state. This is
  // what un-sticks the "Installing dependencies..." overlay for compose-
  // backed previews — the install step finishing alone isn't enough,
  // since the overlay stays visible until either a step completes or all
  // steps are cleared.
  const steps = usePreviewStore.getState().startupSteps;
  const devStep = steps.find((s) => s.stepId === "dev_server");
  if (devStep) {
    if (data.status === "starting" && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "running" });
    } else if (data.status === "running" && devStep.status !== "complete") {
      preview.setStartupStep({ stepId: "dev_server", status: "complete" });
      // Clear startup steps shortly after the dev server is up so the
      // overlay yields the surface to the live preview / services panel
      // instead of camping out with a row of green checks.
      setTimeout(() => {
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
