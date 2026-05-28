---
status: done
---
# Client-Server Protocol

ShipIt uses a dual-transport architecture: **HTTP REST API** (`/api/*`) for reads and mutations, and **WebSocket** (`/ws`) for streaming events, per-connection state, and real-time push.

Types are defined in `src/server/types/` (split across `ws-client-messages.ts`, `ws-server-messages.ts`, and domain-specific type files). HTTP route handlers live in `src/server/api-routes.ts`. Business logic lives in `src/server/services/` — pure functions consumed by both HTTP routes and WS handlers.

## HTTP REST API

All HTTP endpoints are prefixed with `/api`. Session-scoped routes use `:id` to reference a session by its UUID. The client calls these via the `useApi` hook (`src/client/hooks/useApi.ts`).

### Bootstrap & global reads

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/bootstrap` | Initial data load — sessions, agents, templates, GitHub status, global settings |
| GET | `/api/features` | List feature flags with status from docs frontmatter |
| GET | `/api/github/repos?q=` | Search GitHub repositories |

### Session-scoped reads

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sessions/:id/history` | Chat messages, commits, file tree, threads, active thread |
| GET | `/api/sessions/:id/files` | Workspace file tree |
| GET | `/api/sessions/:id/files/*path` | File content (query `?tree=true` to include file tree) |
| GET | `/api/sessions/:id/docs` | List markdown docs in workspace |
| GET | `/api/sessions/:id/docs/*path` | Markdown doc content |
| GET | `/api/sessions/:id/git/log` | Git commit history |
| GET | `/api/sessions/:id/git/diff?from=&to=` | Turn diff between two commits |
| GET | `/api/sessions/:id/git/remotes` | Git remotes |
| GET | `/api/sessions/:id/git/branches` | Git branches (current + remote) |
| GET | `/api/sessions/:id/status` | Session runtime status (running, queue length) |
| GET | `/api/sessions/:id/usage` | Aggregated usage/cost stats |
| GET | `/api/sessions/:id/pr/status` | Pull request status and checks |
| GET | `/api/sessions/:id/threads` | Conversation threads and checkpoints |
| GET | `/api/sessions/:id/worktrees` | Sibling worktree sessions |
| GET | `/api/sessions/:id/deploy/setup` | Deploy targets + project settings (combined) |
| GET | `/api/sessions/:id/deploy/history` | Deployment history |
| GET | `/api/sessions/:id/workspace-state` | Git log + file tree (combined) |

### Session mutations

| Method | Path | Purpose |
|--------|------|---------|
| PATCH | `/api/sessions/:id` | Rename session (`{ title }`) |
| DELETE | `/api/sessions/:id` | Archive session |
| POST | `/api/sessions/:id/fork` | Fork session into new worktree branch (`{ branchName, startPoint? }`) |
| POST | `/api/sessions/:id/template` | Apply project template (`{ templateId }`) |
| POST | `/api/sessions/:id/threads/checkpoint` | Create checkpoint on active thread (`{ label? }`) |
| POST | `/api/sessions/:id/preview-errors` | Report preview iframe error |

### Git operations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sessions/:id/git/rollback` | Rollback to commit (`{ commitHash }`) |
| POST | `/api/sessions/:id/git/reject` | Reject (revert) changes |
| POST | `/api/sessions/:id/git/remotes` | Set git remote (`{ name, url }`) |
| POST | `/api/sessions/:id/git/push` | Git push (`{ remote?, branch? }`) |
| POST | `/api/sessions/:id/git/pull` | Git pull (`{ remote?, branch? }`) |
| POST | `/api/sessions/:id/git/merge` | Merge worktree branch (`{ sourceSessionId }`) |

### PR operations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sessions/:id/pr` | Create pull request (`{ title, body, base, draft? }`) |
| POST | `/api/sessions/:id/pr/merge` | Merge pull request (`{ method? }`) |
| POST | `/api/sessions/:id/pr/description` | Generate PR description via LLM |

### Deploy operations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/sessions/:id/deploy/config` | Save deploy credentials (`{ targetId, config }`) |
| DELETE | `/api/sessions/:id/deploy/config/:targetId` | Delete deploy credentials |

### Settings & auth

