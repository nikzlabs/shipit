---
status: done
---

# WebSocket vs HTTP Analysis

## Summary

ShipIt routes **all** client-server communication through a single WebSocket at `/ws`. There are zero HTTP API endpoints. This analysis identifies which message types genuinely need WebSocket and which would be better served by REST endpoints.

## Current state

- **~55 client→server message types**, all dispatched through one `switch` block in `src/server/index.ts:919-1054`
- **~50 server→client message types**, all sent via `ctx.send()` over the same WebSocket
- **No request/response correlation** — there is no request ID in the protocol. The client infers which response belongs to which request by matching on `msg.type`. This works because only one request of a given type is typically in-flight at a time.
- **Session context is implicit** — most handlers read from `ctx.getActiveDir()` and `ctx.getActiveAppSessionId()`, which are per-connection state set during session activation. HTTP endpoints would need the session ID passed explicitly (as a path param or header).

## What genuinely needs WebSocket

These patterns require a persistent bidirectional channel and should remain on WebSocket:

### Streaming agent output
- `send_message` / `answer_question` / `home_send_with_repo` → stream of `agent_event` messages over many seconds
- `diff_comment` / `init_preview_config` → delegate to `send_message`, same streaming behavior

### Terminal I/O
- `terminal_input` → `terminal_output` — real-time bidirectional PTY stream
- `terminal_resize` — needs the same persistent connection as terminal I/O

### Server-push events (broadcast)
- `files_changed` — file watcher detects modifications
- `install_status` — preview manager install progress
- `deploy_status` / `deploy_complete` / `deploy_error` — deployment progress
- `session_agent_started` / `session_agent_finished` — sidebar activity indicators
- `auth_complete` — OAuth completion callback
- `log_entry` — server log broadcasts
- `preview_status` — preview server state changes
- `usage_update` — cost/duration after each turn

### Stateful operations that depend on connection lifecycle
- `new_session` — detaches from runner, clears per-connection state
- `interrupt_claude` — kills the agent process attached to this connection
- `cancel_queued_message` — modifies the per-connection message queue
- `message_queued` / `queue_updated` — queue state pushed to connected client
- `clear_logs` — clears per-connection log buffer

### Long-running operations with progress
- `initiate_deploy` → streams `deploy_status` then `deploy_complete`/`deploy_error`
- `cancel_deploy` — cancels an in-flight deploy on the current connection

## What could be HTTP endpoints

### Tier 1: Pure data reads (strongest candidates)

These are stateless GET requests with a single JSON response. No streaming, no push, no connection state dependency beyond knowing which session is active (solvable with a session ID parameter or cookie).

| Current WS message | Proposed HTTP endpoint | Notes |
|---|---|---|
| `get_file_tree` | `GET /api/sessions/:id/files` | Returns directory tree |
| `get_file_content` | `GET /api/sessions/:id/files/*path` | Returns file content, already has 1MB guard |
| `list_docs` | `GET /api/sessions/:id/docs` | Markdown file list |
| `get_doc` | `GET /api/sessions/:id/docs/*path` | Single doc content |
| `get_git_log` | `GET /api/sessions/:id/git/log` | Commit list |
| `get_turn_diff` | `GET /api/sessions/:id/git/diff?from=X&to=Y` | Diff between commits |
| `list_sessions` | `GET /api/sessions` | All sessions |
| `get_session_status` | `GET /api/sessions/:id/status` | Running state + queue length |
| `get_chat_history` | `GET /api/sessions/:id/history` | Messages + git log + file tree (though this also activates the session — see caveats) |
| `list_templates` | `GET /api/templates` | Available scaffolds |
| `list_deploy_targets` | `GET /api/deploy/targets` | Target registry |
| `get_deploy_history` | `GET /api/sessions/:id/deploy/history` | Past deployments |
| `get_project_settings` | `GET /api/sessions/:id/deploy/settings` | Per-target config |
| `get_usage_stats` | `GET /api/sessions/:id/usage` | Cost/duration totals |
| `get_global_settings` | `GET /api/settings` | Git identity + system prompt |
| `list_agents` | `GET /api/agents` | Available agents |
| `list_features` | `GET /api/features` | Feature docs with status |
| `github_get_status` | `GET /api/github/status` | Auth state + user info |
| `github_get_remotes` | `GET /api/sessions/:id/git/remotes` | Remote list |
| `github_list_branches` | `GET /api/sessions/:id/git/branches` | Local + remote branches |
| `github_search_repos` | `GET /api/github/repos?q=...` | Repo search |
| `get_pr_status` | `GET /api/sessions/:id/pr/status` | PR state + CI checks |
| `list_threads` | `GET /api/sessions/:id/threads` | Thread list |
| `list_worktrees` | `GET /api/sessions/:id/worktrees` | Sibling worktrees |

