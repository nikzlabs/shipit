# Implementation Checklist

## Phase 1: Skeleton
- [x] Docker setup — Dockerfile, docker-compose.yml
- [x] Fastify backend with WebSocket — spawn Claude CLI, parse NDJSON, relay events
- [x] Minimal React frontend — chat input, message display, WebSocket connection

## Phase 2: Preview
- [x] Vite dev server manager — spawn as child process serving /workspace
- [x] Preview iframe in frontend

## Phase 3: Git & History
- [x] Git integration — auto-commit after each turn
- [x] Git history panel in UI
- [x] Rollback functionality

## Phase 4: Polish
- [x] OAuth flow detection and browser redirect
- [x] Session management (list, resume, new)
- [x] Docs tab (markdown viewer)
- [x] Inline file change display in chat (diff blocks)
- [x] Streaming UX polish (typing indicators, partial renders)

## Phase 5: Next Up
- [x] Resizable panels
- [x] Search in chat history
- [x] Test coverage — Vitest, 133 tests across server/client modules + integration

## Phase 6: Test Depth
- [x] Component-level tests — React component tests (MessageList, DiffBlock, GitHistory) with @testing-library/react
- [x] Integration/E2E tests — full WebSocket flow from client to server, Fastify test harness (19 tests via `buildApp()` DI)
- [x] Error boundary / error state UI — handle WebSocket drops and Claude CLI crashes mid-stream
- [x] Mobile responsiveness — resizable panel layout adaptation for mobile viewports
- [ ] Reconnection UI — visible indicator of WebSocket connection state

## Phase 7: UX & Beyond
- [ ] Persistent chat history — persist messages to the server so they survive page reloads
- [ ] File tree sidebar — show the /workspace file tree alongside the preview
- [ ] Preview port auto-detection — detect when a non-Vite dev server starts on a different port
- [ ] Notification when Claude finishes — browser notification or tab title change for background tabs
- [ ] Code block syntax highlighting — add highlight.js or shiki for code blocks in Claude responses
- [ ] Keyboard shortcuts help — a `?` overlay showing all available shortcuts
- [ ] Message editing/retry — let users edit and resend previous prompts

## Nice to Have
- [ ] Cost display per turn (from result.total_cost_usd)
- [ ] Duration display
- [ ] Dark/light theme
- [ ] Export conversation