| Method | Path | Purpose |
|--------|------|---------|
| PUT | `/api/settings` | Save global settings (`{ systemPrompt }`) |
| POST | `/api/settings/git-identity` | Set git identity (`{ name, email }`) |
| POST | `/api/settings/agent` | Set default agent (`{ agentId }`) |
| POST | `/api/agents/:id/env` | Set agent env var (`{ key, value }`) |
| POST | `/api/auth/api-key` | Set API key (`{ key }`) |
| DELETE | `/api/auth/api-key` | Clear API key |
| POST | `/api/auth/start` | Initiate OAuth flow (returns 202) |
| POST | `/api/auth/code` | Submit OAuth authorization code (`{ code }`) |
| POST | `/api/github/token` | Set GitHub token (`{ token }`) |
| POST | `/api/github/logout` | Logout from GitHub |

### Global mutations

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/repos` | Create GitHub repo with template (`{ repoName, templateId, description?, isPrivate? }`) |
| POST | `/api/reset` | Full reset — delete all sessions, re-init workspace |

## WebSocket Messages

The WebSocket at `/ws` handles operations that require streaming, per-connection state, or real-time push. The client connects via the `useWebSocket` hook.

### Client → Server

| Type | Fields | Purpose |
|------|--------|---------|
| `send_message` | `text`, `sessionId?`, `images?`, `files?`, `permissionMode?` | Send user message to Claude |
| `answer_question` | `toolUseId`, `answers`, `text?` | Reply to AskUserQuestion. `text` is the pre-formatted prompt (bullet list for multi-question, bare answer for single); server falls back to joining `answers` for older clients. |
| `home_send_with_repo` | `repoUrl`, `text`, `images?`, `files?`, `permissionMode?` | Send message from home screen with repo URL |
| `new_session` | — | Detach from current session, prepare for new one |
| `activate_session` | `sessionId` | Attach runner, file watcher, preview to this connection |
| `set_agent` | `agentId` | Set active agent for this connection |
| `interrupt_claude` | — | Interrupt the running Claude process |
| `fork_thread` | `checkpointId` | Fork a new thread from checkpoint (git reset + preview restart) |
| `switch_thread` | `threadId` | Switch to existing thread (git reset + preview restart) |
| `initiate_deploy` | `targetId`, `environment?` | Start a deployment |
| `cancel_deploy` | — | Cancel in-progress deployment |
| `cancel_queued_message` | `position` | Cancel a queued message (index or `"all"`) |
| `init_preview_config` | — | Ask Claude to generate `shipit.yaml` |
| `diff_comment` | `comments[]` | Submit inline comments on code diff |
| `clear_logs` | — | Clear terminal log buffer |
| `terminal_start` | `cols`, `rows` | Start a terminal session |
| `terminal_input` | `data` | Send input to the terminal |
| `terminal_resize` | `cols`, `rows` | Resize the terminal |

### Server → Client

| Type | Fields | Purpose |
|------|--------|---------|
| **Streaming** | | |
| `claude_event` | `event` | Relayed Claude CLI NDJSON event (text, tool use, result) |
| `agent_event` | `event` | Agent process event |
| **Session lifecycle** | | |
| `session_list` | `sessions[]` | Updated session list (after fork, new session, etc.) |
| `session_started` | `session` | Session created or resumed |
| `session_renamed` | `session` | Session title changed |
| `session_status` | `sessionId`, `running`, `queueLength` | Runtime state of a session |
| `session_agent_started` | `sessionId` | Agent started running (broadcast) |
| `session_agent_finished` | `sessionId` | Agent finished (broadcast) |
| `chat_history` | `sessionId`, `messages[]` | Persisted chat messages |
| **Real-time workspace** | | |
| `preview_status` | `running`, `port`, `url`, `source?`, `detectedPorts?` | Dev server status |
| `files_changed` | `paths[]` | Workspace files changed (debounced) |
| `file_tree` | `tree[]` | Workspace directory tree |
| `file_content` | `path`, `content`, `isBinary?` | File content |
| `git_log` | `commits[]` | Git commit history |
| `git_committed` | `hash`, `message` | New auto-commit |
| `turn_diff` | `fromCommit`, `toCommit`, `files[]`, `stats` | Code diff for a turn |
| **Auth** | | |
| `auth_required` | `url?` | OAuth URL for authentication |
| `auth_complete` | — | OAuth flow finished |
| `git_identity_required` | — | Git name/email must be set |
| `git_identity_set` | `name`, `email` | Git identity configured |
| `github_status` | `authenticated`, `username?`, `avatarUrl?` | GitHub auth status |
| **GitHub results** | | |
| `github_push_result` | `success`, `message`, `branch?` | Git push result |
| `github_remotes` | `remotes[]` | Git remotes |
| `github_branches` | `current`, `remote[]` | Git branches |
| `github_search_results` | `repos[]` | GitHub repo search results |
| `pr_status` | `pr` | PR status with checks |
| **Settings & agents** | | |
| `global_settings` | `gitIdentity`, `systemPrompt`, `agents[]`, `defaultAgentId` | All global settings |
| `agent_list` | `agents[]`, `defaultAgentId` | Available agents |
| `template_applied` | `templateId`, `name` | Template applied |
| `feature_list` | `features[]` | Feature flags |
| **Threads** | | |
| `thread_list` | `threads[]`, `activeThreadId` | All threads with checkpoints |
| `thread_switched` | `thread`, `threads[]`, `activeThreadId` | Switched to a thread |
| `thread_forked` | `thread`, `threads[]`, `activeThreadId` | New thread forked |
| **Deploy** | | |
| `deploy_targets` | `targets[]` | Available deploy targets |
| `project_settings` | `settings` | Project deploy settings |
| `deploy_status` | `targetId`, `stage`, `message` | Deploy progress |
| `deploy_complete` | `targetId`, `url`, `environment` | Deploy succeeded |
| `deploy_error` | `targetId`, `message` | Deploy failed |
| `deploy_history` | `deployments[]` | Deploy history |
| **Usage** | | |
| `usage_stats` | `stats` | Aggregated usage data |
| `usage_update` | `sessionId`, `totalCostUsd`, `totalDurationMs`, `turnCount` | Per-turn cost update |
| **Terminal** | | |
| `log_entry` | `source`, `text`, `timestamp` | Terminal log line |
| `terminal_output` | `data` | Terminal output |
| `terminal_exit` | `code` | Terminal session ended |
| `clear_logs` | — | Terminal logs cleared |
| **Queue & interrupt** | | |
| `message_queued` | `position`, `text` | Message queued while Claude busy |
| `queue_updated` | `queue[]` | Queue contents changed |
| `claude_interrupted` | — | Claude was interrupted |
| **Preview config** | | |
| `preview_config_missing` | `checked[]` | No shipit.yaml or package.json found |
| `preview_config_error` | `message` | Malformed shipit.yaml |
| `install_status` | `status`, `message?` | Dependency install progress |
| **Model** | | |
| `model_info` | `model`, `contextWindowTokens` | Claude model info |
| **Docs** | | |
| `doc_list` | `files[]` | Markdown file paths |
| `doc_content` | `path`, `content` | Markdown file content |
| **Error** | | |
| `error` | `message` | Error description |
| `full_reset_complete` | — | Full reset finished |

## Claude CLI Events (NDJSON)

The Claude CLI with `--output-format stream-json` emits NDJSON to stdout:

| Event type | When | Key data |
|-----------|------|----------|
| `system` (init) | Session start | `session_id`, model, available tools |
| `assistant` | Claude responds | Text blocks + tool_use blocks (content array) |
| `user` | Tool results | `tool_result` blocks with `tool_use_id` matching |
| `result` | Turn complete | `session_id`, `total_cost_usd`, `duration_ms` |

Tool use blocks in `assistant` events relevant for rendering:

| Tool | Input fields | Rendering |
|------|-------------|-----------|
| `Edit` | `file_path`, `old_string`, `new_string` | Inline diff (red/green) via `DiffBlock` |
| `Write` | `file_path`, `content` | All-green addition block via `DiffBlock` |
| `Read` | `file_path` | Compact one-liner |
| `Bash` | `command` | Compact one-liner (first 80 chars) |
| `Glob` | `pattern` | Compact one-liner |
| `Grep` | `pattern`, `path` | Compact one-liner |

## Key files

- `src/server/api-routes.ts` — HTTP REST API route handlers
- `src/server/services/` — Business logic (pure functions shared by HTTP and WS)
- `src/server/types/` — All message type definitions (split by domain)
- `src/server/index.ts` — WebSocket dispatcher (`switch (msg.type)`)
- `src/server/ws-handlers/` — WebSocket-only handlers (streaming, per-connection state)
- `src/client/hooks/useApi.ts` — HTTP client hook (`apiGet`, `apiPost`, etc.)
- `src/client/hooks/useWebSocket.ts` — WebSocket lifecycle, reconnection, send/receive
- `src/client/hooks/useMessageHandler.ts` — Client-side WS message dispatch
- `src/client/App.tsx` — Main orchestrator — state, layout
