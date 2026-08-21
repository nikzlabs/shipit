import type { WsServiceList } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import { isForeignSession } from "./session-scope.js";
import type { Handler } from "./types.js";

export const handleServiceList: Handler<WsServiceList> = (_ctx, data) => {
  if (isForeignSession(data.sessionId)) return;
  usePreviewStore.getState().setServices(
    data.services.map((s) => ({
      name: s.name,
      status: s.status,
      port: s.port,
      preview: s.preview,
      error: s.error,
      ...(s.origin ? { origin: s.origin } : {}),
    })),
  );
};
