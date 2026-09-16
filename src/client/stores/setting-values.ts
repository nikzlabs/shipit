/**
 * The generic value record behind the generated settings rows
 * (docs/308-data-driven-settings plan.md → One reader, → The renderer): which
 * settings it holds, how a browser value is encoded, and the named store field
 * each one is also held in.
 */

import {
  ALL_SETTINGS,
  type AnySettingDeclaration,
  type OwnRouteStore,
  type SettingTab,
  type SettingValueKind,
} from "../../server/shared/settings-catalogue/index.js";

/**
 * The tabs whose rows are generated, and so the settings this record holds.
 *
 * A tab joins the list in the slice that moves its hydration here; until then
 * its values stay with the named store fields and their own setters, because a
 * half-converted tab either duplicates a control or renders a row that cannot
 * save (inventory.md P18).
 */
const GENERATED_TABS: readonly SettingTab[] = ["advanced", "network"];

/** The stores `saveSetting` can write. */
const WRITABLE_STORES: ReadonlySet<string> = new Set(["credential-store", "browser", "own-route"]);

/**
 * The value kinds the control table has a control for. `number` and `text` are
 * absent because no generated tab has one that a component does not own: the
 * memory budget is a component (P4), and the instruction boxes arrive with
 * slice 3.
 */
const GENERATED_KINDS: ReadonlySet<SettingValueKind> = new Set<SettingValueKind>(["bool", "enum"]);

/**
 * How a value kind is written to and read back from `localStorage`.
 *
 * **Keeping the storage key is necessary and not sufficient** (req 9, P17).
 * `localStorage` holds strings, and a value type reads anything that is not
 * already its own shape as the default — `bool.read("true")` is the default, not
 * `true` — so handing stored text straight to `type.read()` would silently reset
 * every browser boolean the user had ever set.
 */
interface BrowserCodec {
  decode(raw: string, declaration: AnySettingDeclaration): unknown;
  encode(value: unknown): string;
}

const BROWSER_CODECS: Partial<Record<SettingValueKind, BrowserCodec>> = {
  bool: {
    // `String(enabled)` is the form every browser boolean is already stored in.
    // Anything else was never written by ShipIt, so it reads as the default.
    decode: (raw, declaration) =>
      raw === "true" ? true : raw === "false" ? false : declaration.type.defaultValue,
    encode: (value) => String(value),
  },
};

/**
 * A declaration the renderer produces a row for.
 *
 * A declaration naming a `component` qualifies whatever its value kind, because
 * what the control table has no control for is exactly what a component is for
 * (req 3) — the store still has to be one the writer can reach, since a
 * component saves through the same writer every row uses.
 *
 * An addressed declaration is excluded because it describes one item of a
 * collection, which a panel renders per item rather than once (P11).
 */
export function isGeneratedRow(declaration: AnySettingDeclaration): boolean {
  return !declaration.address
    && GENERATED_TABS.includes(declaration.tab)
    && (declaration.component !== undefined || GENERATED_KINDS.has(declaration.type.kind))
    && WRITABLE_STORES.has(declaration.store.kind)
    && storable(declaration);
}

/**
 * A browser value needs a codec for its kind, and the rest need nothing.
 *
 * Without this a browser ENUM would render, change on screen and write nothing
 * at all — `writeBrowserValue` has no codec to encode it with, and the next
 * reload would answer the default. `localStorage` holds strings, so a store
 * that cannot spell a kind cannot hold it (P17).
 */
function storable(declaration: AnySettingDeclaration): boolean {
  return declaration.store.kind !== "browser" || declaration.type.kind in BROWSER_CODECS;
}

/** Every generated row, in declaration order — which is the order they render in. */
export const GENERATED_SETTINGS: readonly AnySettingDeclaration[] =
  ALL_SETTINGS.filter(isGeneratedRow);

/**
 * What the record holds, fixed rather than grown on first write.
 *
 * A setting outside it is read through its named store field, and that field is
 * what its own hydration still writes — so recording a value for it on a save
 * would leave the record holding a value the next hydration never corrects, and
 * the reader preferring it (P1, P18). `integrations.autoCreatePr` and
 * `instructions.agentInstructionsEnabled` are the two that reach this writer
 * today; their tabs convert in slices 5 and 3.
 */
const RECORD_KEYS: ReadonlySet<string> = new Set(GENERATED_SETTINGS.map((d) => d.key));

export function recordHolds(key: string): boolean {
  return RECORD_KEYS.has(key);
}

/** Where a generated own-route row is written, and read back from (P2). */
export function ownRouteOf(declaration: AnySettingDeclaration): OwnRouteStore | undefined {
  return declaration.store.kind === "own-route" ? declaration.store : undefined;
}

/** Every generated row the settings payload does not carry, so it is read on its own. */
export const OWN_ROUTE_SETTINGS: readonly AnySettingDeclaration[] =
  GENERATED_SETTINGS.filter((d) => d.store.kind === "own-route");

function storageKeyOf(declaration: AnySettingDeclaration): string {
  return (declaration.store as { localStorageKey: string }).localStorageKey;
}

export function readBrowserValue(declaration: AnySettingDeclaration): unknown {
  const codec = BROWSER_CODECS[declaration.type.kind];
  if (!codec) return declaration.type.defaultValue;
  let raw: string | null;
  try {
    raw = localStorage.getItem(storageKeyOf(declaration));
  } catch {
    return declaration.type.defaultValue;
  }
  return raw === null ? declaration.type.defaultValue : codec.decode(raw, declaration);
}

export function writeBrowserValue(declaration: AnySettingDeclaration, value: unknown): void {
  const codec = BROWSER_CODECS[declaration.type.kind];
  if (!codec) return;
  try {
    localStorage.setItem(storageKeyOf(declaration), codec.encode(value));
  } catch {
    // A display preference still works when storage is unavailable.
  }
}

/**
 * The named store fields a browser value is ALSO held in (P1).
 *
 * The 51 lines that read `compactConversation` and its siblings keep reading
 * them, so each stays a view over the record rather than a second copy. A
 * payload setting needs no entry: its field is the declaration's `wire`.
 */
const BROWSER_MIRRORS: Record<string, string> = {
  "advanced.compactConversation": "compactConversation",
  "advanced.notifyOnFinish": "notifyOnFinish",
  "advanced.soundOnFinish": "soundOnFinish",
};

export function mirrorFieldOf(declaration: AnySettingDeclaration): string | undefined {
  return declaration.wire ?? BROWSER_MIRRORS[declaration.key];
}

/** The record as the page loads: the browser's own values, and the declared defaults. */
export function initialSettingValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const declaration of GENERATED_SETTINGS) {
    values[declaration.key] = declaration.store.kind === "browser"
      ? readBrowserValue(declaration)
      : declaration.type.defaultValue;
  }
  return values;
}