**Count: 24 message types → HTTP GET**

### Tier 2: Mutations with simple responses (good candidates)

These are POST/PUT/DELETE operations that modify state and return a single confirmation response. No streaming.

| Current WS message | Proposed HTTP endpoint | Notes |
|---|---|---|
| `rename_session` | `PATCH /api/sessions/:id` | Body: `{ title }` |
| `archive_session` | `DELETE /api/sessions/:id` | Cleanup + removal |
| `set_git_identity` | `POST /api/settings/git-identity` | Body: `{ name, email }` |
| `save_global_settings` | `PUT /api/settings` | Body: `{ gitIdentity?, systemPrompt? }` |
| `set_api_key` | `POST /api/auth/api-key` | Body: `{ key }` |
| `clear_api_key` | `DELETE /api/auth/api-key` | Clears key, may trigger OAuth |
| `github_set_token` | `POST /api/github/token` | Body: `{ token }` |
| `github_logout` | `POST /api/github/logout` | Clears GitHub token |
| `github_set_remote` | `POST /api/sessions/:id/git/remotes` | Body: `{ name, url }` |
| `github_push` | `POST /api/sessions/:id/git/push` | Body: `{ remote, branch }` |
| `github_pull` | `POST /api/sessions/:id/git/pull` | Body: `{ remote, branch }` |
| `github_create_pr` | `POST /api/sessions/:id/pr` | Body: `{ title, body, base, draft }` |
| `merge_pr` | `POST /api/sessions/:id/pr/merge` | Body: `{ method }` |
| `deploy_configure` | `POST /api/deploy/:targetId/config` | Body: credentials |
| `delete_deploy_config` | `DELETE /api/deploy/:targetId/config` | Removes credentials |
| `rollback` | `POST /api/sessions/:id/git/rollback` | Body: `{ commitHash }` |
| `reject_changes` | `POST /api/sessions/:id/git/reject` | Body: `{ fromCommit, files }` |
| `set_agent` | `POST /api/settings/agent` | Body: `{ agentId }` |
| `set_agent_env` | `POST /api/agents/:id/env` | Body: `{ key, value }` |
| `create_checkpoint` | `POST /api/sessions/:id/threads/checkpoint` | Body: `{ label }` |
| `apply_template` | `POST /api/sessions/:id/template` | Body: `{ templateId }` |
| `full_reset` | `POST /api/reset` | Destroys everything |
| `preview_error` | `POST /api/sessions/:id/preview-errors` | Client error reporting |

**Count: 23 message types → HTTP POST/PUT/PATCH/DELETE**

### Tier 3: Borderline cases

These involve heavier state transitions or side effects that interact with WebSocket connection state:

