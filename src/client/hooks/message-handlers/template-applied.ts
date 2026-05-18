import type { WsTemplateApplied } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleTemplateApplied: Handler<WsTemplateApplied> = (_ctx, _data) => {
  useUiStore.getState().setShowTemplates(false);
  const sid = useSessionStore.getState().sessionId;
  if (sid) {
    useFileStore.getState().fetchTree(sid).catch((err: unknown) => console.warn("[file-refresh]", err));
  }
};
