# 016 — Claude Code App Integration Analysis

## Overview

This document analyzes features from the Claude Code App (web & desktop harness for Claude Code CLI) that could or should be integrated into ShipIt. The analysis compares ShipIt's current capabilities against the Claude Code App's feature set, identifies gaps, and prioritizes integration opportunities.

## Current State Comparison

| Capability | ShipIt | Claude Code App | Gap |
|---|---|---|---|
| Agentic engine (Claude CLI) | Yes | Yes | Parity |
| Live preview | Yes (Vite + port scan) | No built-in preview | ShipIt ahead |
| Session isolation | Per-directory git repos | Git worktrees / VMs | Different approaches |
| Visual diff review | Inline diff in chat only | Dedicated diff viewer with inline comments | Significant gap |
| Git auto-commit | Yes (after each turn) | Yes (per worktree) | Parity |
| Git rollback | Yes (hard reset) | N/A (branch-based) | Different models |
| Conversation threading | Yes (checkpoints + forks) | N/A (session-based) | ShipIt ahead |
| Deployment | Yes (Vercel, Cloudflare) | Via CI/CD or manual | ShipIt ahead |
| Usage tracking | Yes (per-turn cost) | Account-level billing | ShipIt ahead |
| Templates | Yes (7 scaffolds) | N/A | ShipIt ahead |
| Permission model | None (trusts CLI) | 3 modes (normal/auto/plan) | Gap |
| Parallel sessions | Sequential switching | Simultaneous (worktrees) | Gap |
| Cloud/remote execution | No | Yes (Anthropic VMs) | Major gap |
| Async/background work | No | Yes (close browser, keep running) | Major gap |
| PR creation in-app | No (push only) | Yes | Gap |
| Image preview in chat | Image input only | Inline image rendering | Minor gap |
| File attachments | Image upload | Drag-and-drop any file | Minor gap |
| Connectors (Slack, Linear) | No | Yes (desktop only) | Gap |
| Mobile access | No | Yes (iOS app) | Out of scope |
| Session sharing | No | Yes (link sharing) | Gap |
| Plugin ecosystem | No | Yes (marketplace) | Gap |
| CLAUDE.md support | Via CLI passthrough | Native | Parity (implicit) |
| MCP servers | Via CLI passthrough | Native | Parity (implicit) |

---

## Tier 1 — High-Impact, High-Feasibility

These features address real pain points in the current ShipIt workflow and are architecturally feasible.

### 1.1 Visual Diff Review Panel

**What Claude Code App does**: Dedicated diff viewer — file list on the left, side-by-side or unified diff on the right. Users can click any line to add inline comments, then submit all comments at once. Accept/Reject buttons per file. Files aren't modified until accepted.

**Current ShipIt state**: Diffs appear inline in the chat as syntax-highlighted red/green blocks extracted from Claude's tool_use events. No ability to comment on specific lines, accept/reject individual changes, or review changes outside the chat flow.

**Why integrate**: The diff review panel is the Claude Code desktop app's "signature feature" and addresses one of the biggest gaps in chat-driven coding — the inability to efficiently review what changed. Current inline diffs are fine for small edits but become unwieldy for multi-file changes.

**Integration approach**:
- Add a new `DiffPanel` component that aggregates all file changes from the current Claude turn
- Parse `tool_use` events for Edit/Write tools to extract before/after content
- Use a diff library (e.g., `diff`, `diff2html`, or `jsdiff`) for rendering
- Add Accept/Reject per file — "Reject" sends feedback to Claude as a follow-up message
- Add inline commenting: click a diff line → text input → submit as structured feedback to Claude
- Wire up via a new expandable panel (similar to how git history or terminal work)

**Key files to modify**:
- `src/server/types.ts` — New message types: `get_turn_diff`, `accept_changes`, `reject_changes`, `diff_comment`
- `src/server/index.ts` — Handlers to compute diffs from git (diff between last two commits)
- `src/client/components/DiffPanel.tsx` — New component
- `src/client/App.tsx` — State management for diff panel

