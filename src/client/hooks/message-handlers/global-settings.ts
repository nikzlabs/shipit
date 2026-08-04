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
  if (data.autoFixCi !== undefined) settings.setAutoFixCi(data.autoFixCi);
  if (data.autoResetMergedBranch !== undefined) settings.setAutoResetMergedBranch(data.autoResetMergedBranch);
  if (data.enableSubAgents !== undefined) settings.setEnableSubAgents(data.enableSubAgents);
  if (data.agentSubAgentDefaults !== undefined) settings.setAgentSubAgentDefaults(data.agentSubAgentDefaults);
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
