import type { WsCompactionStatus } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/178 — transient "Compacting…" progress. Emit-only: it has no place in the
 * scrollback once the matching `compaction_card` lands, so it just flips a
 * session-store boolean the chat surface renders as a live indicator. Both CLIs
 * may compact unsolicited mid-turn, so this can arrive without the user having
 * typed `/compact`.
 */
export const handleCompactionStatus: Handler<WsCompactionStatus> = (_ctx, data) => {
  useSessionStore.getState().setCompacting(data.active);
};
