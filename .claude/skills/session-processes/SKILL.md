---
description: "ShipIt session worker processes: Claude CLI spawning and NDJSON parsing, agent abstraction (AgentProcess, ProxyAgentProcess), Docker Compose services (ServiceManager), file watcher, terminal PTY, session worker endpoints. Load when working on Claude process management, compose services, file watcher, terminal, or agent adapters."
user-invocable: true
---

# Session Worker Processes

Each session runs in a Docker container with a Fastify server (port 9100) that manages the Claude CLI, preview server, file watcher, and terminal. The orchestrator communicates with session workers via HTTP (commands) and SSE (events).

## Session Worker

`src/server/session/session-worker.ts` — Fastify server running inside each container.

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
| `file_changes` | FileWatcher | Changed file paths |

On SSE connect (or reconnect), the worker replays current state:
- If terminal is alive -> sends empty `terminal_data` signal

Note: Preview/dev servers are now managed by Docker Compose via `ServiceManager` in the orchestrator, not inside the session worker. See `service-manager.ts` and `compose-generator.ts`.

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
3. Valid JSON -> emit as `"event"` (typed as `ClaudeEvent`)
4. Invalid JSON -> emit as `"log"` (non-event output)

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

- Translates `ClaudeEvent` -> `AgentEvent` (unified event format)
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
- `run()` -> `POST /agent/start`
- `interrupt()` -> `POST /agent/interrupt`
- `kill()` -> `POST /agent/kill`
- `writeStdin()` -> `POST /agent/stdin`

Agent events flow back via SSE -> proxied to the `ProxyAgentProcess` event emitter.

## Docker Compose Services

Dev servers and other services are managed by Docker Compose, not the session worker. The orchestrator runs:

- `ServiceManager` (`src/server/orchestrator/service-manager.ts`) — per-session compose lifecycle: start/stop, status polling, log streaming, IP resolution
- `compose-generator.ts` — generates override files with ShipIt labels, session network, volume rewrites, port stripping

Services are defined in `docker-compose.yml` at the workspace root. `shipit.yaml` references the compose file and configures the agent container (install commands, resource limits).

The agent container can query service status/logs via the orchestrator API using `SHIPIT_HOST`, `SHIPIT_PORT`, and `SHIPIT_SESSION_ID` environment variables.

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
| Message queue | 50 | `SessionRunnerInterface` |
| Turn event buffer | 1,000 | `SessionRunnerInterface` |
| Terminal output buffer | 10K chars | `SessionRunnerInterface` |
| Service log buffer | 80K chars | `ServiceManager` |
