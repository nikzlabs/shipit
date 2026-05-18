import type { WsGitHubStatus } from "../../../server/shared/types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import type { Handler } from "./types.js";

export const handleGithubStatus: Handler<WsGitHubStatus> = (_ctx, data) => {
  useSettingsStore.getState().setGithubStatus({
    authenticated: data.authenticated,
    username: data.username,
    avatarUrl: data.avatarUrl,
  });
};