**Complexity**: Medium-high. The diff computation is straightforward (git diff between commits), but the inline commenting UX and accept/reject flow require careful state management.

### 1.2 Permission Modes (Normal / Auto-Accept / Plan)

**What Claude Code App does**: Three modes — Normal (asks permission before edits/commands), Auto-Accept (applies changes without confirmation), Plan (read-only exploration, no modifications).

**Current ShipIt state**: Effectively always auto-accept. Claude CLI runs with full permissions, and all changes are applied immediately. The only "undo" mechanism is git rollback.

**Why integrate**: Plan mode is particularly valuable. Users often want Claude to explore a codebase, suggest an approach, and explain what it would do — without actually making changes. This is safer for unfamiliar codebases and enables the "plan locally, execute later" pattern. Normal mode adds a human-in-the-loop gate that some users want.

**Integration approach**:
- Add a mode selector to the chat input area (dropdown or toggle)
- **Plan mode**: Pass `--permission-mode plan` to Claude CLI. Claude can read files and search but cannot write/edit/execute. Surface the plan in chat for user review. Add a "Execute this plan" button that re-runs with auto-accept.
- **Normal mode**: Parse `tool_use` events before they execute. Show a confirmation dialog ("Claude wants to edit `src/App.tsx` — Allow / Deny"). This requires intercepting Claude's tool calls, which the current NDJSON streaming model supports — the server can hold responses until the user approves.
- **Auto-accept mode**: Current behavior (default).

**Key considerations**:
- Normal mode requires bidirectional flow: server receives tool_use → sends to client for approval → client responds → server sends answer to Claude CLI stdin. This is architecturally similar to the existing `answer_question` flow.
- Plan mode is simpler: just a CLI flag. The main work is UI to display the plan clearly and offer "execute" conversion.

**Complexity**: Medium. Plan mode is low-effort. Normal mode requires a new approval flow but follows the existing `answer_question` pattern.

### 1.3 In-App Pull Request Creation

**What Claude Code App does**: After reviewing diffs, users can create a PR directly from the interface — title, description, base branch selection — without switching to GitHub.

**Current ShipIt state**: GitHub integration supports push/pull/create-repo but not PR creation. Users must go to GitHub to create a PR after pushing.

**Why integrate**: PR creation is the natural end of a coding workflow. Having to context-switch to GitHub breaks the flow. Since ShipIt already stores GitHub tokens and can push, adding PR creation is a logical extension.

**Integration approach**:
- Add `github_create_pr` client message type with fields: title, body, base branch, head branch
- Server handler uses GitHub API (`POST /repos/{owner}/{repo}/pulls`) with the stored token
- Client UI: modal or panel with title/body fields, branch selectors, "Create PR" button
- Pre-populate title from last commit message, body from Claude's summary
- Optionally: ask Claude to generate a PR description from the diff

**Key files**:
- `src/server/types.ts` — `github_create_pr` message type + response
- `src/server/github-auth.ts` — Add `createPullRequest()` method using GitHub API
- `src/server/index.ts` — Handler
- `src/client/components/GitHubAuthOverlay.tsx` — Add PR creation UI (or new `PullRequestModal.tsx`)

**Complexity**: Low-medium. Mostly API integration + UI form. The GitHub API for PR creation is straightforward.

### 1.4 Prompt Queuing (Async Message Submission)

**What Claude Code App does**: While Claude is executing a step, users can send additional prompts. These are queued and executed after the current step finishes.

**Current ShipIt state**: The chat input is disabled while Claude is processing. Users must wait for Claude to finish before sending the next message.

**Why integrate**: Users frequently think of follow-up instructions or corrections while watching Claude work. Forcing them to wait and remember is a poor UX. Queuing is also a prerequisite for more advanced async workflows.

