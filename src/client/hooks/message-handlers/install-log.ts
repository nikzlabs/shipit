import type { WsInstallLog } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useLogStore } from "../../stores/log-store.js";
import type { Handler } from "./types.js";

export const handleInstallLog: Handler<WsInstallLog> = (_ctx, data) => {
  // Stream install output into the agent Logs tab (docs/192 unified channel)…
  useLogStore.getState().append("agent", [
    { ts: new Date().toISOString(), source: "install", text: data.text },
  ]);
  // …and into the install step's logLines so the StartupSteps overlay
  // shows progress instead of looking frozen on "Installing
  // dependencies...".
  usePreviewStore.getState().appendStartupStepLog("install", data.text);
};
