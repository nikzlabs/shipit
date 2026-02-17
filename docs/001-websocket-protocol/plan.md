# WebSocket Protocol

All client-server communication uses JSON over a single WebSocket connection at `/ws`. Types are defined in `src/server/types.ts`.

## Client → Server Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `send_message` | `text`, `sessionId?`, `images?` | Send a user message to Claude CLI |
| `answer_question` | `answer`, `sessionId` | Reply to a Claude permission question |
| `get_git_log` | — | Request git commit history |
| `rollback` | `commitHash` | Roll back workspace to a specific commit |
| `list_sessions` | — | List all saved sessions |
| `new_session` | — | Clear current session, start fresh |
| `delete_session` | `sessionId` | Delete a saved session |
| `rename_session` | `sessionId`, `title` | Rename a saved session |
| `list_docs` | — | List `.md` files in /workspace |
| `get_doc` | `path` | Request content of a markdown file |
| `get_chat_history` | `sessionId` | Request persisted chat messages for a session |
| `get_file_tree` | — | Request workspace directory tree |
| `get_file_content` | `path` | Request contents of a file in /workspace |
| `clear_logs` | — | Clear the server-side terminal log buffer |
| `preview_error` | `message`, `stack?`, `source?`, `line?` | Report a preview iframe error to the terminal log buffer |
| `get_usage_stats` | — | Request aggregated usage/cost data across all sessions |
| `get_system_prompt` | — | Request current project-level system prompt |
| `set_system_prompt` | `content` | Save or delete the project-level system prompt |
| `list_threads` | — | Request all threads and checkpoints for the current session |
| `create_checkpoint` | `label?` | Create a checkpoint on the active thread |
| `fork_thread` | `checkpointId` | Create a new thread from a checkpoint (rolls back git, truncates history) |
| `switch_thread` | `threadId` | Switch to an existing thread (rolls back git to thread's checkpoint) |
| `apply_template` | `templateId` | Apply a project template to the session workspace |
| `list_deploy_targets` | — | List available deployment targets |
| `deploy_configure` | `targetId`, `config` | Save deployment credentials for a target |
| `initiate_deploy` | `targetId`, `environment?` | Start a deployment |
| `get_deploy_history` | — | Request deployment history for the session |
| `get_deploy_config` | `targetId` | Request saved config status for a target |
| `cancel_deploy` | — | Cancel an in-progress deployment |
| `delete_deploy_config` | `targetId` | Delete saved credentials for a target |

## Server → Client Messages

| Type | Fields | Purpose |
|------|--------|---------|
| `claude_event` | `event` | Relayed Claude CLI NDJSON event |
| `error` | `message` | Error description |
| `preview_status` | `running`, `port`, `url`, `source?`, `detectedPorts?` | Dev server status |
| `git_log` | `commits[]` | Full git commit history |
| `git_committed` | `hash`, `message` | New auto-commit after Claude turn |
| `rollback_complete` | `commitHash` | Rollback succeeded |
| `auth_required` | `url` | OAuth URL for user to authenticate |
| `auth_complete` | — | OAuth flow finished |
| `session_list` | `sessions[]` | List of saved sessions |
| `session_started` | `session` | Session created or resumed |
| `session_renamed` | `session` | Session renamed successfully |
| `doc_list` | `files[]` | List of markdown file paths |
| `doc_content` | `path`, `content` | Raw markdown file content |
| `chat_history` | `sessionId`, `messages[]` | Persisted chat messages for a session |
| `file_tree` | `tree[]` | Workspace directory tree (array of `FileTreeNode`) |
| `file_content` | `path`, `content` | Raw file content for the file viewer |
| `log_entry` | `source`, `text`, `timestamp` | Terminal log line (`source`: `stderr`, `stdout`, `server`, `preview`, `deploy`) |
| `usage_stats` | `stats` | Aggregated usage data with per-session and total costs/turns |
| `usage_update` | `sessionId`, `totalCostUsd`, `totalDurationMs`, `turnCount` | Pushed after each turn with cost |
| `system_prompt` | `content` | Current system prompt text (empty string if not set) |
| `system_prompt_saved` | `content` | Confirmation after saving/deleting the system prompt |
| `thread_list` | `threads[]`, `activeThreadId` | All threads with checkpoints for the session |
| `checkpoint_created` | `checkpoint`, `threads[]`, `activeThreadId` | Checkpoint created with updated thread data |
| `thread_forked` | `thread`, `threads[]`, `activeThreadId` | New thread created from checkpoint |
| `thread_switched` | `thread`, `threads[]`, `activeThreadId` | Switched to a different thread |
| `files_changed` | `paths[]` | List of relative paths that changed in the workspace (debounced) |
| `deploy_targets` | `targets[]` | Available deployment targets with config fields |
| `deploy_configured` | `targetId` | Deployment credentials saved |
| `deploy_started` | `targetId` | Deployment started |
| `deploy_complete` | `targetId`, `url`, `environment` | Deployment succeeded |
| `deploy_error` | `targetId`, `message` | Deployment failed |
| `deploy_config_status` | `targetId`, `configured`, `hasRequiredFields` | Config status for a target |
| `deploy_history` | `deployments[]` | Deployment history for the session |

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

- `src/server/types.ts` — All message type definitions
- `src/server/index.ts` — Server-side WebSocket handlers (inside `socket.on("message")`)
- `src/client/App.tsx` — Client-side message handlers (in `useEffect` processing `lastMessage`)
- `src/client/hooks/useWebSocket.ts` — WebSocket lifecycle, reconnection, send/receive
