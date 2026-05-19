import type { WsContainerRestarting } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleContainerRestarting: Handler<WsContainerRestarting> = (_ctx, data) => {
  const session = useSessionStore.getState();
  // Phased Rescue session progress. Newer payloads include `phase`; older
  // ones don't — treat the legacy form as "in flight, no detail".
  //
  // Preserve `startedAt` across phase transitions: the value is set when
  // the user clicks the button (in SessionHealthStrip) and is used to
  // filter stale `lastCreateError`s in the poll loop. Replacing the whole
  // RescueState object on each phase WS message would wipe it. If the
  // server is driving a rescue we didn't initiate (no existing startedAt),
  // default to now so the poll's "is this error from THIS attempt" check
  // still works.
  const prev = useSessionStore.getState().rescueState;
  const startedAt = prev?.startedAt ?? Date.now();
  if (data.phase === "ready") {
    // Clear after a short delay so the success state is visible briefly.
    session.setRescueState({ phase: "ready", startedAt });
    setTimeout(() => {
      if (useSessionStore.getState().rescueState?.phase === "ready") {
        useSessionStore.getState().setRescueState(null);
      }
    }, 1500);
  } else {
    session.setRescueState({
      phase: data.phase ?? "destroying_container",
      startedAt,
      ...(data.reason !== undefined ? { reason: data.reason } : {}),
      ...(data.message !== undefined ? { message: data.message } : {}),
    });
  }
};
