# 021 — Interrupt and Redirect: Remaining Work

All items completed.

## Remaining

- [x] Add `WsInterruptClaude`, `WsClaudeInterrupted` types to `src/server/types.ts`
- [x] Add `interrupt()` method to `src/server/claude.ts` (write `\x03` to PTY, force-kill fallback after 5s timeout)
- [x] Add `interrupt()` to `AgentProcess` interface and all adapters (ClaudeAdapter, CodexAdapter)
- [x] Add `interrupt_claude` handler and `wasInterrupted` flag (suppresses spurious error on exit) in `src/server/index.ts`
- [x] Handle `claude_interrupted` event in `src/client/App.tsx` (clear loading state, append "_(Interrupted by user)_" to last message, Escape shortcut)
- [x] Replace Send button with Stop button during loading in `src/client/components/MessageInput.tsx`
- [x] Add Escape shortcut to `src/client/components/KeyboardShortcutsOverlay.tsx`
- [x] Create `src/server/integration_tests/interrupt.test.ts` (interrupt active process, interrupt when idle, no spurious error, queue clear, resume after interrupt)
