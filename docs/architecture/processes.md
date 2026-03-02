# Process & Container Architecture

ShipIt isolates each session in a Docker container. The orchestrator communicates with session workers via HTTP (commands) and SSE (events). Inside each container, a session worker manages the Claude CLI, preview server, file watcher, and terminal.

## Container Lifecycle

### Creation

`SessionContainerManager.create(config)` in `src/server/orchestrator/session-container.ts`:

1. Build Docker mounts:
   - Session dir → `/workspace` (read-write)
   - Credentials dir → `/credentials` (read-only)
   - Shared repo dir → same absolute path (for git worktree resolution)
2. Create container with resource limits (512 MB memory, 0.5 CPU, 256 PIDs)
3. Start container
4. Inspect for bridge IP
5. Poll `GET http://{ip}:9100/health` every 500ms (up to 30s)
6. Return `{ id, workerUrl, containerIp, status: "running" }`

### Destruction

```
container.stop({ t: 5 })       // 5-second graceful timeout
container.remove({ force: true })
Remove from containers map
```

### Persistence Across Runner Disposal

When a runner is disposed (idle timeout, eviction), the Docker container is NOT stopped. The runner:
- Kills the agent process (fire-and-forget)
- Disconnects SSE
- Does NOT stop the preview server or file watcher

The container keeps running. When a user returns, a new runner reconnects to the existing container instantly — no container restart needed.

### Health Monitor

The container manager listens to Docker events (`die`, `oom`) via `docker.getEvents()`. On container exit:
1. Parse session ID from container labels
2. Remove from containers map
3. Emit `container_exited` event
4. Orchestrator sends error to connected clients and disposes the runner

### Startup Recovery

On server restart:
1. **Orphan cleanup**: List containers with `shipit-session-id` label, destroy any not in `sessionManager.allIds()`
2. **Rediscovery**: For containers that ARE in the session list, restore them to the in-memory map so runners can reconnect

## Session Worker

`src/server/session/session-worker.ts` — a Fastify server (port 9100) running inside each container.

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/agent/start` | Start Claude with prompt, images, system prompt |
| `POST` | `/agent/interrupt` | Graceful interrupt (Ctrl+C) |
| `POST` | `/agent/kill` | Force terminate |
| `POST` | `/agent/stdin` | Write to agent stdin (answer questions) |
| `POST` | `/terminal/start` | Start interactive shell |
| `POST` | `/terminal/input` | Write to terminal |
| `POST` | `/terminal/resize` | Resize terminal |
| `POST` | `/preview/start` | Start preview server |
| `POST` | `/preview/stop` | Stop preview server |
| `POST` | `/preview/restart` | Restart preview server |
| `POST` | `/files/watch` | Start file watcher (idempotent) |
| `POST` | `/files/unwatch` | Stop file watcher |
| `GET` | `/files/tree` | Scan file tree |
| `GET` | `/events` | SSE event stream |
| `GET` | `/health` | Health check |

### SSE Event Stream

The `/events` endpoint is a long-lived SSE connection. The worker broadcasts events from all managed processes:

| Event | Source | Data |
|-------|--------|------|
| `agent_event` | Claude CLI | Parsed NDJSON agent events |
| `agent_done` | Claude CLI | Exit code |
| `agent_error` | Claude CLI | Error message |
| `agent_auth_required` | Claude CLI | Auth URL |
| `agent_log` | Claude CLI | Non-JSON output lines |
| `terminal_data` | Terminal | Output data |
| `terminal_exit` | Terminal | Exit code |
| `preview_ready` | PreviewManager | Detected ports |
| `preview_stopped` | PreviewManager | Exit code |
| `preview_config_missing` | PreviewManager | No valid config |
| `preview_config_error` | PreviewManager | Config parse error |
| `preview_install_status` | PreviewManager | Install progress |
| `preview_log` | PreviewManager | Build output |
| `file_changes` | FileWatcher | Changed file paths |

On SSE connect (or reconnect), the worker replays current state:
- If preview is running → sends `preview_ready` with ports
- If preview crashed → replays recent log lines + `preview_stopped`
- If terminal is alive → sends empty `terminal_data` signal

## Claude Process

`src/server/session/claude.ts` — spawns the Claude CLI and manages streaming NDJSON interaction.

### Spawning

Uses `node-pty` to create a real PTY (avoids stdin pipe hangs):
```
claude --output-format stream-json
       --verbose
       --model <model>
       --permission-mode <mode>
       --allowedTools <tool-list>
       --max-turns 200
