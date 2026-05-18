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
  // Once install is finished, advance the dev_server step from "pending"
  // to "running" so the overlay communicates that we're now waiting on the
  // dev server (instead of looking permanently stuck on "Installing
  // dependencies..."). For manual previews where no auto-start fires, the
  // fallback timer below clears the overlay so the services panel can
  // surface the Start button.
  if (stepStatus === "complete") {
    preview.setStartupStep({ stepId: "dev_server", status: "running" });
    // If nothing transitions dev_server within 6s (typical: manual
    // preview, or no compose service), clear startup steps entirely so
    // the services panel / "Starting dev server..." overlay can take
    // over. This pairs with the dev_server completion logic below.
    setTimeout(() => {
      const steps = usePreviewStore.getState().startupSteps;
      const devStep = steps.find((s) => s.stepId === "dev_server");
      if (devStep?.status === "running") {
        usePreviewStore.getState().clearStartupSteps();
      }
    }, 6_000);
  }
  // On error: do nothing extra — leave the overlay showing the failed
  // install step so the user can act on it. dev_server stays pending.
};
