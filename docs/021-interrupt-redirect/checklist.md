# 021 — Interrupt and Redirect: Remaining Work

Nothing has been implemented yet. `ClaudeProcess` has `kill()` but no `interrupt()`, and there is no Stop button UI.

## Remaining

- [ ] Add `WsInterruptClaude`, `WsClaudeInterrupted` types to `src/server/types.ts`
- [ ] Add `interrupt()` method to `src/server/claude.ts` (write `\x03` to PTY, force-kill fallback after 5s timeout)
- [ ] Add `interrupt_claude` handler and `wasInterrupted` flag (suppresses spurious error on exit) in `src/server/index.ts`
- [ ] Handle `claude_interrupted` event in `src/client/App.tsx` (clear loading state, append "_(Interrupted by user)_" to last message, Escape shortcut)
- [ ] Replace Send button with Stop button during loading in `src/client/components/MessageInput.tsx` (or add `StopButton.tsx` component alongside)
- [ ] Create `src/server/integration_tests/interrupt.test.ts` (interrupt active process, interrupt when idle, partial commit, resume after interrupt)