**Integration approach**:
- Server-side: maintain a message queue per connection. When a `send_message` arrives while Claude is active, enqueue it. On Claude `done` event, dequeue and spawn next.
- Client-side: keep the input enabled during processing. Show queued messages in the chat with a "queued" indicator. Allow reordering or canceling queued messages.
- Visual feedback: show queue count badge, "Your message is queued — Claude will process it next"

**Key files**:
- `src/server/index.ts` — Add queue logic around `send_message` handler
- `src/client/App.tsx` — Keep input enabled, add queue state
- `src/client/components/ChatInput.tsx` — Queue indicator

**Complexity**: Low-medium. The server already tracks `isClaudeRunning`. Adding a FIFO queue is straightforward.

---

## Tier 2 — Medium-Impact, Medium-Feasibility

These features provide meaningful value but require more architectural work or have narrower use cases.

### 2.1 Git Worktree-Based Parallel Sessions

**What Claude Code App does**: Each session gets an isolated git worktree from the same repository. Multiple sessions can run simultaneously on different branches without interference. All share git history and remotes.

**Current ShipIt state**: Sessions use completely separate directories under `/workspace/sessions/{uuid}/`. Each is an independent git repo. There's no shared history between sessions, and switching sessions is sequential (one active at a time).

**Why integrate**: Worktrees enable powerful workflows — working on auth in one tab while refactoring the API in another, then merging both. ShipIt's current model means starting from scratch each session (or manually copying files). Worktrees also save disk space since they share the git object store.

**Integration approach**:
- When a session is created from an existing repo (not a template), use `git worktree add` instead of a fresh directory
- Each worktree gets its own branch (auto-named or user-chosen)
- Shared git history means changes from one session are visible to others after commit
- The session model would need a `parentRepo` field linking worktree sessions to their source
- Template-based sessions continue using standalone repos (no parent to share with)

**Challenges**:
- ShipIt's current model creates fresh repos per session. Retrofitting worktrees requires rethinking the session creation flow.
- Worktrees require an existing repo to branch from. This works when users push/pull from GitHub, but not for from-scratch template projects.
- Vite/preview isolation: each worktree needs its own dev server on a different port.

**Complexity**: High. Fundamental change to the session/git model.

### 2.2 Session Sharing

**What Claude Code App does**: Sessions can be shared via link (private, team, or public depending on account type). Others can view the conversation, code changes, and outcomes.

**Current ShipIt state**: No sharing. Sessions are local to the server instance.

**Why integrate**: Sharing enables team collaboration, code review, and learning. A developer can share a session showing how they built a feature, and teammates can see the conversation + diffs.

**Integration approach**:
- Read-only sharing (simplest): generate a unique URL for a session. Serve a static view of the chat history + file state.
- Requires either: (a) a public-facing server, or (b) export to a static format (HTML/JSON) that can be hosted elsewhere.
- For multi-user deployments: add session visibility settings (private/team/public) and a sharing endpoint.

**Challenges**:
- ShipIt currently runs as a single-user local server. Multi-user sharing requires auth, access control, and possibly a separate sharing service.
- Sessions may contain sensitive code or credentials.

**Complexity**: High for real-time sharing. Medium for export-based sharing (generate a shareable HTML snapshot).

### 2.3 Interrupt and Redirect

**What Claude Code App does**: Users can interrupt Claude mid-task — click stop or type a correction. Claude adjusts without starting over.

**Current ShipIt state**: There's no explicit "stop" or "interrupt" button. The Claude process runs to completion. Users can only wait or (implicitly) kill the process by refreshing.

**Why integrate**: Interruption is essential when Claude goes down the wrong path. Without it, users waste tokens and time waiting for a wrong approach to finish.

**Integration approach**:
- Add a "Stop" button visible during Claude processing
- Server-side: send SIGINT to the Claude CLI process (PTY supports this)
- After stopping, Claude's partial output remains in chat
- User can then send a new message redirecting the approach
- The `--resume` flag means Claude picks up with the corrected context

