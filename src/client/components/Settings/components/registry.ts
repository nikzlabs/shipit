/**
 * The components a declaration may name (docs/308-data-driven-settings
 * plan.md → Components, req 3).
 *
 * A component takes the setting's key and nothing else, and what is custom
 * about it is the presentation: the destination is still the one its
 * declaration names (req 3). A small one over a value the record holds reaches
 * it through `useSetting` and the shared writer; a PANEL, and a component over a
 * value the record cannot hold (`voice.providerKey`, the five repository
 * settings), keeps its own reader and writer at the address its declaration
 * names in prose — membership of the rows is wider than membership of the
 * record (P11).
 */

import type { ReactNode } from "react";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";
import { AgentPermissions } from "../../AgentPermissions.js";
import { KeybindingSettings } from "../../KeybindingSettings.js";
import { McpServerSettings } from "../../McpServerSettings.js";
import { RepoColorPicker } from "../../RepoColorPicker.js";
import { SecretsTab } from "../../SecretsTab.js";
import { SshHostsSettings } from "../../SshHostsSettings.js";
import { BackgroundWorkSection } from "../BackgroundWorkSection.js";
import { ServicesPanel } from "../ServicesPanel.js";
import { EgressHosts } from "./EgressHosts.js";
import { GitHubConnection } from "./GitHubConnection.js";
import { LinearCredential } from "./LinearCredential.js";
import { MemoryBudget } from "./MemoryBudget.js";
import { RolesSettings } from "./RolesSettings.js";
import { VoiceHandsFree } from "./VoiceHandsFree.js";
import { VoiceProviderKeys } from "./VoiceProviderKeys.js";
import { VoiceTts } from "./VoiceTts.js";
import { VoiceWebhook } from "./VoiceWebhook.js";

/**
 * The key is the FIRST declaration naming the component, which is where the
 * renderer places it. A component that owns several declarations names them
 * itself and takes no props — it has to know which of them is which, and a
 * positional list would decide that in the catalogue file instead.
 */
export type SettingComponent = (props: { settingKey: SettingKey }) => ReactNode;

export const SETTING_COMPONENTS: Readonly<Record<string, SettingComponent>> = {
  "memory-budget": MemoryBudget,
  "github-connection": GitHubConnection,
  "linear-credential": LinearCredential,
  // The collection panels, which keep the writers their operations need.
  "ssh-hosts": SshHostsSettings,
  "mcp-servers": McpServerSettings,
  "egress-hosts": EgressHosts,
  "keybindings": KeybindingSettings,
  "services-panel": ServicesPanel,
  "roles": RolesSettings,
  "background-work": BackgroundWorkSection,
  "voice-provider-keys": VoiceProviderKeys,
  "voice-tts": VoiceTts,
  "voice-hands-free": VoiceHandsFree,
  "voice-webhook": VoiceWebhook,
  // Project Settings (slice 7). Each reads the open repository (`project-repo.ts`)
  // and writes where its declaration says, because the value record is keyed by
  // setting alone and cannot hold a repository's value (`setting-values.ts`).
  "agent-merge": AgentPermissions,
  "repo-color": RepoColorPicker,
  "project-secrets": SecretsTab,
};
