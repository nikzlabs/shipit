import type { SettingTab } from "./types.js";

/**
 * The words each tab shows in its dialog. One map, read by the dialog's own tab
 * strip and by anything that has to name where a setting lives — a proposal
 * card's breadcrumb, say — so the user and the agent read the same words (req 7)
 * for the tab as well as for the setting.
 */
export const SETTING_TAB_LABELS: Record<SettingTab, string> = {
  services: "Model providers",
  roles: "Roles",
  integrations: "Integrations",
  git: "Git",
  instructions: "Instructions",
  skills: "Skills",
  keyboard: "Keyboard",
  voice: "Voice",
  network: "Network",
  advanced: "Advanced",
  "project-deployments": "Deployments",
  "project-secrets": "Secrets",
  "project-appearance": "Appearance",
};

/** Which of the two dialogs req 5 names holds a tab. */
export function settingDialogName(tab: SettingTab): string {
  return tab.startsWith("project-") ? "Project Settings" : "Settings";
}

/** Where a setting lives, as one breadcrumb: `Settings › Advanced`. */
export function settingPath(tab: SettingTab): string {
  return `${settingDialogName(tab)} › ${SETTING_TAB_LABELS[tab]}`;
}
