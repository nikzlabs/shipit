# Keybinding registry — checklist

- [x] Registry module: defs, `eventMatchesChord`, `isValidChord`, `normalizeChord`, `chordToKeys`/`formatChord`
- [x] Registry tests (matcher, validation, conflict normalization)
- [x] localStorage: `shipit-keybindings` blob + legacy key migration (+ test)
- [x] Settings store: `keybindings` map, `getKeybinding`, `setKeybinding`, `resetKeybinding` (+ test)
- [x] `useKeybinding` selector hook
- [x] Migrate `useKeyboardShortcuts` to registry + matcher
- [x] Migrate `useQuickCaptureHotkey` consumers (App.tsx) to the map
- [x] Migrate MessageInput voice hotkey reads to the map
- [x] `KeybindingCapture` press-keys field
- [x] `KeybindingSettings` Keyboard tab (conflict + reset)
- [x] Add Keyboard tab to Settings.tsx; remove voice hotkey + quick-capture editors from old spots
- [x] Rewrite `KeyboardShortcutsOverlay` to read registry + "Edit" link; update its tests
- [x] Settings store / migration / overlay tests green (`npm run test:dev`)
- [x] `npm run lint:dev` + `npm run typecheck` clean
</content>
