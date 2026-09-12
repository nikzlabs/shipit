import type { WsPrNotableFiles } from "../../../server/shared/types.js";
import { usePrStore } from "../../stores/pr-store.js";
import type { Handler } from "./types.js";

export const handlePrNotableFiles: Handler<WsPrNotableFiles> = (_ctx, data) => {
  usePrStore.getState().setNotableFiles(data.sessionId, data.cardId, data.notableFiles);
};
