import type { WsInstallLog } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import type { Handler } from "./types.js";

export const handleInstallLog: Handler<WsInstallLog> = (_ctx, data) => {
  // Stream install output into the terminal panel for full history…
  useTerminalStore.getState().addEntry({
    source: "install" as "preview",
    text: data.text,
    timestamp: new Date().toISOString(),
  });
  // …and into the install step's logLines so the StartupSteps overlay
  // shows progress instead of looking frozen on "Installing
  // dependencies...".
  usePreviewStore.getState().appendStartupStepLog("install", data.text);
};
