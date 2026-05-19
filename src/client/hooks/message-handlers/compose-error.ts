import type { WsComposeError } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handleComposeError: Handler<WsComposeError> = (_ctx, data) => {
  usePreviewStore.getState().setComposeError(data.message || null);
};
