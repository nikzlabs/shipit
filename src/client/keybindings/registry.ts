// Central keyboard-shortcut registry — the single source of truth for which
// shortcuts exist, what they do, their default chords, and whether they can be
// rebound. The ? overlay (display), the Keyboard settings tab (editing), and the
// global keydown handlers all read from here. See docs/180-keybinding-registry.

/** Stable identifiers for every shortcut. */
export type KeybindingId =
  | "toggle-shortcuts"
  | "new-session"
  | "quick-capture"
  | "voice-mode-a"
  | "voice-mode-b"
  // Fixed reference rows (editable: false) — shown for completeness only.
  | "interrupt-agent"
  | "send-message"
  | "newline"
  | "chat-search"
  | "close-overlay";

export type KeybindingGroup = "General" | "Sessions" | "Chat" | "Voice" | "Search";

export interface KeybindingDef {
  id: KeybindingId;
  label: string;
  group: KeybindingGroup;
  /** Chord in "mod+alt+n" notation. Empty for fixed keys that aren't chords. */
  defaultBinding: string;
  /** When false, the row is reference-only and cannot be rebound. */
  editable: boolean;
  /**
   * Global hotkeys that fire even while the user is typing in an input
   * (quick-capture, voice). These must require a second modifier so a stray
   * keypress mid-sentence can't trigger them.
   */
  requiresSecondModifier?: boolean;
  /** Label shown on non-editable rows (e.g. "Enter", "Esc"). */
  fixedHint?: string;
}

/**
 * The registry. Order within a group is the display order. Editable entries are
 * genuine global *commands*; fixed entries are context-sensitive editor
 * behaviors that can't be safely rebound (rebinding Enter-to-send or Esc would
 * break the chat editor), so they're shown read-only.
 */
export const KEYBINDINGS: readonly KeybindingDef[] = [
  {
    id: "toggle-shortcuts",
    label: "Show keyboard shortcuts",
    group: "General",
    defaultBinding: "mod+/",
    editable: true,
  },
  {
    id: "new-session",
    label: "New session",
    group: "Sessions",
    defaultBinding: "mod+shift+o",
    editable: true,
  },
  {
    id: "quick-capture",
    label: "Quick capture",
    group: "Sessions",
    defaultBinding: "mod+alt+n",
    editable: true,
    requiresSecondModifier: true,
  },
  {
    id: "voice-mode-a",
    label: "Dictate into the current input (Mode A)",
    group: "Voice",
    defaultBinding: "ctrl+shift+space",
    editable: true,
    requiresSecondModifier: true,
  },
  {
    id: "voice-mode-b",
    label: "Open quick-capture with mic on (Mode B)",
    group: "Voice",
    defaultBinding: "ctrl+shift+m",
    editable: true,
    requiresSecondModifier: true,
  },
  {
    id: "interrupt-agent",
    label: "Stop the agent while it's running",
    group: "Chat",
    defaultBinding: "",
    editable: false,
    fixedHint: "Esc",
  },
  {
    id: "send-message",
    label: "Send message",
    group: "Chat",
    defaultBinding: "",
    editable: false,
    fixedHint: "Enter",
  },
  {
    id: "newline",
    label: "New line in message",
    group: "Chat",
    defaultBinding: "",
    editable: false,
    fixedHint: "Shift+Enter",
  },
  {
    id: "chat-search",
    label: "Search the chat (when chat input is focused)",
    group: "Search",
    defaultBinding: "",
    editable: false,
    fixedHint: "Ctrl+F",
  },
  {
    id: "close-overlay",
    label: "Close overlay / search bar",
    group: "General",
    defaultBinding: "",
    editable: false,
    fixedHint: "Esc",
  },
] as const;

const BY_ID = new Map<KeybindingId, KeybindingDef>(KEYBINDINGS.map((d) => [d.id, d]));

export function getKeybindingDef(id: KeybindingId): KeybindingDef {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`Unknown keybinding id: ${id}`);
  return def;
}

/** All ids that can be rebound — the set the editing UI and conflict check use. */
export const EDITABLE_KEYBINDING_IDS: readonly KeybindingId[] = KEYBINDINGS.filter(
  (d) => d.editable,
).map((d) => d.id);

const MODIFIER_TOKENS = ["mod", "ctrl", "cmd", "meta", "alt", "opt", "shift"];

