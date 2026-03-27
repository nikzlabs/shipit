---
status: planned
---

# 088 — User MCP Server Integration

## Overview

Allow users to connect their own MCP servers (e.g., Linear, Notion, Sentry, Datadog) to the Claude agent running inside session containers. This gives the inner agent access to external tools and data sources beyond the built-in filesystem/browser tools.

## Motivation

Today the inner agent only has access to Playwright MCP (built-in). Users building real applications need the agent to interact with external services — filing Linear issues, querying Sentry errors, reading Notion docs, checking Datadog metrics. MCP is the standard protocol for this, and Claude Code CLI already supports `--mcp-config` for arbitrary servers.

## Design

### User model

Users configure MCP servers at the **account level** (not per-session). A configured MCP server is available in all sessions. This matches how users think about tool access — "I want Claude to be able to use Linear" — not "I want Linear in this one session."

Each MCP server definition consists of:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier, becomes the MCP namespace (e.g., `linear` → tools prefixed `mcp__linear__*`) |
| `type` | yes | Transport type: `"stdio"` or `"sse"` |
| `command` | stdio only | Command to run (e.g., `npx @linear/mcp-server`) |
| `args` | no | Command arguments array |
| `url` | sse only | SSE endpoint URL |
| `env` | no | Environment variables the server needs (e.g., `LINEAR_API_KEY`) |
| `headers` | sse only | HTTP headers for SSE connection (e.g., auth tokens) |
| `enabled` | no | Boolean, defaults to `true`. Allows disabling without deleting. |

### Architecture

```
Browser UI                    Orchestrator                     Session Container
───────────                   ────────────                     ─────────────────

Settings panel  ──HTTP──►  /api/mcp-servers (CRUD)
                              │
                              │ persist to
                              ▼
                          McpServerStore
                          (SQLite, per-user)
                              │
                              │ on agent start
                              ▼
                      AgentRunParams.mcpConfig
                              │
                              │ POST /agent/start
                              ▼
                          session-worker.ts
                              │
                              │ merges built-in +
                              │ user MCP servers
                              ▼
                          /tmp/mcp-config-{ts}.json
                              │
                              │ --mcp-config flag
                              ▼
                          Claude CLI process
                              │
                              ├──► stdio MCP server (spawned)
                              └──► SSE MCP server (connected)
```

### Key decisions

**1. Where MCP servers run: inside the session container**

Stdio MCP servers are spawned as child processes of the Claude CLI inside the session container. SSE MCP servers connect outbound from the container. This is the simplest approach — it matches how `claude --mcp-config` works locally and requires no proxy infrastructure.

Trade-offs:
- (+) Zero new infrastructure — Claude CLI handles MCP protocol natively
- (+) Stdio servers get the same sandboxed environment as the agent
- (+) SSE servers work with any hosted MCP endpoint (no network changes needed)
- (-) Stdio server binaries must be available inside the container (see "Server availability" below)
- (-) Each session spawns its own MCP server instances (no sharing)

**2. Secrets handling: stored separately, injected as env vars**

MCP server credentials (API keys, tokens) are stored in a dedicated secrets table, encrypted at rest, separate from the MCP server config. At agent start time, the orchestrator resolves secrets and includes them in the MCP config's `env` block sent to the container.

This means:
- Server definitions are safe to log/display (no embedded secrets)
- Secrets use the existing `SecretStore` pattern (SQLite, per-user)
- The agent process inherits these env vars, making them available to stdio MCP servers
- SSE server headers can reference secrets via interpolation (e.g., `"Authorization": "Bearer ${MCP_LINEAR_TOKEN}"`)

**3. Tool allowlisting: user controls which MCP tools the agent can call**

By default, all tools from a user-configured MCP server are allowed in `auto` mode. The `--allowedTools` flag already supports glob patterns (`mcp__linear__*`), so we add each enabled server's namespace to the allowlist.

For `plan` and `normal` modes, MCP tools are read-only by default (allowed) but write operations require user approval — matching the existing permission model. Since we can't reliably distinguish read vs write MCP tools without server metadata, all user MCP tools are blocked in `plan` mode and require approval in `normal` mode.

**4. Server availability in containers: npm-based install at session start**

Stdio MCP servers are typically distributed as npm packages (e.g., `@linear/mcp-server`). Rather than baking every possible MCP server into the container image, we install them on demand:

- When a session starts with user MCP servers configured, the session worker runs `npm install -g <package>` for each stdio server before starting the agent
- Installed packages persist for the session's lifetime (container filesystem)
- A future optimization could pre-install popular servers in the base image

For non-npm servers (binary, Python, etc.), users can specify a `setup` command that runs before the server starts.

### Data model

#### McpServerStore (new)

Persists MCP server configurations in SQLite. Schema:

```sql
CREATE TABLE mcp_servers (
  id          TEXT PRIMARY KEY,        -- user-chosen name (e.g., "linear")
  config      TEXT NOT NULL,           -- JSON blob of McpServerConfig
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

#### McpServerConfig type

```typescript
// src/server/shared/types/mcp-types.ts

interface McpStdioServerConfig {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;       // env var names → secret references or literal values
  npmPackage?: string;                 // package to npm install -g (e.g., "@linear/mcp-server")
  setup?: string;                      // optional setup command
  enabled: boolean;
}

interface McpSseServerConfig {
  name: string;
  type: "sse";
  url: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
}