| Current WS message | Could be HTTP? | Complication |
|---|---|---|
| `get_chat_history` | Partially | The read is HTTP-friendly, but it also calls `activateSession()` which mutates per-connection state (attaches runner, starts file watcher, etc.). Would need to split into "fetch history" (GET) and "activate session" (WS). |
| `fork_session` | Partially | Creates worktree + session, but the client then needs to receive push events for the new session. Response itself is simple. |
| `fork_thread` | Partially | Does git rollback + conversation replay. Heavy side effects on server. |
| `switch_thread` | Partially | Similar to fork_thread — git rollback + history swap. |
| `merge_session` | Yes | Simple git merge, returns result. |
| `home_create_repo_with_template` | Partially | Creates GitHub repo + session + worktree. Long-running but not streaming. Could be HTTP with polling. |
| `generate_pr_description` | Partially | Spawns text generation (calls LLM). Could be HTTP if client is willing to wait (or use polling). |
| `start_auth` / `paste_auth_code` | Maybe | OAuth flow state. `auth_complete` is pushed over WS when OAuth finishes asynchronously. The initiation could be HTTP but completion notification needs WS or polling. |

## Practical benefits of extracting HTTP endpoints

### 1. Parallel initial data loading
Currently on WS connect (`useConnectionSync.ts`), the client sends 4-5 messages sequentially:
```ts
send({ type: "github_get_status" });
send({ type: "list_sessions" });
send({ type: "list_agents" });
send({ type: "list_templates" });
send({ type: "get_chat_history", sessionId });
```
With HTTP, these could be `Promise.all()` fetched in parallel, and could even begin before the WebSocket connection is established.

### 2. Standard HTTP semantics
- Proper status codes (404 for missing files, 409 for conflicts, 413 for oversized content)
- Browser caching with `Cache-Control` / `ETag` for static-ish data (templates, agent list, features)
- Standard error handling instead of checking `msg.type === "error"`
- Content-type negotiation (serve raw file content vs JSON wrapper)

### 3. Simpler client code
Request-response over WebSocket requires the client to:
1. Send a message
2. Set up a listener for the matching response type
3. Handle the case where the response never arrives (no timeout mechanism exists today)
4. Handle interleaved responses from other operations

With HTTP `fetch()`, the client gets a promise that resolves with the response or rejects with an error. No listener management needed.

### 4. Better separation of concerns
The single 150-line switch statement in `index.ts` mixes read-only queries, mutations, streaming operations, and session lifecycle management. HTTP routing would naturally organize these by resource and method.

### 5. Testability
HTTP endpoints are simpler to test than WebSocket message flows — just `app.inject()` with Fastify's testing API instead of establishing a WebSocket connection and parsing message streams.

## Practical concerns with the migration

### 1. Session context
Most handlers use `ctx.getActiveDir()` and `ctx.getActiveAppSessionId()`. HTTP endpoints would need the session ID passed explicitly. This is actually *better* — explicit is clearer than implicit connection state — but it's a non-trivial refactor.

### 2. Authentication
The current system authenticates via WebSocket connection establishment. HTTP endpoints would need their own auth mechanism (session cookies, bearer tokens, or relying on the same WebSocket-established session via a shared session store).

### 3. Incremental migration path
Both protocols can coexist. The WebSocket connection is still needed for streaming and push events. HTTP endpoints can be added alongside without removing any WS messages. Old WS messages can be deprecated gradually.

### 4. Handler context reuse
The `HandlerContext` interface (`ws-handlers/types.ts`) bundles per-connection state with app-level managers. HTTP handlers would only need the app-level managers plus an explicit session ID. A shared "service layer" could serve both.

## Recommendation

**~47 of ~55 client message types** are request-response patterns that don't need WebSocket. The strongest candidates for immediate extraction are the **24 pure reads** (Tier 1) since they have zero side effects and map directly to GET endpoints.

The recommended migration order:
1. Extract Tier 1 reads as GET endpoints (low risk, high clarity gain)
2. Extract Tier 2 mutations as POST/PATCH/DELETE endpoints
3. Keep streaming (agent, terminal, deploy) and push events on WebSocket
4. Split `get_chat_history` into a read (HTTP) and an activate (WS) operation

The WebSocket would then be responsible for exactly what it's good at: streaming agent output, terminal I/O, file change notifications, and other push events — roughly 8-10 message types instead of 55.