**Key files**:
- `src/server/claude.ts` — Add `interrupt()` method (write SIGINT to PTY or kill process)
- `src/server/types.ts` — `interrupt_claude` client message
- `src/server/index.ts` — Handler
- `src/client/App.tsx` — Stop button during processing

**Complexity**: Low. The PTY already supports signal delivery. Main work is UI + graceful handling of partial output.

**Note**: This is arguably Tier 1 in terms of user impact — it's a basic UX expectation. Placing it in Tier 2 because the implementation has edge cases around partial tool execution and git state consistency.

### 2.4 Multi-Repository Support

**What Claude Code App does**: Remote sessions support multiple repositories. Each gets its own branch selector, enabling tasks that span codebases.

**Current ShipIt state**: Each session is bound to a single workspace directory. No concept of multi-repo work.

**Why integrate**: Real-world development often spans repos — a frontend app + backend API, a library + its consumer, a service + its infrastructure config. Supporting multiple repos in one session enables these workflows.

**Integration approach**:
- Allow sessions to reference multiple workspace directories
- Each directory gets its own git manager and branch tracking
- Claude CLI already operates on the filesystem and can navigate between directories
- The file tree would show a multi-root view
- Preview/port scanning would cover all repos

**Challenges**:
- Session model assumes one `workspaceDir`. Multi-repo requires an array of workspace roots.
- Git operations (commit, rollback) would need to be per-repo.
- File watcher would need multiple roots.

**Complexity**: High. Touches many subsystems.

---

## Tier 3 — Lower Priority / Out-of-Scope for Now

These features are either specific to Anthropic's infrastructure, have limited applicability for ShipIt's self-hosted model, or have lower ROI.

### 3.1 Cloud/Remote Execution

**What it does**: Run Claude in Anthropic-managed VMs. Continue even after closing the browser.

**ShipIt assessment**: This is an infrastructure-level feature, not a code feature. ShipIt already runs server-side (the Fastify process persists independently of browser connections). The gap is that ShipIt doesn't support "fire and forget" — the WebSocket connection is required for communication.

**Possible integration**: Add a background task queue. When a user sends a message and closes the browser, the server continues processing. On reconnect, the client receives buffered events. ShipIt's terminal log ring buffer (500 entries) already partially supports this — it persists across connections.

**Complexity**: Medium. The server already persists independently. Main work is buffering events for offline clients and resuming on reconnect.

### 3.2 Connectors (Slack, Linear, GitHub Issues)

**What it does**: External tool integrations — mention @Claude in Slack and get a PR, link Linear tasks.

**ShipIt assessment**: Nice to have but niche. These are integrations that require external service setup and are more relevant in team/enterprise contexts.

**Possible integration**: Add a webhook/connector framework. But this is likely over-engineering for ShipIt's current scope.

**Complexity**: High per connector. Low architectural overhead if done as plugins.

### 3.3 Plugin/Extension Marketplace

**What it does**: Install curated plugins that bundle skills, MCP servers, hooks, commands.

**ShipIt assessment**: ShipIt already passes through MCP servers and CLAUDE.md to the CLI. A plugin marketplace adds discoverability but requires infrastructure (registry, publishing, versioning) that's beyond ShipIt's scope.

**Possible integration**: Support loading plugins from a directory (`.shipit/plugins/`). Each plugin could define additional system prompts, templates, or deploy targets. No marketplace needed — just a local plugin convention.

**Complexity**: Medium for local plugins. Very high for a marketplace.

### 3.4 Session Teleportation (Surface Handoff)

**What it does**: Move sessions between CLI, desktop, web, and iOS seamlessly.

**ShipIt assessment**: ShipIt is a single-surface product (web). Teleportation to CLI could be useful (export session state so a user can continue in terminal), but it's a niche workflow.

