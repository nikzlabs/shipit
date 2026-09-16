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
import { MemoryBudget } from "./MemoryBudget.js";

export type SettingComponent = (props: { settingKey: SettingKey }) => ReactNode;

export const SETTING_COMPONENTS: Readonly<Record<string, SettingComponent>> = {
  "memory-budget": MemoryBudget,
};
