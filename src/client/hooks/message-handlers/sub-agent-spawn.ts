import type { WsSubAgentSpawn } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleSubAgentSpawn: Handler<WsSubAgentSpawn> = (_ctx, data) => {
  useSessionStore.getState().upsertSubAgentSpawn({
    spawnId: data.spawnId,
    subAgentId: data.subAgentId,
  });
};
