/**
 * A declaration's own words, for the control that shows them
 * (docs/299-agent-settings-access req 7).
 *
 * The words the dialog renders and the words the agent reads are the same
 * strings, because there is only one of them. A control reaches them through a
 * `SettingKey`, so one nobody declared has nothing it can name.
 *
 * This is the half of the old `setting-binding.ts` that survived slice 8: the
 * `data-setting` attributes it existed for went with the coverage walk
 * (docs/308-data-driven-settings req 12).
 */

import {
  findSetting,
  type AnySettingDeclaration,
  type SettingKey,
} from "../../../server/shared/settings-catalogue/index.js";

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
