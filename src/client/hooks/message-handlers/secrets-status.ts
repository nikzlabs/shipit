import type { WsSecretsStatus } from "../../../server/shared/types.js";
import { usePreviewStore } from "../../stores/preview-store.js";
import type { Handler } from "./types.js";

export const handleSecretsStatus: Handler<WsSecretsStatus> = (_ctx, data) => {
  usePreviewStore.getState().setSecrets({
    declared: data.declared,
    missingByService: data.missingByService,
    missingRequired: data.missingRequired,
    // docs/262 req 23 — grouped per plugin; `?? []` because an older server

    plugins: data.plugins ?? [],
  });
};
