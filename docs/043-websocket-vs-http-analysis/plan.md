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

#### Combined endpoints

Several WS messages are always sent together from the client. These should be single HTTP endpoints instead of separate requests:

| Combined endpoint | Replaces | Trigger |
|---|---|---|
| `GET /api/bootstrap` | `list_sessions` + `list_agents` + `list_templates` + `github_get_status` + `get_global_settings` | Page load (before WS connects) |
| `GET /api/sessions/:id/deploy/setup` | `list_deploy_targets` + `get_project_settings` | Opening deploy modal or deploy settings tab (2 call sites) |
| `GET /api/sessions/:id/workspace-state` | `get_git_log` + `get_file_tree` | After rejecting changes in diff review |

Additionally, `get_file_content` is often called right after `get_file_tree` (after commits and file-change events when the files tab is active). The file content endpoint can accept an optional `tree=true` query param to include the file tree in the response, avoiding a second round trip.

#### Individual endpoints

| Current WS message | Proposed HTTP endpoint | Notes |
|---|---|---|
| `get_file_tree` | `GET /api/sessions/:id/files` | Returns directory tree |
| `get_file_content` | `GET /api/sessions/:id/files/*path` | Returns file content; `?tree=true` to include file tree |
| `list_docs` | `GET /api/sessions/:id/docs` | Markdown file list |
| `get_doc` | `GET /api/sessions/:id/docs/*path` | Single doc content |
| `get_git_log` | `GET /api/sessions/:id/git/log` | Commit list |
| `get_turn_diff` | `GET /api/sessions/:id/git/diff?from=X&to=Y` | Diff between commits |
| `get_session_status` | `GET /api/sessions/:id/status` | Running state + queue length |
| `get_chat_history` | `GET /api/sessions/:id/history` | Messages + git log + file tree (also activates session — see caveats) |
| `get_deploy_history` | `GET /api/sessions/:id/deploy/history` | Past deployments |
| `get_usage_stats` | `GET /api/sessions/:id/usage` | Cost/duration totals |
| `github_get_remotes` | `GET /api/sessions/:id/git/remotes` | Remote list |
| `github_list_branches` | `GET /api/sessions/:id/git/branches` | Local + remote branches |
| `github_search_repos` | `GET /api/github/repos?q=...` | Repo search |
| `get_pr_status` | `GET /api/sessions/:id/pr/status` | PR state + CI checks |
| `list_threads` | `GET /api/sessions/:id/threads` | Thread list |
| `list_worktrees` | `GET /api/sessions/:id/worktrees` | Sibling worktrees |
| `list_features` | `GET /api/features` | Feature docs with status |

**Count: 24 WS message types → 3 combined + 17 individual = 20 HTTP GET endpoints**

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

### Tier 3: Borderline cases — detailed analysis

These involve heavier state transitions or side effects that interact with WebSocket connection state. Each case is analyzed against the actual handler code with a concrete verdict.

#### 1. `get_chat_history` — Split into HTTP read + WS activate

**Handler**: `session-handlers.ts:128-172`

**What it does**:
1. Validates worktree directory existence
2. Calls `ctx.activateSession(sessionId)` — the heavy part (see `index.ts:739-796`):
   - Sets `activeAppSessionId` and `activeSessionDir` on the connection
   - Attaches/creates a `SessionRunner` (owns agent process, preview, file watcher)
   - Stops old preview, clears terminal logs, resets detected ports
   - Starts new file watcher and preview manager
   - Runs port scan, checks git identity
3. Loads and sends chat messages
4. Sends git log and file tree (bundled to avoid race conditions with separate requests)

**What pulls toward HTTP**: The data portion (messages + git log + file tree) is a pure read. It could fire before WS connects, enabling instant page loads with cached data.

**What pulls toward WS**: `activateSession()` mutates 8+ pieces of per-connection state. It triggers `preview_status`, `clear_logs`, `install_status`, and potentially `git_identity_required` push events on the same connection. These are all WS-specific.

**Verdict**: **Split.** `GET /api/sessions/:id/history` returns `{ messages, commits, fileTree }` as a pure read. A new `activate_session` WS message handles session switching and its cascade of push events. The client calls the HTTP endpoint for data, then sends `activate_session` over WS. This naturally separates "what data do I need?" from "wire me up to this session's live events."

**Migration complexity**: Low. The logic is already sequential — the read happens after activate. Split at line 150.

---

#### 2. `fork_session` — HTTP POST + WS broadcast

**Handler**: `worktree-handlers.ts:10-75`

**What it does**:
1. Validates branch name (regex check for invalid git chars)
2. Creates a git worktree from the shared repo or session dir
3. Configures git credentials and identity in the new worktree
4. Tracks the new session in SessionManager
5. Initializes ThreadManager for the new session
6. Sends back `session_forked` + updated `session_list`

