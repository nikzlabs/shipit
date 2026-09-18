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
import type {
  AnySettingDeclaration,
  SettingKey,
} from "../../server/shared/settings-catalogue/index.js";

/**
 * Apply a settings payload to every generated row it carries.
 *
 * A field the payload omits is left alone rather than reset: the payload omits
 * what it has no value for, and `undefined` is not one.
 *
 * **Unless the declaration says the omission IS the value** (slice 6b). A
 * declaration marked `omitWhenNull` is one whose payload field is dropped rather
 * than sent as null, so in a WHOLE payload an absent field means null and
 * nothing else — leaving the record alone would keep showing a background-work
 * pin the server has stopped holding.
 *
 * Which is why {@link partial} exists, for the one caller that is not a whole
 * payload: a message carrying some of the settings cannot say a value is gone,
 * only that it does not carry it. Found in review, reproduced — the
 * `global_settings` message declares no `nonTurnModel` field at all, so reading
 * its silence as a deletion cleared a pin nobody had touched.
 */
export function hydrateSettingValues(
  payload: Readonly<Record<string, unknown>>,
  { partial = false } = {},
): void {
  const { setSettingValue } = useSettingsStore.getState();
  for (const declaration of GENERATED_SETTINGS) {
    const wire = declaration.wire;
    if (!wire) continue;
    const value = payload[wire];
    if (value === undefined && (partial || !declaration.omitWhenNull)) continue;
    setSettingValue(declaration.key as SettingKey, value ?? null);
  }
}

/** Monotonic per own-route address; only the newest read may move the record. */
const READS = new Map<string, number>();

/**
 * Read the generated rows the settings payload does not carry, from their own
 * routes.
 *
 * A failed read leaves the last value in place: a row showing the value ShipIt
 * last knew beats one that resets itself to a declared default the install may
 * not be on.
 *
 * **Two answers are refused, and neither guard covers the other's case.** An
 * answer that is not the NEWEST read's for that address moves nothing: two
 * reads overlap whenever `settings_changed` arrives while one is out, and left
 * unordered the older one writes its stale value AND makes the newer answer
 * look superseded by the guard beside it. And an answer fetched before the
 * record moved is discarded, because a write is not a read and the sequence
 * cannot see one — a save the user just made would otherwise be undone by an
 * answer older than the click.
 */
export async function refreshOwnRouteSettings(): Promise<void> {
  const byPath = new Map<string, AnySettingDeclaration[]>();
  for (const declaration of OWN_ROUTE_SETTINGS) {
    const route = ownRouteOf(declaration);
    if (!route) continue;
    byPath.set(route.path, [...byPath.get(route.path) ?? [], declaration]);
  }

  await Promise.all([...byPath].map(async ([path, declarations]) => {
    // Settings that share an address share the read, because the answer is one
    // object carrying a field each — the voice webhook's url and token are one
    // credential, and asking twice would be two requests for one answer.
    const before = declarations.map(
      (d) => useSettingsStore.getState().settingValues[d.key as SettingKey],
    );
    const mine = (READS.get(path) ?? 0) + 1;
    READS.set(path, mine);
    try {
      const res = await fetch(path);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json() as Record<string, unknown>;
      if (READS.get(path) !== mine) return;
      for (const [index, declaration] of declarations.entries()) {
        const key = declaration.key as SettingKey;
        const value = body[ownRouteOf(declaration)?.bodyField ?? ""];
        if (value === undefined) continue;
        if (useSettingsStore.getState().settingValues[key] !== before[index]) continue;
        useSettingsStore.getState().setSettingValue(key, value);
      }
    } catch (err) {
      console.error(
        `[settings] reading ${declarations.map((d) => d.key).join(", ")} from ${path} failed:`,
        err,
      );
    }
  }));
}
