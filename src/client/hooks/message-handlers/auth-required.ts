import type { WsAuthRequired } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleAuthRequired: Handler<WsAuthRequired> = (_ctx, _data) => {
  const session = useSessionStore.getState();
  session.setIsLoading(false);
  session.setActivity(undefined);
};
