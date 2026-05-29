import type { WsGlobalSettings } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleGlobalSettings: Handler<WsGlobalSettings> = (_ctx, data) => {
  const git = useGitStore.getState();
  const settings = useSettingsStore.getState();
  const ui = useUiStore.getState();
  git.setIdentity({ name: data.gitIdentity.name, email: data.gitIdentity.email });
  settings.setSystemPromptContent(data.systemPrompt);
  settings.setHasSystemPrompt(data.systemPrompt.length > 0);
  ui.setAgentList(data.agents);
  if (data.liveSteering !== undefined) settings.setLiveSteering(data.liveSteering);
  if (data.autoResolveConflicts !== undefined) settings.setAutoResolveConflicts(data.autoResolveConflicts);
};