```

The tool list varies by permission mode:
- **auto**: Write, Read, Edit, Bash, Glob, Grep, WebFetch, WebSearch, AskUserQuestion
- **plan**: Read, Glob, Grep, WebFetch, WebSearch (read-only)
- **normal**: Read, Glob, Grep, WebFetch, WebSearch, AskUserQuestion (supervised)

### NDJSON Parsing

Claude CLI outputs one JSON object per line. The process:
1. Accumulates PTY data into a line buffer
2. On each newline, attempts `JSON.parse()`
3. Valid JSON → emit as `"event"` (typed as `ClaudeEvent`)
4. Invalid JSON → emit as `"log"` (non-event output)

### Watchdog

A 30-second inactivity timer detects hung processes. If no output is received within the timeout, it logs a warning. This handles edge cases where the CLI process stalls.

### Prompt Delivery

Prompts are written to stdin as JSON content blocks:
```json
[{"type":"text","text":"user prompt"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]
```

File context references are prepended as text blocks with XML-like markers.

## Agent Abstraction

`src/server/session/agents/claude-adapter.ts` wraps `ClaudeProcess` as an `AgentProcess` (defined in `src/server/shared/types/agent-types.ts`). The adapter:

- Translates `ClaudeEvent` → `AgentEvent` (unified event format)
- Reports capabilities (supported tools, models, permission modes)
- Forwards all events from the inner process

The `AgentProcess` interface is transport-agnostic:
```typescript
interface AgentProcess extends EventEmitter {
  agentId: AgentId;
  capabilities: AgentCapabilities;
  run(params: AgentRunParams): void;
  writeStdin(data: string): void;
  interrupt(): void;
  kill(): void;
}
```

In production, the orchestrator never creates agents directly. Instead, `ContainerSessionRunner.createAgent()` returns a `ProxyAgentProcess` that delegates to the worker via HTTP:
- `run()` → `POST /agent/start`
- `interrupt()` → `POST /agent/interrupt`
- `kill()` → `POST /agent/kill`
- `writeStdin()` → `POST /agent/stdin`

Agent events flow back via SSE → proxied to the `ProxyAgentProcess` event emitter.

## Session Runner

### Interface

`SessionRunnerInterface` in `src/server/orchestrator/session-runner.ts` defines the contract:

- **Agent state**: `running`, `wasInterrupted`, `accumulatedText`, `agentId`
- **Message queue**: `enqueue()`, `dequeue()`, `clearQueue()` (max 50)
- **Turn event buffer**: accumulates WS messages for replay to new viewers (max 1000)
- **Terminal**: remote or local PTY access
- **Preview**: `buildPreviewStatus()`, `previewStatusKnown`
- **Lifecycle**: `dispose()`, `disposed`, `onAgentFinished()`
- **Viewer management**: `attachViewer()`, `detachViewer()`, viewer count

### ContainerSessionRunner

`src/server/orchestrator/container-session-runner.ts` — production implementation.

**Worker Ready Promise**: Initializes with a `_workerReady` promise. All HTTP calls to the worker await this. Resolves immediately when reconnecting to an existing container (real URL provided), or when `setWorkerUrl()` is called after container creation.

**SSE Connection**: `connectEventStream()` opens a long-lived SSE connection to the worker. Reconnects with exponential backoff (1s → 2s → 4s → 8s → 10s cap).

**Viewer Lifecycle**:
```
attachViewer():
  viewerCount++
  if first viewer:
    connect SSE → start worker resources (file watcher, preview)

detachViewer():
  viewerCount--
  if 0 viewers && never used:
    reset idle timer to 10 seconds (quick cleanup)
```

**Preview Auto-Recovery**: When an agent turn finishes (`onAgentFinished()`), if the preview had crashed, it's automatically restarted — the agent may have fixed the issue.

### SessionRunnerRegistry

`src/server/orchestrator/session-runner.ts` — app-level map of session ID → runner.

- `getOrCreate(sessionId, dir, agentId)` — return existing or create via factory
- Max 10 concurrent runners; evicts oldest idle runner if at capacity
- Registers `"disposed"` listener for auto-cleanup
- `disposeAll()` for graceful shutdown

### Runner Factory

The factory in `buildApp()` handles three cases:

1. **Existing running container** → create runner with existing `workerUrl` (instant reconnect)
2. **Existing stale container** → destroy old, create new container, set URL when ready
3. **No container** → create new container, set URL when ready

The factory is synchronous — it returns the runner immediately. Container creation happens async; the runner queues operations behind `_workerReady`.

## Idle Timer

Both runner implementations have an idle timer (default 10 minutes). After timeout with no running agent, no queue, and no viewers → `dispose()`.

Special case: `ContainerSessionRunner` tracks `_hasBeenUsed`. If a viewer detaches and the runner was never used (no agent started), the idle timer resets to 10 seconds instead of 10 minutes. This cleans up containers from briefly-visited sessions.

## Preview Manager

`src/server/session/preview-manager.ts` — config-driven preview server.

### Config Resolution

Via `resolvePreviewConfig()` in `preview-config.ts`:
1. Read `shipit.yaml` (if present) for explicit config
2. Fall back to `package.json` and `index.html` detection
3. Two modes: **HTML** (bundled Vite + error-capture plugin) or **Command** (arbitrary shell command)

### Install Step

Runs install command once per session, marks completion with `.shipit/.install-done` sentinel file.

### Port Detection

- **HTML mode**: Vite reports its URL on stdout
- **Command mode**: Polls configured port or scans stdout for port patterns

### Error Capture

`vite-error-plugin.ts` injects a script into preview HTML that captures uncaught errors and posts them to the parent frame. The client's `usePreviewErrors` hook receives these and can trigger auto-fix.

## File Watcher

`src/server/session/file-watcher.ts` — uses `fs.watch` with `recursive: true`.

- 300ms debounce to collapse bulk operations
- Set-based deduplication of file paths
- Ignores: `node_modules`, `.git`, `.vite`, `.next`, `.cache`, `dist`, etc.
- Emits `"changes"` event with deduplicated paths

## Terminal

`src/server/session/terminal.ts` — wraps `node-pty` for interactive shell.

- Spawns shell in the workspace directory
- Emits `"data"` for output, `"exit"` on close
- Supports resize during session
- Output buffer capped at 10K characters

## Resource Limits

| Resource | Limit | Location |
|----------|-------|----------|
| Container memory | 512 MB | `session-container.ts` |
| Container CPU | 0.5 (50,000 quota) | `session-container.ts` |
| Container PIDs | 256 | `session-container.ts` |
| Concurrent runners | 10 | `SessionRunnerRegistry` |
| Runner idle timeout | 10 min (default) | `SessionRunnerRegistry` |
| Unused runner idle | 10 sec | `ContainerSessionRunner` |
| Message queue | 50 | `SessionRunnerInterface` |
| Turn event buffer | 1,000 | `SessionRunnerInterface` |
| Terminal output buffer | 10K chars | `SessionRunnerInterface` |
| Preview log buffer | 50 lines | `PreviewManager` |
| Health check timeout | 30 sec | `session-container.ts` |
| SSE reconnect backoff | 1s → 10s | `container-session-runner.ts` |