**What pulls toward HTTP**: Classic resource creation — POST that returns the created resource. No streaming. No connection state mutation (does NOT call `activateSession`, does NOT change `activeSessionDir`). The caller stays on their current session.

**What pulls toward WS**: Sends two response messages (`session_forked` + `session_list`). The `session_list` is also sent by other handlers — having it as a WS push means all tabs see the new session. But this is solvable: HTTP returns the result to the caller, then broadcasts `session_list` over WS to other connections.

**Verdict**: **HTTP POST** at `POST /api/sessions/:id/fork` with body `{ branchName, startPoint? }`. Returns `{ session, parentSessionId, sessions }` (combined response). Optionally broadcast `session_list` over WS to other tabs.

**Migration complexity**: Low.

---

#### 3. `fork_thread` — Keep on WS

**Handler**: `thread-handlers.ts:60-138`

**What it does**:
1. Snapshots chat history and thread data BEFORE any git operation
2. Executes `git.rollback(checkpoint.commitHash)` — **hard git reset** that reverts the entire working tree
3. Restores thread data (which the git reset just wiped from disk)
4. Builds a conversation replay prompt for the new thread
5. Saves thread-specific chat history under a composite key
6. Restarts the preview manager (`ctx.previewManager.restart()`)
7. Returns `thread_forked` with the new thread + truncated message history

**What pulls toward HTTP**: The response is a single JSON object. No streaming.

**What pulls toward WS**:
- `git.rollback()` reverts working tree files, which triggers `files_changed` push events from the file watcher on the same connection
- `previewManager.restart()` triggers a cascade of `preview_status` and `install_status` push events
- The git reset changes the state that the preview server depends on — the client needs to see both the `thread_forked` response AND the subsequent preview lifecycle events through the same channel
- If done via HTTP, the client would need to coordinate: "wait for HTTP response, also listen on WS for preview_status and files_changed that the HTTP call triggered." This split-brain is worse than keeping it unified.

**Verdict**: **Keep on WS.** The git reset + preview restart produce push events that are deeply entangled with the WS connection's push channel. Splitting trigger (HTTP) from effects (WS push) adds coordination complexity for no benefit.

**Migration complexity**: High (if attempted). Not recommended.

---

#### 4. `switch_thread` — Keep on WS

**Handler**: `thread-handlers.ts:140-198`

**What it does**:
1. Snapshots thread data (git rollback will revert files on disk)
2. Switches the active thread in ThreadManager
3. Loads conversation history for the target thread (BEFORE git rollback)
4. Executes `git.rollback()` to the parent checkpoint's commit
5. Restores thread data post-rollback
6. Restarts preview manager
7. Returns `thread_switched` with thread + messages

**Why**: Structurally identical to `fork_thread`. Same git reset, same preview restart, same file watcher implications. Same verdict.

**Verdict**: **Keep on WS.** Same reasoning as `fork_thread`.

---

#### 5. `merge_session` — HTTP POST

**Handler**: `worktree-handlers.ts:109-153`

**What it does**:
1. Validates source session exists and has a branch
2. Gets the active git manager
3. Calls `git.merge(sourceSession.branch)`
4. Returns `merge_result` with `success`/`failure` + optional `conflicts` array

**What pulls toward HTTP**: Textbook POST. Single request, single response. No streaming. No push events. No preview restart. No connection state mutation.

**What pulls toward WS**: Only that it uses `ctx.getActiveGitManager()` which depends on connection state. With HTTP, the session ID goes in the URL instead.

**Verdict**: **HTTP POST** at `POST /api/sessions/:id/git/merge` with body `{ sourceSessionId }`. One of the easiest Tier 3 migrations.

**Migration complexity**: Very low.

---

#### 6. `home_create_repo_with_template` — HTTP POST + WS activation

**Handler**: `template-handlers.ts:57-132`

**What it does**:
1. Validates repo name, template ID, GitHub auth
2. Creates a GitHub repository via API
3. Creates a session directory (skipping git init)
4. Removes empty dir, creates worktree from shared repo
5. Configures credentials and identity
6. Applies template files, auto-commits, pushes to main
7. Updates session metadata
8. Sends `session_started`, restarts preview, sends `home_repo_ready`

**What pulls toward HTTP**: The response is a single `home_repo_ready` JSON. The operation is long-running (5-15s for GitHub API + clone + push) but not streaming — no intermediate progress events. The client just waits for success/failure.

**What pulls toward WS**:
- Sets `activeAppSessionId` and `activeSessionDir` — connection-scoped state
- Starts `fileWatcher` — connection-scoped resource
- Sends `session_started` as a side effect
- Restarts preview — triggers `preview_status` push events
- The 5-15s duration could cause timeout issues on flaky connections

