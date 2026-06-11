import type { WsSubAgentSpawn } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/144 — transient sub-agent spawn chip. Emit-only status (CLAUDE.md §5): it
 * has no place in the scrollback (the sub-agent's output reaches the user
 * through the primary's own voice), so it just upserts a session-store entry the
 * chat surface renders as a live "Asking Codex…" / "Consulted Codex" chip. Keyed
 * by spawnId so the running → done transition replaces the same chip. Resets on
 * reload/switch.
 */
export const handleSubAgentSpawn: Handler<WsSubAgentSpawn> = (_ctx, data) => {
  useSessionStore.getState().upsertSubAgentSpawn({
    spawnId: data.spawnId,
    subAgentId: data.subAgentId,
    phase: data.phase,
    ...(data.status !== undefined ? { status: data.status } : {}),
    ...(data.durationMs !== undefined ? { durationMs: data.durationMs } : {}),
    ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
    ...(data.truncated !== undefined ? { truncated: data.truncated } : {}),
  });
};
