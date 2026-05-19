import type { WsAuthRequired } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

// auth_required, auth_complete, and agent_list are now delivered via SSE
// (useServerEvents hook). Only handle session-scoped auth here if needed.
export const handleAuthRequired: Handler<WsAuthRequired> = (_ctx, _data) => {
  const session = useSessionStore.getState();
  session.setIsLoading(false);
  session.setActivity(undefined);
};
