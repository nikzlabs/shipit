import type { WsFullResetComplete } from "../../../server/shared/types.js";
import { SIDEBAR_COLLAPSED_KEY, AGENT_PREFERENCE_KEY } from "../../utils/local-storage.js";
import type { Handler } from "./types.js";

export const handleFullResetComplete: Handler<WsFullResetComplete> = (_ctx, _data) => {
  try {
    localStorage.removeItem("shipit-theme");
    localStorage.removeItem(SIDEBAR_COLLAPSED_KEY);
    localStorage.removeItem(AGENT_PREFERENCE_KEY);
    localStorage.removeItem("vibe-panel-split");
  } catch { /* localStorage may be unavailable */ }
  window.location.reload();
};