type McpServerConfig = McpStdioServerConfig | McpSseServerConfig;
```

### API endpoints

All endpoints under `/api/mcp-servers`. Following the service layer pattern (routes → services → store).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mcp-servers` | List all configured MCP servers |
| `POST` | `/api/mcp-servers` | Add a new MCP server |
| `PUT` | `/api/mcp-servers/:id` | Update an MCP server config |
| `DELETE` | `/api/mcp-servers/:id` | Remove an MCP server |
| `POST` | `/api/mcp-servers/:id/test` | Test connectivity (start server, list tools, stop) |

### Agent start flow (modified)

Current flow in `session-worker.ts` generates MCP config with only Playwright. The new flow:

1. Orchestrator loads user MCP servers from `McpServerStore`
2. Filters to `enabled: true` servers
3. Resolves secret references in `env` and `headers` fields
4. Passes the full MCP server list in `AgentRunParams` (new field: `mcpServers: McpServerConfig[]`)
5. Session worker's `generateMcpConfig()` merges built-in Playwright config with user servers
6. If any stdio servers have `npmPackage`, run install before writing config
7. Write merged config to `/tmp/mcp-config-{ts}.json`
8. Pass to Claude CLI via `--mcp-config`

### Tool allowlist changes

In `claude.ts`, the tool allowlist construction adds user MCP server namespaces:

```typescript
// For each enabled user MCP server, add its tool namespace
for (const server of userMcpServers) {
  autoTools.push(`mcp__${server.name}__*`);
}
```

For `plan` mode, user MCP tools are excluded (read-only agent). For `normal` mode, they're included but the agent must use `AskUserQuestion` before calling them (enforced by system prompt instructions).

### Client UI

#### Settings panel addition

New section in Settings: **"MCP Servers"** (between "Instructions" and "Secrets").

- List of configured servers with name, type, status (enabled/disabled), and actions (edit/delete/toggle)
- "Add MCP Server" button opens a form:
  - Name field (validated: lowercase alphanumeric + hyphens, unique)
  - Type selector (stdio / sse)
  - Conditional fields based on type (command+args or url+headers)
  - Environment variables section (key-value pairs, values masked)
  - npm package field (stdio only, optional)
  - Test button to verify connectivity
- Connected indicator per server in the session sidebar (shows which MCP servers are active)

#### Store

New Zustand store `mcp-store.ts`:

```typescript
interface McpStore {
  servers: McpServerConfig[];
  loading: boolean;
  fetchServers: () => Promise<void>;
  addServer: (config: McpServerConfig) => Promise<void>;
  updateServer: (id: string, config: Partial<McpServerConfig>) => Promise<void>;
  removeServer: (id: string) => Promise<void>;
  testServer: (id: string) => Promise<TestResult>;
}
```

### Security considerations

1. **Secret isolation**: MCP server credentials are only sent to session containers at agent start, not stored on the container filesystem in plaintext beyond the ephemeral config file (deleted after agent exits)
2. **Network access**: Session containers already have outbound network access (for npm, git). SSE MCP servers use this existing access path. No new network policies needed.
3. **Command injection**: The `command` field for stdio servers is passed directly to Claude CLI's MCP config, which spawns it. We validate that `command` doesn't contain shell metacharacters and is a simple executable name or path.
4. **Name collisions**: User MCP server names are validated to not conflict with built-in servers (e.g., `playwright` is reserved). Names must match `/^[a-z][a-z0-9-]*$/`.
5. **Resource limits**: Each MCP server is an additional process in the container. We cap at 5 user MCP servers per session to prevent resource exhaustion.

### Error handling

- **Server fails to start**: Emit a `system_message` event to the chat with the error. Agent continues without that server's tools. Don't block the entire agent start.
- **Server crashes mid-session**: Claude CLI handles MCP server crashes internally (tools return errors). The UI shows a warning indicator on the server.
- **Install fails**: If `npm install -g` fails for an npm package, log the error, skip that server, and notify the user via system message.
- **Test endpoint**: The test endpoint starts the server, calls `tools/list`, and shuts down. Returns the tool list on success or the error on failure. Timeout: 30 seconds.

## Key files

### New files
- `src/server/shared/types/mcp-types.ts` — MCP server config types
- `src/server/orchestrator/mcp-server-store.ts` — SQLite persistence for MCP configs
- `src/server/orchestrator/api-routes-mcp.ts` — HTTP routes for CRUD + test
- `src/server/orchestrator/services/mcp.ts` — Service layer for MCP operations
- `src/client/stores/mcp-store.ts` — Client state store
- `src/client/components/McpServerSettings.tsx` — Settings UI component

### Modified files
- `src/server/shared/types/agent-types.ts` — Add `mcpServers` to `AgentRunParams`
- `src/server/session/session-worker.ts` — Extend `generateMcpConfig()` to merge user servers
- `src/server/session/claude.ts` — Extend tool allowlists with user MCP namespaces
- `src/server/orchestrator/container-session-runner.ts` — Pass MCP servers in agent start params
- `src/server/orchestrator/proxy-agent-process.ts` — Thread MCP config through proxy
- `src/server/orchestrator/api-routes.ts` — Register new MCP routes
- `src/server/orchestrator/app-di.ts` — Initialize McpServerStore
- `src/client/components/Settings.tsx` — Add MCP Servers section

## Future work

- **MCP server sharing across sessions**: Run a single MCP server instance that multiple sessions connect to (via SSE bridge), reducing resource usage
- **MCP server marketplace**: Curated list of popular servers with one-click install
- **Per-repo MCP config**: Allow `shipit.yaml` to declare MCP servers needed for a project, auto-prompted on clone
- **MCP server output in UI**: Surface MCP tool calls and results in the chat activity feed with dedicated formatting
- **Pre-installed popular servers**: Bake commonly used MCP servers into the container base image for instant availability
