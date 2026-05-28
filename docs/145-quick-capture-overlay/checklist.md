- [x] Add headless-session service and HTTP route.
- [x] Add quick-capture UI store state and global hotkey.
- [x] Reuse `MessageInput` in an overlay with an overlay-specific surface mode.
- [x] Add client action for creating headless sessions without navigation.
- [x] Add quick-capture overlay shell with repo selection, submit, dismiss, and error states.
- [x] Add shortcut settings persistence and Settings UI.
- [x] Add notification coalescing for bursty session completions.
- [x] Add broader test coverage for all planned edge cases.
- [x] Run cross-browser/manual hotkey verification.
- [x] Wire file attachments in the overlay: lift upload state into
      `MessageInput`, change `onSend` to a `{text, uploadRefs, uploads,
      deferredFiles}` payload, and POST multipart to `/api/sessions/headless`
      when `deferredFiles` is non-empty. Server saves files into the new
      session's `uploads/` before `runner.dispatch({ text, uploads })`. Both
      parents now share the same upload UX — the previous split-parent
      wiring is what caused the "+" button to silently no-op in the overlay.