interface ParsedChord {
  key: string | null;
  wantsMod: boolean;
  wantsCtrl: boolean;
  wantsMeta: boolean;
  wantsAlt: boolean;
  wantsShift: boolean;
}

function parseChord(chord: string): ParsedChord {
  const parts = chord.toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  return {
    key: parts.find((p) => !MODIFIER_TOKENS.includes(p)) ?? null,
    wantsMod: parts.includes("mod"),
    wantsCtrl: parts.includes("ctrl"),
    wantsMeta: parts.includes("cmd") || parts.includes("meta"),
    wantsAlt: parts.includes("alt") || parts.includes("opt"),
    wantsShift: parts.includes("shift"),
  };
}

/**
 * Strict validity for a chord that's safe to bind to a *global* hotkey: it must
 * have a base key plus a strong modifier (Ctrl/Cmd/Mod). Generalized from the
 * old `isValidQuickCaptureHotkey`. Pass `requireSecondModifier` for hotkeys
 * that fire while typing.
 */
export function isValidChord(chord: string, requireSecondModifier = false): boolean {
  const p = parseChord(chord);
  if (!p.key) return false;
  const hasStrong = p.wantsMod || p.wantsCtrl || p.wantsMeta;
  if (!hasStrong) return false;
  if (requireSecondModifier && !(p.wantsAlt || p.wantsShift)) return false;
  return true;
}

/** Does a keydown event match a chord string? Reused for every global handler. */
export function eventMatchesChord(e: KeyboardEvent, chord: string): boolean {
  const p = parseChord(chord);
  if (!p.key) return false;
  const modOk = p.wantsMod
    ? e.ctrlKey || e.metaKey
    : (!e.ctrlKey || p.wantsCtrl) && (!e.metaKey || p.wantsMeta);
  return (
    modOk &&
    e.ctrlKey === (p.wantsCtrl || (p.wantsMod && e.ctrlKey)) &&
    e.metaKey === (p.wantsMeta || (p.wantsMod && e.metaKey)) &&
    e.altKey === p.wantsAlt &&
    e.shiftKey === p.wantsShift &&
    e.key.toLowerCase() === p.key
  );
}

const IS_MAC = typeof navigator !== "undefined" && /mac|iphone|ipad|ipod/i.test(navigator.userAgent || "");

const KEY_DISPLAY: Record<string, string> = {
  mod: IS_MAC ? "⌘" : "Ctrl",
  ctrl: "Ctrl",
  cmd: "⌘",
  meta: "⌘",
  alt: IS_MAC ? "⌥" : "Alt",
  opt: "⌥",
  shift: IS_MAC ? "⇧" : "Shift",
  " ": "Space",
  space: "Space",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Split a chord into display tokens, e.g. "mod+shift+o" → ["⌘","⇧","O"]. */
export function chordToKeys(chord: string): string[] {
  if (!chord) return [];
  return chord
    .toLowerCase()
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => KEY_DISPLAY[p] ?? (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)));
}

/** Human-readable chord, e.g. "⌘ + ⇧ + O". */
export function formatChord(chord: string): string {
  return chordToKeys(chord).join(" + ");
}

/**
 * Canonical form for equality checks (conflict detection). Collapses
 * ctrl/cmd/meta → "mod" and sorts modifiers, so `ctrl+shift+o` and
 * `mod+shift+o` compare equal (they match the same events).
 */
export function normalizeChord(chord: string): string {
  const p = parseChord(chord);
  if (!p.key) return chord.toLowerCase();
  const mods: string[] = [];
  if (p.wantsMod || p.wantsCtrl || p.wantsMeta) mods.push("mod");
  if (p.wantsAlt) mods.push("alt");
  if (p.wantsShift) mods.push("shift");
  return [...mods, p.key].join("+");
}

/**
 * Build a chord string from a keydown event during capture. Returns null if the
 * event is only a modifier press (so the UI keeps waiting for a real key).
 */
export function chordFromEvent(e: KeyboardEvent): string | null {
  const key = e.key;
  if (["Control", "Meta", "Alt", "Shift", "OS", "Dead"].includes(key)) return null;
  const parts: string[] = [];
  // Normalize Ctrl/Cmd to "mod" so a binding captured on one platform works on
  // the other (the matcher treats "mod" as Ctrl-or-Cmd).
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  const base = key === " " ? "space" : key.toLowerCase();
  parts.push(base);
  return parts.join("+");
}
