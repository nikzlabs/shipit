import type { WsContainerRestarting } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleContainerRestarting: Handler<WsContainerRestarting> = (_ctx, data) => {
  const session = useSessionStore.getState();

  const prev = useSessionStore.getState().rescueState;
  const startedAt = prev?.startedAt ?? Date.now();
  if (data.phase === "ready") {

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
