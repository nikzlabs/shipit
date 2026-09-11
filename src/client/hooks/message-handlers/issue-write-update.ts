import type { WsIssueWriteUpdate } from "../../../server/shared/types.js";
import { useIssueWriteStore } from "../../stores/issue-write-store.js";
import type { Handler } from "./types.js";

export const handleIssueWriteUpdate: Handler<WsIssueWriteUpdate> = (_ctx, data) => {
  useIssueWriteStore.getState().setUndoState(data.cardId, data.undoState, data.errorMessage);
};