**Verdict**: **HTTP POST + follow-up WS activation.**
- `POST /api/repos` with body `{ repoName, templateId, description?, isPrivate? }`. Does steps 1-7. Returns `{ success, repoUrl, sessionId }`.
- Client receives the `sessionId`, then sends `activate_session` over WS to start file watcher, preview, etc.
- This naturally separates "create the repo" (HTTP, retryable, stateless) from "make it my active session" (WS, connection-scoped).

**Migration complexity**: Medium. Requires splitting the handler at the `setActiveAppSessionId` call.

---

#### 7. `generate_pr_description` — HTTP POST

**Handler**: `pr-handlers.ts:183-215`

**What it does**:
1. Gets git log (last 20 commits) and diff summary
2. Builds a prompt from commits + file changes
3. Calls `ctx.generateText(prompt)` — spawns an LLM process, waits for full result
4. Returns `generated_pr_description` with the text

**What pulls toward HTTP**: Classic async POST. Single request, single response. No connection state dependency beyond the session dir (replaceable with URL param). No push events. No streaming — the LLM call is fully buffered.

**What pulls toward WS**: The latency (3-30s). But the current WS implementation already has the client waiting with no progress indicator, so nothing changes UX-wise. Fastify's default timeout is 30s, which is sufficient.

**Verdict**: **HTTP POST** at `POST /api/sessions/:id/pr/description`. Returns `{ description }`. Set a reasonable timeout (30s).

**Migration complexity**: Very low. The handler barely uses `ctx` — just `getActiveGitManager()` and `getActiveSessionDir()`, both replaceable with the session ID param.

---

#### 8. `start_auth` / `paste_auth_code` — HTTP POST + WS push

**Handlers**: `settings-handlers.ts:37-48`

**What `start_auth` does**: Calls `ctx.authManager.startOAuthFlow()`. No direct response. The auth URL arrives later via `authManager.on("auth_url")` which broadcasts `auth_required` to all connections.

**What `paste_auth_code` does**: Validates the code string, calls `ctx.authManager.sendCode(code)` to write to the OAuth process's stdin. On success, sends no direct response — `auth_complete` arrives asynchronously via EventEmitter broadcast.

**What pulls toward HTTP**: Both are fire-and-forget mutations. `start_auth` is one line. `paste_auth_code` just validates input and forwards it. Neither reads connection state.

**What pulls toward WS**: The completion (`auth_complete`) arrives asynchronously over WS. But this two-channel pattern (HTTP trigger + WS notification) is well-understood — e.g., GitHub's device auth flow uses HTTP + polling.

**Verdict**: **HTTP POST + WS push.**
- `POST /api/auth/start` — returns `202 Accepted`.
- `POST /api/auth/code` — body `{ code }`. Returns `200 OK` or `400` on validation error.
- `auth_complete` stays as a WS broadcast — it already works this way.
- The client already handles the async pattern: it sends the request and waits for `auth_complete` on WS. Moving the trigger to HTTP doesn't change this flow.

**Migration complexity**: Very low.

---

### Tier 3 summary

| Message | Verdict | HTTP endpoint | Complexity |
|---|---|---|---|
| `get_chat_history` | **Split** (HTTP read + WS activate) | `GET /api/sessions/:id/history` + WS `activate_session` | Low |
| `fork_session` | **HTTP POST** + WS broadcast | `POST /api/sessions/:id/fork` | Low |
| `fork_thread` | **Keep WS** | — | N/A |
| `switch_thread` | **Keep WS** | — | N/A |
| `merge_session` | **HTTP POST** | `POST /api/sessions/:id/git/merge` | Very low |
| `home_create_repo_with_template` | **HTTP POST** + WS activation | `POST /api/repos` | Medium |
| `generate_pr_description` | **HTTP POST** | `POST /api/sessions/:id/pr/description` | Very low |
| `start_auth` / `paste_auth_code` | **HTTP POST** + WS push | `POST /api/auth/start`, `POST /api/auth/code` | Very low |

**Net result**: 6 of 8 Tier 3 messages migrate to HTTP. Only `fork_thread` and `switch_thread` stay on WS due to their git-reset + preview-restart entanglement with the push channel.

## Practical benefits of extracting HTTP endpoints

### 1. Single bootstrap request
Currently on WS connect (`useConnectionSync.ts`), the client sends 4-5 messages sequentially:
```ts
send({ type: "github_get_status" });
send({ type: "list_sessions" });
send({ type: "list_agents" });
send({ type: "list_templates" });
send({ type: "get_chat_history", sessionId });
```
With HTTP, this becomes a single `GET /api/bootstrap` that returns all initial data (sessions, agents, templates, GitHub status, global settings) in one round trip. This can fire immediately on page load — before the WebSocket connection is even established.

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
