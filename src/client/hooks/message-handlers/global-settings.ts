import type { WsGlobalSettings } from "../../../server/shared/types.js";
import { useSettingsStore } from "../../stores/settings-store.js";
import { hydrateSettingValues } from "../../stores/setting-hydration.js";
import { useUiStore } from "../../stores/ui-store.js";
import type { Handler } from "./types.js";

export const handleGlobalSettings: Handler<WsGlobalSettings> = (_ctx, data) => {
  const settings = useSettingsStore.getState();
  const ui = useUiStore.getState();
  settings.setHasSystemPrompt(data.systemPrompt.length > 0);
  ui.setAgentList(data.agents);
  // Every generated row this message carries, from its declaration's `wire`
  // (docs/308-data-driven-settings req 1). `partial`, because it carries some of
  // the settings and not all of them: an absent field here means the message
  // does not have one, never that the stored value is gone.
  hydrateSettingValues(data as unknown as Record<string, unknown>, { partial: true });
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
