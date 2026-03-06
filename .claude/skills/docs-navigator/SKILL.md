---
description: "Feature docs index and navigation. Load when you need to understand how a specific feature was implemented, find related feature docs for a task, or check what's planned/in-progress. Not needed for pure architecture questions (use the architecture skills instead)."
user-invocable: true
---

# Feature Docs Navigator

ShipIt has 73 feature docs in `docs/NNN-feature-name/plan.md`. Each describes how a feature was designed and implemented. Most tasks don't need these — the architecture skills cover cross-cutting patterns. Load a feature doc only when you need implementation details for a specific feature.

## How to use

1. Find the relevant doc(s) from the index below
2. Read its `plan.md` for design details
3. Check `checklist.md` if it exists — it tracks remaining work

## Status key

- **done** — implemented and shipped
- **in-progress** — actively being worked on
- **planned** — designed but not yet started
- **paused** — designed but not currently scheduled

## Feature index by area

### Protocol & Communication
- `001-websocket-protocol` (done) — Client-server WS protocol, message types, lifecycle
- `005-streaming-ux` (done) — Streaming message rendering, progressive display
- `020-prompt-queuing` (done) — Queue prompts while Claude is busy
- `021-interrupt-redirect` (done) — Interrupt running tasks, redirect to new prompt
- `043-websocket-vs-http-analysis` (done) — Decision framework: when to use WS vs HTTP

### Session Management
- `003-session-management` (done) — Core session CRUD, metadata persistence
- `022-worktree-sessions` (done) — Parallel sessions via git worktrees
- `040-session-lifecycle-analysis` (done) — Session states, transitions, lifecycle events
- `041-persistent-session-runners` (done) — Keep session runners alive across reconnects
- `051-session-containerization` (done) — Docker-per-session architecture
- `059-repo-session-flows` (done) — Repo selection → session creation flows
- `063-idle-container-cleanup` (done) — Auto-dispose idle containers
- `073-remove-standalone-sessions` (done) — Removed non-repo session path

### Process Management & Agents
- `002-process-management` (done) — Claude CLI spawning, NDJSON parsing
- `034-multi-agent-cli` (done) — Multi-agent support (Codex, Gemini, etc.)
- `035-codex-container-setup` (done) — Codex container runtime integration
- `056-agent-registry-split` (done) — AgentRegistry placement in architecture

### Git & GitHub
- `015-github-auth` (done) — GitHub OAuth, token management
- `019-pr-creation` (done) — In-app PR creation
- `027-github-import` (done) — GitHub repo import, PR status bar
- `030-github-device-auth` (paused) — GitHub device auth flow
- `031-post-push-toast` (done) — Toast notification after git push
- `032-ai-pr-description` (done) — AI-generated PR descriptions
- `064-pr-lifecycle-flow` (done) — Full PR lifecycle (create, update, merge)
- `046-git-history-diff-view` (done) — Git log and diff viewer

### UI Components
- `009-preview-system` (done) — Live preview iframe, hot reload
- `010-file-browser` (done) — File tree sidebar
- `011-terminal-logs` (done) — Terminal/logs panel
- `017-diff-review-panel` (done) — Visual diff review
- `024-model-context-display` (done) — Model name, context window, token usage
- `025-code-editor` (paused) — In-browser code editor
- `026-interactive-terminal` (done) — Interactive terminal with PTY
- `028-file-context-attachment` (done) — Attach files/code as context
- `033-session-sidebar` (done) — Session list sidebar with repo grouping
- `034-home-screen` (done) — Home screen with repo selector
- `045-todowrite-display` (done) — TodoWrite tool progress display
- `048-multi-port-support` (done) — Multiple preview ports
- `065-terminal-improvements` (done) — Terminal UX improvements
- `066-mobile-preview` (in-progress) — Mobile viewport preview sizing

### Chat & Messages
- `004-chat-history` (done) — Per-session message persistence
- `006-message-editing` (done) — Edit and retry messages
- `007-threads-checkpoints` (done) — Rollback/checkpoint system
- `008-image-input` (done) — Image and screenshot attachment
- `047-chat-history-editing` (planned) — Advanced chat history editing

### State Management & Architecture
- `044-zustand-state-management` (done) — Zustand stores, migration from prop drilling
- `053-server-code-separation` (done) — Session worker vs orchestrator split
- `054-handler-context-refactor` (done) — HandlerContext interface
- `055-session-runner-interface` (done) — SessionRunner abstraction boundary
- `057-data-manager-placement` (done) — Where ChatHistory, Threads, Usage live
- `038-codebase-splitting` (done) — Split large files (index.ts, App.tsx, types.ts)
- `072-large-file-splits` (done) — Further large file splits

### Deployment
- `012-deployment` (done) — Deploy targets (Vercel, Cloudflare)
- `061-self-hosting` (in-progress) — Self-hosted Docker deployment
- `062-managed-shipit` (planned) — Multi-tenant hosted deployment

### Configuration & Settings
- `014-system-prompt` (done) — Project-level system prompt
- `018-permission-modes` (done) — Permission mode configuration
- `036-full-reset` (done) — Wipe container state
- `037-vite-preview-session-change` (done) — Config-driven preview, shipit.yaml
- `039-install-command` (done) — Install command in shipit.yaml
- `058-scaffold-templates` (planned) — Project scaffolding templates

### Quality & Tooling
- `013-usage-tracking` (done) — Per-session cost tracking
- `029-feature-system` (done) — Feature status tracking from docs/
- `068-progressive-testing` (done) — test:dev, test:smoke, progressive test strategy
- `069-design-system` (done) — Design tokens, themes, iconography
- `070-eslint-strict-gaps` (done) — ESLint strict mode fixes
- `071-sqlite-investigation` (done) — Storage backend analysis

### Planned / Paused (not yet implemented)
- `023-session-sharing` (paused) — Share sessions with other users
- `042-archive-disk-cleanup` (planned) — Clean up archived session data
- `049-design-doc-comments` (planned) — Review comments on design docs
- `050-file-comments` (planned) — Comments on files
- `052-superpowers-plugin` (planned) — Plugin system for extensions
- `060-global-notifications` (planned) — Global notification system
- `067-container-hardening` (planned) — Container security hardening
