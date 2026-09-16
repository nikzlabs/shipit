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
export const GENERATED_TABS: readonly SettingTab[] =
  ["advanced", "network", "instructions", "git", "voice"];

/**
 * The stores `saveSetting` can write. The three payload stores share
 * `PUT /api/settings` and differ only in the field the declaration's `wire`
 * names, which is why the writer dispatches on the payload/non-payload split
 * rather than on each kind.
 */
const WRITABLE_STORES: ReadonlySet<string> = new Set([
  "credential-store", "system-prompt-file", "git-config", "browser", "own-route",
]);

/**
 * The value kinds the control table has a control for, except `text`, whose
 * control is chosen by the store rather than by the kind — see {@link hasControl}.
 * `number` is absent because the one generated tab that has one gives it a
 * component (P4).
 */
const GENERATED_KINDS: ReadonlySet<SettingValueKind> = new Set<SettingValueKind>([
  "bool", "enum", "gitIdentity",
]);

/**
 * Whether the renderer has a control for this declaration.
 *
 * **The textarea rule is a gate, not just a branch** (plan.md → The renderer).
 * `text`'s control is a textarea, and the `system-prompt-file` store is what
 * says a value is prose rather than a line — which is why the design rejected a
 * `presentation: "multiline"` field. The consequence is that a `text` row over
 * any other store has no control yet, so it is not a generated row at all; a
 * one-line input arrives with the first setting that needs one, rather than as
 * a branch nothing runs.
 */
function hasControl(declaration: AnySettingDeclaration): boolean {
  if (declaration.type.kind === "text") return declaration.store.kind === "system-prompt-file";
  return GENERATED_KINDS.has(declaration.type.kind);
}

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
  // A choice and a line of text are stored as themselves, so `read` is already
  // the right reader: it answers the declared default for a stored option the
  // catalogue no longer offers, which is the one thing `getSavedString` did not
  // do — a select whose value is not among its options renders blank.
  enum: { decode: (raw, declaration) => declaration.type.read(raw), encode: String },
  text: { decode: (raw, declaration) => declaration.type.read(raw), encode: String },
  // `String(value)` is the form the speed is already stored in, and the parse has
  // to happen here: `numeric.read` answers its default for a string, so handing
  // it the stored text would reset every saved speed to 1 (P17).
  number: {
    decode: (raw, declaration) => declaration.type.read(Number(raw)),
    encode: String,
  },
};

/**
 * A declaration the renderer produces a row for.
 *
 * A declaration naming a `component` qualifies whatever its value kind, its
 * address and its store: what the control table has no control for is exactly
 * what a component is for (req 3), and a component that owns an addressed
 * declaration renders it per item rather than as a row (P11) — which is the
 * whole of "the renderer must not treat an addressed declaration as a standalone
 * row". Without a component, an addressed declaration belongs to a panel and is
 * skipped here.
 */
export function isGeneratedRow(declaration: AnySettingDeclaration): boolean {
  if (!GENERATED_TABS.includes(declaration.tab)) return false;
  if (declaration.component !== undefined) return true;
  return !declaration.address && hasControl(declaration) && sharedValue(declaration);
}

/**
 * Whether the shared reader and writer can hold this setting's value.
 *
 * A component may be named by a declaration they cannot — `voice.providerKey` is
 * addressed by a provider and its write carries a second body field, so the list
 * that owns it writes its own request, as a panel does (plan.md → The shape).
 * What that must not do is put a value in the record: nothing would ever hydrate
 * it, and the reader prefers the record over the named field (P1, P18).
 */
function sharedValue(declaration: AnySettingDeclaration): boolean {
  return WRITABLE_STORES.has(declaration.store.kind) && storable(declaration);
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

/** The generated rows whose value the shared reader and writer carry. */
const RECORDED_SETTINGS: readonly AnySettingDeclaration[] =
  GENERATED_SETTINGS.filter(sharedValue);

/**
 * What the record holds, fixed rather than grown on first write.
 *
 * A setting outside it is read through its named store field, and that field is
 * what its own hydration still writes — so recording a value for it on a save
 * would leave the record holding a value the next hydration never corrects, and
 * the reader preferring it (P1, P18). `integrations.autoCreatePr` is the one
 * that reaches this writer today; its tab converts in slice 5.
 */
const RECORD_KEYS: ReadonlySet<string> = new Set(RECORDED_SETTINGS.map((d) => d.key));

export function recordHolds(key: string): boolean {
  return RECORD_KEYS.has(key);
}

/**
 * Two values are the same value.
 *
 * `===` is enough for every scalar a row holds; a composite — the git identity's
 * name and email — is compared by its rendered form, because an edited one is a
 * fresh object on every keystroke and would otherwise always look changed. Both
 * sides are built by this client or read from the settings payload, so their
 * fields are written in one order.
 */
export function sameSettingValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Where a generated own-route row is written, and read back from (P2). */
export function ownRouteOf(declaration: AnySettingDeclaration): OwnRouteStore | undefined {
  return declaration.store.kind === "own-route" ? declaration.store : undefined;
}

/** Every generated row the settings payload does not carry, so it is read on its own. */
export const OWN_ROUTE_SETTINGS: readonly AnySettingDeclaration[] =
  RECORDED_SETTINGS.filter((d) => d.store.kind === "own-route");

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
  "voice.inputEnabled": "voiceInputEnabled",
  "voice.sttProvider": "sttProvider",
  "voice.cleanupEnabled": "cleanupEnabled",
  "voice.language": "voiceLanguage",
  "voice.playbackEnabled": "voicePlaybackEnabled",
  "voice.ttsProvider": "ttsProvider",
  "voice.ttsVoice": "ttsVoice",
  "voice.ttsSpeed": "ttsSpeed",
  "voice.handsFree": "voiceHandsFree",
};

export function mirrorFieldOf(declaration: AnySettingDeclaration): string | undefined {
  return declaration.wire ?? BROWSER_MIRRORS[declaration.key];
}

/** The record as the page loads: the browser's own values, and the declared defaults. */
export function initialSettingValues(): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const declaration of RECORDED_SETTINGS) {
    values[declaration.key] = declaration.store.kind === "browser"
      ? readBrowserValue(declaration)
      : declaration.type.defaultValue;
  }
  return values;
}
