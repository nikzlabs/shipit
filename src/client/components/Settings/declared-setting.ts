/**
 * The read and the write a declaration generates, rather than repeats
 * (docs/299-agent-settings-access req 7, docs/308-data-driven-settings
 * plan.md → One writer, for the scalars).
 *
 * The server half of a declaration already derived — the stored `GlobalSettings`
 * field, the `PUT /api/settings` body, its validation, the `CredentialStore`
 * accessor. The client half did not: every control in the dialog selected its own
 * store field, wrote its own `fetch` with its own payload literal, rolled back by
 * hand and wrote its own toast.
 *
 * {@link saveSetting} takes a `SettingKey` and a value and nothing else: where
 * the value goes comes from `store.kind`, the payload field is the declaration's
 * `wire`, the storage key is its `localStorageKey`, and the toast names the
 * declaration's own label.
 */

import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import { mirrorFieldOf } from "../../stores/setting-values.js";
import { settingOf } from "./setting-binding.js";
import type {
  GlobalSettingKey,
  GlobalSettingsCatalogue,
  SettingKey,
  SettingValue,
} from "../../../server/shared/settings-catalogue/index.js";

type Settings = ReturnType<typeof useSettingsStore.getState>;

/** The `GlobalSettings` / `PUT /api/settings` field a declaration names. */
type WireOf<K extends GlobalSettingKey> =
  GlobalSettingsCatalogue[K] extends { readonly wire: infer W extends string } ? W : never;

/**
 * A declared boolean the browser store already holds under its wire name.
 *
 * Both clauses have to hold, because the value is read back through that field
 * wherever the record does not yet carry the setting. It used to demand a
 * `set<Wire>` setter beside it as well; that was a proxy for "something hydrates
 * this field", and hydration now walks the declarations
 * (`stores/setting-hydration.ts`) rather than calling a setter per setting.
 */
type DerivableBoolean<K extends GlobalSettingKey> =
  GlobalSettingsCatalogue[K]["store"] extends { readonly kind: "credential-store" }
    ? SettingValue<GlobalSettingsCatalogue[K]> extends boolean
      ? WireOf<K> extends keyof Settings
        ? Settings[WireOf<K>] extends boolean
          ? K
          : never
        : never
      : never
    : never;

/** Every declared boolean whose read and write this module can produce on its own. */
export type DeclaredBooleanKey = {
  [K in GlobalSettingKey]: DerivableBoolean<K>;
}[GlobalSettingKey];

/**
 * A setting's current value.
 *
 * The record is the source where it carries the setting; where it does not yet,
 * the named store field the declaration's `wire` names still is — which is how a
 * tab whose hydration has not moved keeps working (inventory.md P1, P18).
 */
function currentValue(state: Settings, key: SettingKey): unknown {
  const values = state.settingValues;
  if (key in values) return values[key];
  const declaration = settingOf(key);
  const field = mirrorFieldOf(declaration);
  if (field && field in state) return (state as unknown as Record<string, unknown>)[field];
  return declaration.type.defaultValue;
}

/**
 * What is in flight for one setting, and what the server last accepted.
 *
 * A toggle is one click, so two of them overlap the moment the user changes
 * their mind — and reverting a failed save to the opposite of *its own*
 * requested value is wrong as soon as it is not the only save. Off-then-on with
 * both requests failing leaves the server on and the browser off, because the
 * second rollback reverses a value the first one had already put back. So the
 * rollback target is the last value the SERVER accepted, and only the newest
 * request may correct the display.
 *
 * That is not a complete answer, and does not have to be: an older request
 * succeeding *after* a newer one failed leaves the display behind the server,
 * and the write's own `settings_changed` broadcast is what corrects it
 * (`useServerEvents.ts` → `refreshGlobalSettings`).
 */
interface SaveState {
  /** Requests still in flight for this setting. */
  pending: number;
  /** Monotonic per setting; only the highest may correct the display. */
  seq: number;
  /** The last value the server acknowledged — the honest rollback target. */
  confirmed: unknown;
}

const SAVES = new Map<string, SaveState>();

/**
 * The request that stores one setting's value.
 *
 * The settings payload takes every value it carries under the declaration's
 * `wire`; a setting the payload does not carry takes the method, the path and
 * the body field its own store names (inventory.md P2) — the two that use it
 * post different body shapes, so a route string could not have produced either
 * payload.
 */
function requestFor(
  declaration: ReturnType<typeof settingOf>,
  value: unknown,
): { path: string; method: string; body: Record<string, unknown> } | null {
  const { store } = declaration;
  if (store.kind === "credential-store" && declaration.wire) {
    return { path: "/api/settings", method: "PUT", body: { [declaration.wire]: value } };
  }
  if (store.kind === "own-route") {
    return { path: store.path, method: store.method, body: { [store.bodyField]: value } };
  }
  return null;
}

/**
 * Put a value where its declaration says it lives.
 *
 * A browser value is already there once the record has it, so there is nothing
 * to await and no refusal to roll back from. A stored value is written
 * optimistically and then durably, and the server's own value goes back when the
 * save does not land, so a control never shows a state the server refused.
 */
export async function saveSetting(key: SettingKey, value: unknown): Promise<void> {
  const declaration = settingOf(key);
  const apply = (next: unknown) => { useSettingsStore.getState().setSettingValue(key, next); };

  if (declaration.store.kind === "browser") {
    apply(value);
    return;
  }
  const request = requestFor(declaration, value);
  if (!request) {
    throw new Error(`Cannot save "${key}": nothing writes a ${declaration.store.kind} store yet`);
  }

  const existing = SAVES.get(key);
  // With nothing in flight the displayed value IS the server's, so re-seed from
  // it: a `settings_changed` refetch since the last save would otherwise leave
  // `confirmed` describing a value nobody holds any more.
  const state: SaveState = existing && existing.pending > 0
    ? existing
    : {
        pending: 0,
        seq: existing?.seq ?? 0,
        confirmed: currentValue(useSettingsStore.getState(), key),
      };
  SAVES.set(key, state);

  const mine = ++state.seq;
  state.pending += 1;
  apply(value);
  try {
    const res = await fetch(request.path, {
      method: request.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.confirmed = value;
  } catch (err) {
    if (state.seq === mine) apply(state.confirmed);
    // The declaration's own label, so the toast names the control the user just
    // used rather than a second phrasing of it written beside the fetch.
    useUiStore.getState().setToast({ message: `Failed to update ${declaration.label}` });
    console.error(`[settings] saving ${key} failed:`, err);
  } finally {
    state.pending -= 1;
  }
}

/** A declared setting's current value and the only write it needs. */
export function useSetting(key: SettingKey): {
  value: unknown;
  set: (next: unknown) => void;
} {
  const value = useSettingsStore((state) => currentValue(state, key));
  return { value, set: (next) => { void saveSetting(key, next); } };
}

/** {@link useSetting} for a control that is a switch, so the value is a boolean. */
export function useDeclaredBoolean(key: DeclaredBooleanKey): {
  value: boolean;
  set: (next: boolean) => void;
} {
  const { value, set } = useSetting(key);
  return { value: value === true, set };
}

/** Test seam: the in-flight bookkeeping is process-wide and outlives a render. */
export function resetDeclaredSaves(): void {
  SAVES.clear();
}
