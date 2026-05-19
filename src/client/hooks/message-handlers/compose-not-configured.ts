import type { WsComposeNotConfigured } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handleComposeNotConfigured: Handler<WsComposeNotConfigured> = (_ctx, _data) => {
  usePreviewStore.getState().setComposeNotConfigured(true);
};
