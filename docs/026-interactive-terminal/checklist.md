# 026 — Interactive Terminal: Checklist

## Dependencies

- [ ] Add xterm.js packages to `package.json` (`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-web-links`)

## Server

- [ ] Create `TerminalProcess` class in `src/server/terminal.ts` (spawn shell, write, resize, kill)
- [ ] Add message types to `src/server/types.ts`: `WsTerminalInput`, `WsTerminalResize`, `WsTerminalStart`, `WsTerminalOutput`, `WsTerminalExit`
- [ ] Add `terminal_start` handler in `src/server/index.ts` (lazy spawn, per-connection instance)
- [ ] Add `terminal_input` handler in `src/server/index.ts`
- [ ] Add `terminal_resize` handler in `src/server/index.ts` (with bounds clamping)
- [ ] Clean up terminal process on WebSocket disconnect

## Client

- [ ] Create `InteractiveTerminal.tsx` — xterm.js component with FitAddon and WebLinksAddon
- [ ] Terminal output forwarding via ref (not React state) for performance
- [ ] Add Logs/Shell sub-tab switcher to `TerminalPanel.tsx`
- [ ] Lazy shell start — only spawn when "Shell" tab first clicked
- [ ] Add `terminalMode` state to `App.tsx` (`"logs"` | `"shell"`)
- [ ] Add `handleTerminalInput`, `handleTerminalResize`, `handleTerminalStart` callbacks in `App.tsx`
- [ ] Handle `terminal_output` and `terminal_exit` messages in `App.tsx`

## Tests

- [ ] Integration tests: `src/server/integration_tests/interactive-terminal.test.ts`
  - [ ] Start terminal → shell spawns → prompt output received
  - [ ] Input/output: send "echo hello\n" → output contains "hello"
  - [ ] Resize → no errors
  - [ ] Exit: send "exit\n" → `terminal_exit` received
  - [ ] Multiple starts → no duplicate shells
  - [ ] Cleanup on disconnect → process killed
- [ ] Component tests: `src/client/components/InteractiveTerminal.test.tsx`
  - [ ] Mounts and calls onStart
  - [ ] Writes received data to terminal instance
  - [ ] User input triggers onInput callback
  - [ ] Container resize triggers onResize callback
  - [ ] Unmount cleans up terminal instance
