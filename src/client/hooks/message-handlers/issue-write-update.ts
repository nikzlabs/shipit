import type { WsIssueWriteUpdate } from "../../../server/shared/types.js";
import { useIssueWriteStore } from "../../stores/issue-write-store.js";
import type { Handler } from "./types.js";

/**
 * docs/177 — an issue-write card's undo lifecycle transition (undoing → undone
 * | failed). Idempotent by cardId; a buffer replay just re-applies the same
 * terminal state.
 */
export const handleIssueWriteUpdate: Handler<WsIssueWriteUpdate> = (_ctx, data) => {
  useIssueWriteStore.getState().setUndoState(data.cardId, data.undoState, data.errorMessage);
};
