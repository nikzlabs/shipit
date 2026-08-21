import type { WsPluginReposUpdated } from "../../../server/shared/types.js";
import { usePluginReposStore } from "../../stores/plugin-repos-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

/**
 * docs/262 — a plugin activation round settled server-side; refetch the
 * snapshot.
 *
 * The push is what makes the tab's "activating" state terminate reliably.
 * Activation is fire-and-forget, so before this the client could only poll,
 * and any polling budget eventually gives up on a slow fetch and leaves the
 * card stuck. The message carries no payload: `GET /api/plugin-repos` is the
 * single authoritative shape, and a second one here would drift from it.
 *
 * Scoped by `sessionId` — the store holds exactly one session's snapshot, so a
 * message for another session must not trigger a fetch that would overwrite it.
 */
export const handlePluginReposUpdated: Handler<WsPluginReposUpdated> = (_ctx, data) => {
  const active = useSessionStore.getState().sessionId;
  if (!active || active !== data.sessionId) return;
  void usePluginReposStore.getState().fetchSnapshot(active);
};
