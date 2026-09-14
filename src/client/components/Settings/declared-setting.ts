/**
 * The save wiring a declared global scalar generates, rather than repeats
 * (docs/299-agent-settings-access req 7, plan.md → Settings are declared once).
 *
 * The server half of a declaration derived — the stored `GlobalSettings` field,
 * the `PUT /api/settings` body, its validation, the `CredentialStore` accessor.
 * The client half did not: every toggle in the dialog selected its own store
 * field, wrote its own `fetch` with its own payload literal, rolled back by hand
 * and wrote its own toast. Seven copies of one block, and a new setting needed an
 * eighth — which is the second registration req 7 says must not exist.
 *
 * What derives here: the payload field is the declaration's `wire`, the store
 * field and its setter are named for it, and the toast names the declaration's
 * own label. What does NOT derive is the store field itself — the browser store
 * is hand-written and read all over the app — so a declaration whose field or
 * setter is missing simply drops out of {@link DeclaredBooleanKey}, and binding a
 * control to it without supplying the two props is a compile error naming the
 * setting. That half is detected, not derived, and `plan.md` says so.
 */

import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import {
  GLOBAL_SETTINGS,
  type GlobalSettingKey,
  type GlobalSettingsCatalogue,
  type SettingValue,
} from "../../../server/shared/settings-catalogue/index.js";

type Settings = ReturnType<typeof useSettingsStore.getState>;

/** The `GlobalSettings` / `PUT /api/settings` field a declaration names. */
type WireOf<K extends GlobalSettingKey> =
  GlobalSettingsCatalogue[K] extends { readonly wire: infer W extends string } ? W : never;

/**
 * A declared boolean the browser store already holds under its wire name, with
 * the setter beside it. Every clause has to hold, because the derived save
 * writes exactly those three things and nothing checks them at run time.
 */
type DerivableBoolean<K extends GlobalSettingKey> =
  GlobalSettingsCatalogue[K]["store"] extends { readonly kind: "credential-store" }
    ? SettingValue<GlobalSettingsCatalogue[K]> extends boolean
      ? WireOf<K> extends keyof Settings
        ? Settings[WireOf<K>] extends boolean
          ? `set${Capitalize<WireOf<K>>}` extends keyof Settings
            ? K
            : never
          : never
        : never
      : never
    : never;

/** Every declared boolean whose read and write this module can produce on its own. */
export type DeclaredBooleanKey = {
  [K in GlobalSettingKey]: DerivableBoolean<K>;
}[GlobalSettingKey];

function wireOf(key: DeclaredBooleanKey): string {
  // Narrowed by DeclaredBooleanKey to a payload declaration; the index loses it.
  return (GLOBAL_SETTINGS[key] as { wire: string }).wire;
}

function setterName(wire: string): string {
  return `set${wire.charAt(0).toUpperCase()}${wire.slice(1)}`;
}

function writeStore(wire: string, value: boolean): void {
  const state = useSettingsStore.getState() as unknown as Record<string, (v: boolean) => void>;
  state[setterName(wire)]?.(value);
}

/**
 * Write optimistically, then durably — and put the optimistic value back when
 * the save does not land, so the switch never shows a state the server refused.
 */
export async function saveDeclaredBoolean(
  key: DeclaredBooleanKey,
  value: boolean,
): Promise<void> {
  const wire = wireOf(key);
  writeStore(wire, value);
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [wire]: value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    writeStore(wire, !value);
    // The declaration's own label, so the toast names the control the user just
    // used rather than a second phrasing of it written beside the fetch.
    useUiStore.getState().setToast({
      message: `Failed to update ${GLOBAL_SETTINGS[key].label}`,
    });
    console.error(`[settings] saving ${key} failed:`, err);
  }
}

/** A declared boolean's current value and the only write it needs. */
export function useDeclaredBoolean(key: DeclaredBooleanKey): {
  value: boolean;
  set: (next: boolean) => void;
} {
  const wire = wireOf(key);
  const value = useSettingsStore(
    (state) => (state as unknown as Record<string, boolean>)[wire] ?? false,
  );
  return { value, set: (next) => { void saveDeclaredBoolean(key, next); } };
}
