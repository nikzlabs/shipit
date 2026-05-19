import type { WsModelInfo } from "../../../server/shared/types.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleModelInfo: Handler<WsModelInfo> = (_ctx, data) => {
  useUiStore.getState().setModelInfo({ model: data.model, contextWindowTokens: data.contextWindowTokens });
};
