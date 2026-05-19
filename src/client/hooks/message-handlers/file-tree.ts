import type { WsFileTree } from "../../../server/shared/types.js";
import { useFileStore } from "../../stores/file-store.js";
import type { Handler } from "./types.js";

export const handleFileTree: Handler<WsFileTree> = (_ctx, data) => {
  useFileStore.getState().setTree(data.tree);
};
