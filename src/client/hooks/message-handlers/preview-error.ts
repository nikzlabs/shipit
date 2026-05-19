import type { WsPreviewError } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handlePreviewError: Handler<WsPreviewError> = (_ctx, data) => {
  usePreviewStore.getState().setPreviewProxyError({
    port: data.port,
    message: data.message,
    ...(data.upgrade !== undefined ? { upgrade: data.upgrade } : {}),
    at: Date.now(),
  });
};
