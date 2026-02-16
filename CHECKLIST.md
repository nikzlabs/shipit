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
- [x] Test coverage — Vitest, 236 tests across server/client modules + integration

## Phase 6: Test Depth
- [x] Component-level tests — React component tests (MessageList, DiffBlock, GitHistory) with @testing-library/react
- [x] Integration/E2E tests — full WebSocket flow from client to server, Fastify test harness (19 tests via `buildApp()` DI)
- [x] Error boundary / error state UI — handle WebSocket drops and Claude CLI crashes mid-stream
- [x] Mobile responsiveness — resizable panel layout adaptation for mobile viewports
- [x] Reconnection UI — visible indicator of WebSocket connection state

## Phase 7: UX & Beyond
- [x] Persistent chat history — persist messages to the server so they survive page reloads
- [x] File tree sidebar — show the /workspace file tree alongside the preview
- [x] Preview port auto-detection — detect when a non-Vite dev server starts on a different port
- [x] Notification when Claude finishes — browser notification or tab title change for background tabs
- [x] Code block syntax highlighting — add highlight.js or shiki for code blocks in Claude responses
- [x] Keyboard shortcuts help — a `?` overlay showing all available shortcuts
- [x] Message editing/retry — let users edit and resend previous prompts
- [x] Preview port selector — when multiple ports are detected, let the user choose which one to preview (currently shows first found)
- [x] Periodic port scanning — scan on an interval, not just after Claude turns, to catch servers started via Bash tool mid-turn
- [x] File content viewer — clicking a file in the Files tab could show its contents in a read-only viewer
- [x] Terminal/logs panel — show Claude CLI stdout/stderr in a terminal-like pane for debugging
- [x] Session rename — currently titles are auto-generated from the first message
- [x] Workspace project templates — quick-start templates (Vite + React, Next.js, Express) to avoid the cold-start friction

## Phase 8: High-Impact Features (see PHASE8-DESIGN.md for details)

### P0 — Core
- [ ] Cost & duration dashboard — show per-turn cost/duration below assistant messages, session totals in header (types already in `ClaudeResultEvent`)
- [ ] Image & screenshot input — drag-and-drop, paste, and upload images into chat for multimodal vibe coding (Claude already supports vision)

### P1 — Feedback Loop
- [ ] Preview error capture — inject error reporter into preview iframe, surface console errors in terminal/chat, "Send to Claude" button, optional auto-fix loop
- [ ] System prompt & project context — auto-detect CLAUDE.md, UI for editing `.shipit/system-prompt.txt`, prepend to every Claude turn

### P2 — Advanced
- [ ] Inline file editing — CodeMirror 6 in the file viewer, Ctrl+S to save, auto-commit, conflict detection when Claude edits the same file
- [ ] Conversation branching & checkpoints — snapshot conversation + git state, branch from any checkpoint with a new CLI session and replayed context

## Nice to Have
- [ ] Multi-file diff view — when Claude edits multiple files in one turn, show a grouped diff summary
- [ ] Dark/light theme
- [ ] Export conversation
- [ ] Multi-client collaboration — shared session URLs with spectator/participant modes
- [ ] Deployment integration — one-click deploy to Vercel/Netlify from the UI
