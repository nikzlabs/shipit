import type { WsModelSelectionChanged } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import { useFileStore } from "../../stores/file-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { saveRoleName } from "../../utils/local-storage.js";
import type { Handler } from "./types.js";

/**
 * docs/252 phase 4 (req 4) — the server's authoritative answer to a `set_model`
 * or `set_agent`.
 *
 * Two things happen, and the first is the one that fixes a visible bug: the
 * session row is updated in place, so the picker's checkmark lands on the
 * `(service, billing mode)` the session is ACTUALLY on. The composer's
 * optimistic pick is a triple, but nothing else refreshes the session list after
 * a selection change — so before this, picking the same model id on a different
 * service left the checkmark on the old group until an unrelated session-list
 * refresh happened to arrive.
 *
 * Second, when the server moved something the user did not pick — a harness
 * switch conforming the model, its billing group, or the reasoning effort — the
 * single sentence it composed is shown as a toast. A toast rather than a
 * transcript card on purpose: this is feedback on a control the user just
 * operated, and the state it reports is the composer's own, re-read from the
 * session row on every load. Nothing here belongs in the scrollback.
 *
 * Applied by session id, never to "the active session": the update is safe to
 * apply for any session in the list, while the toast is only shown for the one
 * the user is looking at.
 */
export const handleModelSelectionChanged: Handler<WsModelSelectionChanged> = (_ctx, data) => {
  const session = useSessionStore.getState();
  session.setSessions((prev) =>
    prev.map((s) =>
      s.id === data.sessionId
        ? {
            ...s,
            agentId: data.agentId,
            ...(data.modelId ? { model: data.modelId } : { model: undefined }),
            ...(data.selection
              ? { serviceId: data.selection.serviceId, billingMode: data.selection.billingMode }
              : { serviceId: undefined, billingMode: undefined }),
            ...(data.reasoningEffort
              ? { reasoningEffort: data.reasoningEffort }
              : { reasoningEffort: undefined }),
            // The server response must also clear a role that no longer applies.
            ...(data.roleName ? { roleName: data.roleName } : { roleName: undefined }),
          }
        : s,
    ),
  );

  // Before the first turn, persist both role selection and role removal.
  const started = !!useSessionStore
    .getState()
    .sessions.find((s) => s.id === data.sessionId)?.agentPinned;
  if (session.sessionId === data.sessionId && !started) {
    saveRoleName(data.roleName ?? undefined);
  }
  // docs/272 — on `/{repo}/new` the warm session has no row, so the pickers read
  // `activeAgentId`, which `useConnectionSync` only syncs FROM a row. Not
  // persisted: an internal sync must not move the new-session default. Skills are
  // per-backend, so a harness that moved invalidates them.
  if (session.sessionId === data.sessionId) {
    const ui = useUiStore.getState();
    if (ui.activeAgentId !== data.agentId) {
      ui.setActiveAgentId(data.agentId);
      void useFileStore
        .getState()
        .fetchSkills(data.sessionId, data.agentId)
        .catch(() => {});
    }
  }
  // The server has answered. Say so unconditionally — the composer's optimistic
  // pick has to be dropped whether the answer was "yes" or "no", and a REFUSED
  // pick leaves the session row exactly as it was, so "the row now matches"
  // cannot be the signal.
  session.bumpModelSelectionEcho(data.sessionId);
  if (data.notice && session.sessionId === data.sessionId) {
    useUiStore.getState().setToast({ message: data.notice, duration: 6000 });
  }
};
