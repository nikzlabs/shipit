import type { WsInstallLog } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { useLogStore } from "../../stores/log-store.js";
import type { Handler } from "./types.js";

export const handleInstallLog: Handler<WsInstallLog> = (_ctx, data) => {

  useLogStore.getState().append("agent", [
    { ts: new Date().toISOString(), source: "install", text: data.text },
  ]);

  usePreviewStore.getState().appendStartupStepLog("install", data.text);
};
