/**
 * The components a declaration may name (docs/308-data-driven-settings
 * plan.md → Components, req 3).
 *
 * A component takes the setting's key and nothing else — it reads and writes
 * through `useSetting`, so custom stays presentation and the destination is the
 * one the declaration names (req 3). A name with no entry here renders nothing,
 * which is how a slice converts the components it has and leaves the rest
 * hand-written (P18).
 */

import type { ReactNode } from "react";
import type { SettingKey } from "../../../../server/shared/settings-catalogue/index.js";
import { GitHubConnection } from "./GitHubConnection.js";
import { LinearCredential } from "./LinearCredential.js";
import { MemoryBudget } from "./MemoryBudget.js";
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
  "voice-provider-keys": VoiceProviderKeys,
  "voice-tts": VoiceTts,
  "voice-hands-free": VoiceHandsFree,
  "voice-webhook": VoiceWebhook,
};
