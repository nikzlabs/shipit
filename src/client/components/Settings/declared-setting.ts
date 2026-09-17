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
 *
 * A row that commits on a button rather than on change uses the other half of
 * this module: {@link useSettingDraft} holds the edit, and
 * {@link commitSettings} stores several of them in one write.
 */

import { useSettingsStore } from "../../stores/settings-store.js";
import { useUiStore } from "../../stores/ui-store.js";
import {
  GENERATED_SETTINGS,
  SETTINGS_PATH,
  sameSettingValue,
  settingRequest,
} from "../../stores/setting-values.js";
import { settingOf } from "./setting-copy.js";
import {
  isPayloadDeclaration,
  type AnySettingDeclaration,
  type GlobalSettingKey,
  type GlobalSettingsCatalogue,
  type OwnRouteStore,
  type SettingKey,
  type SettingTab,
  type SettingValue,
} from "../../../server/shared/settings-catalogue/index.js";

type Settings = ReturnType<typeof useSettingsStore.getState>;

/** The `GlobalSettings` / `PUT /api/settings` field a declaration names. */
type WireOf<K extends GlobalSettingKey> =
  GlobalSettingsCatalogue[K] extends { readonly wire: infer W extends string } ? W : never;

/**
 * A declared boolean the browser store already holds under its wire name.
 *
 * Both clauses have to hold, because the rest of the app still reads the value
 * through that field — it is a view over the record (inventory.md P1). It used
 * to demand a `set<Wire>` setter beside it as well; that was a proxy for
 * "something hydrates this field", and hydration now walks the declarations
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
 * A setting's current value: the record, and nothing else.
 *
 * The fall-back to the named store field is gone with the last unconverted tab
 * (slice 8). Every key that reaches here is one the record holds — it is seeded
 * with exactly those and `setSettingValue` refuses any other — so what a
 * fall-back would serve now is a declared default for a component named by a
 * declaration the record deliberately does NOT hold (`voice.providerKey`, the
 * five repository settings). `undefined` is the louder failure for that call.
 */
function currentValue(state: Settings, key: SettingKey): unknown {
  return state.settingValues[key];
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
 * Put a value where its declaration says it lives, and answer whether it landed.
 *
 * A browser value is already there once the record has it, so there is nothing
 * to await and no refusal to roll back from. A stored value is written
 * optimistically and then durably, and the server's own value goes back when the
 * save does not land, so a control never shows a state the server refused.
 *
 * It answers `true` once the value is stored and `false` when the server refused
 * it — for a control that reports its own save, since the rollback is invisible
 * to one holding its own draft. A store nothing writes still THROWS: that is a
 * declaration nobody could have saved, not a refusal the user can retry.
 */
export async function saveSetting(key: SettingKey, value: unknown): Promise<boolean> {
  const declaration = settingOf(key);
  const apply = (next: unknown) => { useSettingsStore.getState().setSettingValue(key, next); };

  if (declaration.store.kind === "browser") {
    apply(value);
    return true;
  }
  const request = settingRequest(declaration, value);
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
    return true;
  } catch (err) {
    if (state.seq === mine) apply(state.confirmed);
    // The declaration's own label, so the toast names the control the user just
    // used rather than a second phrasing of it written beside the fetch.
    useUiStore.getState().setToast({ message: `Failed to update ${declaration.label}` });
    console.error(`[settings] saving ${key} failed:`, err);
    return false;
  } finally {
    state.pending -= 1;
  }
}

/**
 * A declared setting's current value and the only write it needs.
 *
 * `set` hands back {@link saveSetting}'s outcome rather than swallowing it, so
 * there is one place to read whether a write landed rather than two.
 */
export function useSetting(key: SettingKey): {
  value: unknown;
  set: (next: unknown) => Promise<boolean>;
} {
  const value = useSettingsStore((state) => currentValue(state, key));
  return { value, set: (next) => saveSetting(key, next) };
}

export interface SettingDraftView {
  /** What the control shows: the draft while there is one, otherwise the stored value. */
  value: unknown;
  /** The stored value moved since this edit began (inventory.md P14). */
  changedElsewhere: boolean;
  set: (next: unknown) => void;
}

/**
 * An explicit-commit row's value.
 *
 * A draft exists from the user's first keystroke until the write that carries it
 * lands, or until the dialog closes — **it is never dropped because it happens
 * to equal something**. A box that has been typed in therefore always shows what
 * was typed, which is the whole of "no keystroke is lost": dropping a draft that
 * had returned to the value it started from left a stale seed behind, and the
 * next edit after an outside change then vanished.
 *
 * So a box the user has NOT touched has no draft and adopts a value that moves
 * underneath it, which is what stops Save writing back a stale value nobody saw;
 * one they have touched keeps what they typed and reports that the stored value
 * moved (P14).
 */
export function useSettingDraft(key: SettingKey): SettingDraftView {
  const stored = useSettingsStore((state) => currentValue(state, key));
  const draft = useSettingsStore((state) => state.settingDrafts[key]);
  return {
    value: draft ? draft.value : stored,
    changedElsewhere: draft !== undefined && !sameSettingValue(stored, draft.seed),
    set: (next) => { useSettingsStore.getState().setSettingDraft(key, next, stored); },
  };
}