**Possible integration**: Export session as a CLI command (`claude --resume {sessionId}` with the right working directory). This is mostly a UX convenience.

**Complexity**: Low for export. Not applicable for import (ShipIt can't import CLI sessions).

### 3.5 Network Security Proxy (Egress Control)

**What it does**: All outbound traffic goes through security/GitHub proxies with domain allowlisting.

**ShipIt assessment**: This is an infrastructure concern for cloud execution. For self-hosted ShipIt, the operator controls the network. However, having an option to restrict Claude's outbound access could be valuable for security-conscious deployments.

**Possible integration**: Configure allowed domains in ShipIt settings. Pass network restrictions to Claude CLI via environment or allowed-tools configuration.

**Complexity**: Low-medium depending on enforcement mechanism.

---

## Recommended Implementation Order

Based on impact, feasibility, and architectural dependencies:

### Phase 1 — Core UX Gaps
1. **Interrupt and Redirect** (2.3) — Basic UX expectation, low complexity
2. **Prompt Queuing** (1.4) — Low complexity, immediately improves workflow
3. **Permission Modes** (1.2) — Plan mode is low-effort, high-value

### Phase 2 — Review & Collaboration
4. **Visual Diff Review Panel** (1.1) — Signature feature, medium-high complexity
5. **In-App PR Creation** (1.3) — Natural extension of existing GitHub integration

### Phase 3 — Advanced Workflows
6. **Background Execution / Offline Resilience** (3.1) — Buffer events for disconnected clients
7. **Session Sharing** (2.2) — Start with export-based sharing (HTML snapshots)
8. **Git Worktree Parallel Sessions** (2.1) — High complexity but enables power-user workflows

### Deferred
- Multi-repo support — Wait for user demand
- Connectors — Team/enterprise feature
- Plugin system — Premature for current scope
- Network proxy — Operator-level concern
- Teleportation — Single-surface product

---

## Architecture Considerations

### What ShipIt Should NOT Copy

1. **VM/Container isolation model**: ShipIt's value is running locally with direct filesystem access. The Claude Code App's container model exists because it runs in the cloud on Anthropic's infrastructure. ShipIt should not add containerization.

2. **Skip-permissions by default**: The Claude Code App runs `--dangerously-skip-permissions` because the VM is the sandbox. ShipIt runs on the user's machine — permission modes (1.2) are the right approach instead.

3. **Scoped credentials / proxy architecture**: This solves a cloud-specific problem (isolating user credentials in shared infrastructure). ShipIt runs single-tenant; the user's credentials are already scoped.

4. **iOS/mobile companion**: Out of scope for a web IDE. The existing responsive layout handles mobile browsers.

### What ShipIt Already Does Better

1. **Live preview**: The Vite integration + port scanning + error injection is more advanced than anything in the Claude Code App. Keep investing here.

2. **Conversation threading**: Checkpoints + forks with git state preservation is a feature the Claude Code App doesn't have. This is a differentiator.

3. **Deployment**: One-click deploy to Vercel/Cloudflare from the IDE is unique to ShipIt.

4. **Templates**: Project scaffolding removes the blank-page problem. The Claude Code App assumes an existing repo.

5. **Usage tracking**: Per-turn cost visibility is granular and useful. The Claude Code App only shows account-level billing.

### Key Architectural Principle

ShipIt is a **development environment**, not just a Claude harness. The Claude Code App wraps the CLI with review/collaboration chrome. ShipIt wraps it with an entire IDE (preview, file tree, terminal, deployment). Integration should enhance ShipIt's IDE nature rather than copying the harness's collaboration chrome.

The highest-value integrations are those that make the IDE loop tighter: diff review (understand changes faster), interruption (course-correct faster), plan mode (explore before committing), prompt queuing (maintain flow). Lower value are features that assume a team/enterprise context (sharing, connectors, plugins) or cloud infrastructure (VMs, proxies, teleportation).
