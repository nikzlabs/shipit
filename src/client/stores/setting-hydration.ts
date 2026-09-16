/**
 * Where a generated row's value comes from on a page load
 * (docs/308-data-driven-settings req 1, plan.md → One reader).
 *
 * Two reads, both keyed off the declarations rather than off a list of settings
 * anyone maintains: the settings payload carries a row's value under its `wire`,
 * and a row the payload does not carry is read from its own route, at the path
 * and under the field its store names (inventory.md P2).
 *
 * That is the half slice 1 left open. Before this, a new generated row had a
 * working control and a working write, and a reload showed its default until
 * `global-settings.ts`, `session-data.ts` and `App.tsx` each named it too.
 */

import { OWN_ROUTE_SETTINGS, GENERATED_SETTINGS, ownRouteOf } from "./setting-values.js";
import { useSettingsStore } from "./settings-store.js";
import type { SettingKey } from "../../server/shared/settings-catalogue/index.js";

/**
 * Apply a settings payload to every generated row it carries.
 *
 * A field the payload omits is left alone rather than reset: the payload omits
 * what it has no value for, and `undefined` is not one.
 */
export function hydrateSettingValues(payload: Readonly<Record<string, unknown>>): void {
  const { setSettingValue } = useSettingsStore.getState();
  for (const declaration of GENERATED_SETTINGS) {
    const wire = declaration.wire;
    if (!wire) continue;
    const value = payload[wire];
    if (value === undefined) continue;
    setSettingValue(declaration.key as SettingKey, value);
  }
}

/**
 * Read the generated rows the settings payload does not carry, from their own
 * routes.
 *
 * A failed read leaves the last value in place: a row showing the value ShipIt
 * last knew beats one that resets itself to a declared default the install may
 * not be on.
 *
 * **A read that started before the value moved is discarded.** These reads are
 * in flight for as long as a request takes, and a save writes the record the
 * moment it is made — so a read that began first and answered second would put
 * the old value back under a control the user has since changed, and the
 * `settings_changed` refresh that would have corrected it has already run. The
 * record's own value before and after the read is the whole test: it moved, so
 * this answer is describing a state nobody is in any more.
 */
export async function refreshOwnRouteSettings(): Promise<void> {
  await Promise.all(OWN_ROUTE_SETTINGS.map(async (declaration) => {
    const route = ownRouteOf(declaration);
    if (!route) return;
    const key = declaration.key as SettingKey;
    const before = useSettingsStore.getState().settingValues[key];
    try {
      const res = await fetch(route.path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      const value = body[route.bodyField];
      if (value === undefined) return;
      if (useSettingsStore.getState().settingValues[key] !== before) return;
      useSettingsStore.getState().setSettingValue(key, value);
    } catch (err) {
      console.error(`[settings] reading ${declaration.key} from ${route.path} failed:`, err);
    }
  }));
}
