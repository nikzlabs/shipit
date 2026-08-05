import type { WsSecretBlockStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/213 / SHI-315 — sticky "auto-commit is blocked by a secret" state.
 *
 * Session-scoped state, not transcript content: the server sends it on attach
 * and on every transition, and `TRANSCRIPT_SCOPED_MESSAGES` drops it when it
 * names a session other than the one on screen (the browser holds exactly one
 * session's view at a time).
 */
export const handleSecretBlockStatus: Handler<WsSecretBlockStatus> = (_ctx, data) => {
  useSessionStore.getState().setSecretBlock(data.block);
};
