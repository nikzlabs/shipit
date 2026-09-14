/**
 * How a dialog control names the declaration it renders
 * (docs/299-agent-settings-access req 7).
 *
 * Split out from `declared.tsx` so that a control as low-level as
 * {@link ToggleSwitch} can bind itself without importing the components that
 * are built on it.
 *
 * The binding is **not** a test id. A test id identifies a control and says
 * nothing about which declaration's description and policy it shares, which is
 * exactly what the coverage walk has to establish. And the key is typed as
 * `SettingKey`, so a control nobody declared has nothing it can name.
 */

import {
  findSetting,
  type AnySettingDeclaration,
  type SettingKey,
} from "../../../server/shared/settings-catalogue/index.js";

/** The attribute naming the declaration a control renders from. */
export const SETTING_ATTR = "data-setting";

export interface SettingBinding {
  readonly "data-setting": SettingKey;
}

/** Mark a control as this setting's. The only way a control claims a declaration. */
export function bindSetting(key: SettingKey): SettingBinding {
  return { "data-setting": key };
}

/** The declaration behind a key. Present by construction — `SettingKey` is its key set. */
export function settingOf(key: SettingKey): AnySettingDeclaration {
  const declaration = findSetting(key);
  if (!declaration) throw new Error(`No setting is declared for "${key}"`);
  return declaration;
}

/** The words the dialog shows and the agent reads, from the one place they live. */
export function settingCopy(key: SettingKey): { label: string; description: string } {
  const { label, description } = settingOf(key);
  return { label, description };
}

export interface DeclaredOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** A declared enum's options, for the control that offers them. */
export function settingOptions(key: SettingKey): DeclaredOption[] {
  const { shape } = settingOf(key).type;
  return Array.isArray(shape.options) ? (shape.options as DeclaredOption[]) : [];
}
