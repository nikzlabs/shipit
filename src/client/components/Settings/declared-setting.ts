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

function readStore(wire: string): boolean {
  return (useSettingsStore.getState() as unknown as Record<string, boolean>)[wire] ?? false;
}

function writeStore(wire: string, value: boolean): void {
  const state = useSettingsStore.getState() as unknown as Record<string, (v: boolean) => void>;
  state[setterName(wire)]?.(value);
}

/**
 * What is in flight for one setting, and what the server last accepted.
 *
 * A toggle is one click, so two of them overlap the moment the user changes
 * their mind — and reverting a failed save to the opposite of *its own*
 * requested value is wrong as soon as it is not the only save. Off-then-on with
 * both requests failing leaves the server on and the browser off, because the
 * second rollback reverses a value the first one had already put back. Reverting
 * to the last value the SERVER accepted, and only from the newest request, is
 * right for every interleaving.
 */
interface SaveState {
  /** Requests still in flight for this field. */
  pending: number;
  /** Monotonic per field; only the highest may correct the display. */
  seq: number;
  /** The last value the server acknowledged — the honest rollback target. */
  confirmed: boolean;
}

const SAVES = new Map<string, SaveState>();

/**
 * Write optimistically, then durably — and put the server's own value back when
 * the save does not land, so the switch never shows a state the server refused.
 */
export async function saveDeclaredBoolean(
  key: DeclaredBooleanKey,
  value: boolean,
): Promise<void> {
  const wire = wireOf(key);
  const existing = SAVES.get(wire);
  // With nothing in flight the displayed value IS the server's, so re-seed from
  // it: a `settings_changed` refetch since the last save would otherwise leave
  // `confirmed` describing a value nobody holds any more.
  const state: SaveState = existing && existing.pending > 0
    ? existing
    : { pending: 0, seq: existing?.seq ?? 0, confirmed: readStore(wire) };
  SAVES.set(wire, state);

  const mine = ++state.seq;
  state.pending += 1;
  writeStore(wire, value);
  try {
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [wire]: value }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.confirmed = value;
  } catch (err) {
    if (state.seq === mine) writeStore(wire, state.confirmed);
    // The declaration's own label, so the toast names the control the user just
    // used rather than a second phrasing of it written beside the fetch.
    useUiStore.getState().setToast({
      message: `Failed to update ${GLOBAL_SETTINGS[key].label}`,
    });
    console.error(`[settings] saving ${key} failed:`, err);
  } finally {
    state.pending -= 1;
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

/** Test seam: the in-flight bookkeeping is process-wide and outlives a render. */
export function resetDeclaredSaves(): void {
  SAVES.clear();
}
