import type { WsForkBreadcrumb } from "../../../server/shared/types.js";
import { useSessionStore } from "../../stores/session-store.js";
import type { Handler } from "./types.js";

export const handleForkBreadcrumb: Handler<WsForkBreadcrumb> = (_ctx, data) => {
  useSessionStore.getState().setMessages((prev) => [...prev, data.message]);
};
