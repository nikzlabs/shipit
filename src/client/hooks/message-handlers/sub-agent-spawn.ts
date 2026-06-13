import type { WsSubAgentSpawn } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/144 — the transient in-flight "Asking Codex…" spinner. Emit-only live
 * activity (CLAUDE.md §5): it upserts a session-store entry the chat surface
 * renders as a spinner while the `shipit agent` call is in flight, and correctly
 * resets on reload/switch. The TERMINAL "Consulted Codex · 47s" record is a
 * separate PERSISTED chat card (`sub_agent_consult_card`), whose handler removes
 * this spinner by spawnId. Keyed by spawnId.
 */
export const handleSubAgentSpawn: Handler<WsSubAgentSpawn> = (_ctx, data) => {
  useSessionStore.getState().upsertSubAgentSpawn({
    spawnId: data.spawnId,
    subAgentId: data.subAgentId,
  });
};