export interface PendingEdit {
  declaration: AnySettingDeclaration;
  key: SettingKey;
  value: unknown;
}

/** Every uncommitted edit on one tab, in declaration order. */
export function useTabDrafts(tab: SettingTab): readonly PendingEdit[] {
  const drafts = useSettingsStore((state) => state.settingDrafts);
  return GENERATED_SETTINGS.flatMap((declaration) => {
    const draft = drafts[declaration.key];
    if (declaration.tab !== tab || !draft) return [];
    return [{ declaration, key: declaration.key as SettingKey, value: draft.value }];
  });
}

/** Where a value is stored, as the one string that says two settings share a write. */
function destinationOf(declaration: AnySettingDeclaration): { method: string; path: string } {
  if (isPayloadDeclaration(declaration)) return { method: "PUT", path: SETTINGS_PATH };
  if (declaration.store.kind === "own-route") {
    return { method: declaration.store.method, path: declaration.store.path };
  }
  throw new Error(
    `Cannot commit "${declaration.key}": ${declaration.store.kind} has no shared write`,
  );
}

/** The field this setting occupies in the request body, and answers under. */
function fieldOf(declaration: AnySettingDeclaration): string {
  return declaration.wire ?? (declaration.store as OwnRouteStore).bodyField;
}

/** Monotonic per commit destination; only the newest response may move the record. */
const COMMITS = new Map<string, number>();

/**
 * Store several settings in ONE write, and tell the caller whether it landed.
 *
 * The destination comes from the declarations, and **every entry must share it**:
 * the settings payload takes each of its fields at once, which is what the
 * catalogue's `instructions.commit` exclusion describes, and the voice webhook's
 * URL and token are one credential at one address, so they are one request too
 * (plan.md → Slices → 4). Nothing today commits across two destinations, so
 * nothing here fans out — a caller that mixes them is a mistake, and it is
 * refused by name rather than silently split.
 *
 * **No optimistic write and no rollback** (plan.md → One writer, for the
 * scalars). A row that commits on a button has its edit in the draft, where the
 * user can still see it; the record moves only once the server has answered, and
 * it moves to the value the server ECHOED — the writers trim, so the stored
 * value is not always the one that was sent. A field the answer omits leaves the
 * record alone, which is how a write-only half is stored without being read back:
 * nothing echoes the webhook token, and inventing a value for it would be the one
 * place the browser held a secret it may not see. A refused write moves nothing
 * and keeps every draft, because that is the user's unsaved work.
 *
 * **Two commits of one destination are sequenced HERE, not by the button.** A
 * Save is disabled while its own write is in flight, and that was the whole of
 * it until review found the hole: the button's state is a component's, so
 * switching tabs re-mounts it enabled while the first request is still out, and
 * the older of two responses could then put the older value in the record with
 * the server holding the newer. This map is module-level and outlives every
 * control, exactly as {@link saveSetting}'s does.
 */
export async function commitSettings(
  entries: readonly (readonly [SettingKey, unknown])[],
): Promise<boolean> {
  if (entries.length === 0) return true;
  const pending = entries.map(([key, value]) => {
    const declaration = settingOf(key);
    return { key, value, declaration, field: fieldOf(declaration) };
  });
  const first = pending[0];
  if (!first) return true;
  const { method, path } = destinationOf(first.declaration);
  const elsewhere = pending.find((p) => destinationOf(p.declaration).path !== path);
  if (elsewhere) {
    throw new Error(
      `Cannot commit "${elsewhere.key}" with "${first.key}": different destinations`,
    );
  }

  const mine = (COMMITS.get(path) ?? 0) + 1;
  COMMITS.set(path, mine);
  try {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(pending.map((p) => [p.field, p.value]))),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const stored = await res.json() as Record<string, unknown>;
    // An older write's answer describes a state nobody is in any more: the newer
    // one is what the server holds, and the drafts belong to whatever is newest.
    if (COMMITS.get(path) !== mine) return true;
    const { setSettingValue, settleSettingDrafts } = useSettingsStore.getState();
    for (const { key, field } of pending) {
      if (stored[field] !== undefined) setSettingValue(key, stored[field]);
    }
    settleSettingDrafts(pending.map(({ key, value }) => ({ key, value })));
    return true;
  } catch (err) {
    useUiStore.getState().setToast({
      message: `Failed to save ${pending.map((p) => p.declaration.label).join(" and ")}`,
    });
    console.error(`[settings] committing ${entries.map(([key]) => key).join(", ")} failed:`, err);
    return false;
  }
}

/** {@link useSetting} for a control that is a switch, so the value is a boolean. */
export function useDeclaredBoolean(key: DeclaredBooleanKey): {
  value: boolean;
  set: (next: boolean) => Promise<boolean>;
} {
  const { value, set } = useSetting(key);
  return { value: value === true, set };
}

/** Test seam: the in-flight bookkeeping is process-wide and outlives a render. */
export function resetDeclaredSaves(): void {
  SAVES.clear();
  COMMITS.clear();
}
