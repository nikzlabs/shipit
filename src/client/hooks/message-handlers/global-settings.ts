import type { WsGlobalSettings } from "../../../server/shared/types.js";
import { useGitStore } from "../../stores/git-store.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { hydrateSettingValues } from "../../stores/setting-hydration.js";
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
  // Every generated row, from its declaration's `wire`
  // (docs/308-data-driven-settings req 1).
  hydrateSettingValues(data as unknown as Record<string, unknown>);
  if (data.failoverCutoffs !== undefined) {
    for (const [agentId, cutoffs] of Object.entries(data.failoverCutoffs)) {
      settings.setFailoverCutoffs(agentId, cutoffs);
    }
  }
  if (data.accountSelectionMode !== undefined) {
    for (const [agentId, mode] of Object.entries(data.accountSelectionMode)) {
      settings.setAccountSelectionMode(agentId, mode);
    }
  }
};
