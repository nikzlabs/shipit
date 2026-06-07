---
title: Keyboard shortcut registry + unified editing
description: One source of truth for keyboard shortcuts, edited in a single Settings tab and mirrored read-only in the ? overlay.
---

# Keyboard shortcut registry

## Why

Before this feature, keyboard shortcuts lived in two disconnected places:

1. **The `?` overlay** (`KeyboardShortcutsOverlay.tsx`) — a *hardcoded* `shortcutGroups`
   array that only *described* shortcuts. It was decoupled from the code that
   actually handled the keys, so it silently drifted from reality.
2. **The Voice settings tab** — the only place anything was *editable*: voice
   Mode A / Mode B hotkeys (plus the quick-capture hotkey in the old General
   "Shortcuts" block). Everything else (`Ctrl+/`, `Ctrl+Shift+O`, `Esc`) was
   fixed in code with no UI.

The actual handlers were scattered `useEffect` keydown listeners
(`useKeyboardShortcuts.ts`, `useQuickCaptureHotkey.ts`) that each hand-rolled
their own `e.key` checks. There was no registry, so "what shortcuts exist" had
no single answer and "make a shortcut editable" was a per-shortcut special case.

This feature introduces a **central keybinding registry** as the single source
of truth. The display (overlay), the editing UI (a new Keyboard settings tab),
and the handlers all read from it. A shortcut is editable because the registry
says so, not because someone wired a bespoke field.

## Design

### Registry (`src/client/keybindings/registry.ts`)

A typed list of `KeybindingDef`:

```ts
interface KeybindingDef {
  id: KeybindingId;            // stable string union
  label: string;               // human description
  group: KeybindingGroup;      // "General" | "Sessions" | "Chat" | "Voice" | "Search"
  defaultBinding: string;      // chord in "mod+alt+n" notation ("" for fixed keys)
  editable: boolean;           // false → reference-only row
  requiresSecondModifier?: boolean; // global hotkeys that fire while typing
  fixedHint?: string;          // shown on non-editable rows ("Enter", "Esc", …)
}
```

- **Editable command shortcuts**: `toggle-shortcuts` (`mod+/`),
  `new-session` (`mod+shift+o`), `quick-capture` (`mod+alt+n`),
  `voice-mode-a` (`ctrl+shift+space`), `voice-mode-b` (`ctrl+shift+m`).
- **Fixed reference rows** (`editable: false`): interrupt agent (`Esc`),
  send message (`Enter`), newline (`Shift+Enter`), chat search (`mod+f`),
  close overlay (`Esc`). These are context-sensitive editor behaviors that
  can't be safely rebound; they're shown for completeness.

The matcher (`eventMatchesChord`) and validity helper (`isValidChord`) are
generalized from the old `eventMatchesHotkey` / `isValidQuickCaptureHotkey`
(`useQuickCaptureHotkey` now delegates to them for back-compat).
`normalizeChord` collapses ctrl/cmd/meta → `mod` for conflict detection. The
proven chord logic already handles `mod+/`,
`mod+shift+o`, `Esc`, etc. — bare `?` stays a hardcoded fallback in the
toggle-help handler because its implied Shift can't round-trip through the
strict matcher.

### Storage + state

The settings store holds one `keybindings: Record<KeybindingId, string>` map
(replacing the old `quickCaptureHotkey` / `voiceHotkeyModeA` / `voiceHotkeyModeB`
fields). It is persisted as a single JSON blob under `shipit-keybindings` in
localStorage. On first read we **migrate** the legacy per-key localStorage
entries (`shipit-quick-capture-hotkey`, `shipit-voice-hotkey-mode-a/-b`) so
existing users keep their custom bindings. `setKeybinding(id, chord)` and
`resetKeybinding(id)` write through to localStorage. `useKeybinding(id)` resolves
the override or the registry default.

### UI

- **`KeybindingSettings.tsx`** — a new "Keyboard" tab in Settings. Lists every
  registry entry grouped by `group`. Editable rows use a **press-keys** capture
  field (`KeybindingCapture.tsx`) instead of free-text. Shows validity errors,
  conflict warnings (two editable bindings resolving to the same chord), and a
  per-row "Reset". The voice hotkey editors were removed from the Voice tab and
  the quick-capture editor from the old General "Shortcuts" block — they live
  here now.
- **`KeyboardShortcutsOverlay.tsx`** — rewritten to render from the registry
  (read-only quick view). Keeps the fast `Ctrl+/` / `?` peek and adds an
  "Edit shortcuts →" button that opens Settings on the Keyboard tab.

## Key files

- `src/client/keybindings/registry.ts` — defs, matcher, validators, formatter
- `src/client/keybindings/registry.test.ts` — matcher + conflict coverage
- `src/client/stores/settings-store.ts` — `keybindings` map + setters
- `src/client/utils/local-storage.ts` — `shipit-keybindings` blob + legacy migration
- `src/client/hooks/useKeyboardShortcuts.ts` — registry-driven global handlers
- `src/client/hooks/useQuickCaptureHotkey.ts` — re-exports matcher; unchanged API
- `src/client/components/KeybindingSettings.tsx` — Keyboard settings tab
- `src/client/components/KeybindingCapture.tsx` — press-keys capture field
- `src/client/components/KeyboardShortcutsOverlay.tsx` — read-only mirror + Edit link
- `src/client/components/Settings.tsx` — Keyboard tab; voice/quick-capture editors removed
