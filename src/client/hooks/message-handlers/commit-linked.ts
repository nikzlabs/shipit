import type { WsCommitLinked } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleCommitLinked: Handler<WsCommitLinked> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => prev.map((m, i) =>
    i === data.messageIndex
      ? { ...m, commitHash: data.commitHash, parentCommitHash: data.parentCommitHash }
      : m
  ));
};
