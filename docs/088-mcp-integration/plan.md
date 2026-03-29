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
| `type` | yes | Transport type: `"stdio"` or `"http"` |
| `command` | stdio only | Command to run (e.g., `npx @linear/mcp-server`) |
| `args` | no | Command arguments array |
| `url` | http only | Streamable HTTP endpoint URL (e.g., `https://mcp.linear.app/mcp`) |
| `env` | no | Environment variables the server needs (e.g., `LINEAR_API_KEY`) |
| `headers` | http only | HTTP headers for connection (e.g., auth tokens) |
| `enabled` | no | Boolean, defaults to `true`. Allows disabling without deleting. |

### Concrete example: Linear

Linear supports two MCP integration modes, both covered by this design:

**Option A — Self-hosted stdio server (API key auth)**

User generates a personal API key in Linear (Settings > Account > Security & Access), then configures:

```json
{
  "name": "linear",
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@anthropic-ai/linear-mcp"],
  "env": { "LINEAR_API_KEY": "<pasted token>" },
  "enabled": true
}
```

**Option B — Linear's hosted remote server (OAuth or Bearer token)**

Linear hosts a managed MCP server at `https://mcp.linear.app/mcp` using Streamable HTTP transport with OAuth 2.1:

```json
{
  "name": "linear",
  "type": "http",
  "url": "https://mcp.linear.app/mcp",
  "headers": { "Authorization": "Bearer <token>" },
  "enabled": true
}
```

Most MCP servers (Sentry, Datadog, Notion, etc.) follow one of these two patterns.

### Authentication flow

MCP servers authenticate in three ways. Phase 1 covers API keys and pre-obtained tokens. Phase 2 adds native OAuth.

#### Phase 1: API key / Bearer token (covers ~80% of servers)

Most MCP servers (Linear, Sentry, Datadog) accept an API key via env var or a Bearer token via HTTP header. The user obtains the key from the service's settings page and pastes it into ShipIt.

```
User opens Settings → MCP Servers → "Add Server"
  → fills in name, command/url
  → enters env vars (e.g., LINEAR_API_KEY) or headers (e.g., Authorization: Bearer ...)
  → clicks Save

POST /api/mcp-servers  ──►  CredentialStore
                              │
                              │  config blob (no secrets):
                              │    { env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" } }
                              │
                              │  secret entry:
                              │    agentEnv["mcp__linear__LINEAR_API_KEY"] = "lin_api_abc123..."
                              │
                              │  MCP server definition:
                              │    mcpServers["linear"] = { type, command, args, env refs, enabled }
                              ▼
On agent start:
  → Orchestrator reads mcpServers from CredentialStore
  → Resolves "$secret:..." env/header refs against agentEnv
  → Passes resolved configs in AgentRunParams
  → session-worker writes /tmp/mcp-config-{ts}.json
  → Claude CLI spawns/connects MCP servers with real credentials
  → Config file deleted on agent exit
```

Secret indirection (`$secret:mcp__linear__LINEAR_API_KEY`) keeps credentials out of the config blob. The config is safe to log and display in the UI — the actual token only appears in the ephemeral config file inside the container.

For HTTP servers that use Bearer tokens (like Linear's hosted MCP at `https://mcp.linear.app/mcp`), the same flow applies — the token is stored as a secret and interpolated into the `headers` field at resolve time:

```
Config:   { headers: { "Authorization": "Bearer $secret:mcp__linear__TOKEN" } }
Resolved: { headers: { "Authorization": "Bearer lin_oauth_xyz789..." } }
```

#### Phase 2: Native OAuth (future)

Some hosted MCP servers (Linear, Notion) support OAuth 2.1 with dynamic client registration, allowing a browser-based consent flow instead of manual token pasting.

```
User clicks "Connect with Linear"
  → ShipIt opens OAuth consent screen (popup or redirect)
  → User authorizes ShipIt in Linear
  → Callback: /api/mcp-servers/oauth/callback?code=...&state=...
  → Orchestrator exchanges code for access + refresh tokens
  → Tokens stored in CredentialStore (agentEnv["mcp__linear__TOKEN"])
  → MCP server config uses same $secret: reference as Phase 1

On agent start (same as Phase 1):
  → Orchestrator checks token expiry
  → If expired, refreshes using stored refresh token
  → Resolved token passed to container
```

This requires ShipIt to register as an OAuth client with each provider. Start with Linear and Notion (both support OAuth 2.1 + dynamic client registration), then expand based on demand.

**Phase 1 workaround for OAuth servers**: Users complete OAuth themselves outside ShipIt (e.g., via `claude mcp add` locally or the provider's developer settings), copy the resulting access token, and paste it as a Bearer token. This works today with no extra infrastructure.

### Architecture

```
Browser UI                    Orchestrator                     Session Container
───────────                   ────────────                     ─────────────────

Settings panel  ──HTTP──►  /api/mcp-servers (CRUD)
                              │
                              │ persist to
                              ▼
                          CredentialStore
                          (JSON file, credentials volume)
                          ┌─────────────────────────┐
                          │ mcpServers: { configs }  │
                          │ agentEnv: { secrets }    │
                          └─────────────────────────┘
                              │
                              │ on agent start,
                              │ resolve $secret: refs
                              ▼
                      AgentRunParams.mcpServers
                      (configs with real credentials)
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
                              ├──► stdio MCP server (spawned as child process)
                              └──► HTTP MCP server (outbound connection)
```

### Key decisions

**1. Where MCP servers run: inside the session container**

Stdio MCP servers are spawned as child processes of the Claude CLI inside the session container. SSE MCP servers connect outbound from the container. This is the simplest approach — it matches how `claude --mcp-config` works locally and requires no proxy infrastructure.

Trade-offs:
- (+) Zero new infrastructure — Claude CLI handles MCP protocol natively
- (+) Stdio servers get the same sandboxed environment as the agent
- (+) HTTP servers work with any hosted MCP endpoint (no network changes needed)
- (-) Stdio server binaries must be available inside the container (see "Server availability" below)
- (-) Each session spawns its own MCP server instances (no sharing)

**2. Secrets handling: CredentialStore with `$secret:` indirection**

MCP server credentials reuse the existing `CredentialStore` (JSON file on the credentials volume). Secret values are stored in the `agentEnv` map with a `mcp__` prefix to namespace them. MCP server config blobs reference secrets via `$secret:<key>` placeholders instead of embedding raw values.

This means:
- Server definitions are safe to log/display (no embedded secrets)
- No new storage mechanism — reuses `CredentialStore.agentEnv` with `mcp__`-prefixed keys
- At agent start, the orchestrator resolves `$secret:` references against `agentEnv`
- Resolved credentials are written to the ephemeral MCP config file only, deleted on agent exit
- The existing `ALLOWED_ENV_KEYS` allowlist is replaced with a prefix-based system: `mcp__*` keys are MCP secrets, existing keys (`OPENAI_API_KEY`) keep working

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

#### CredentialStore extensions

MCP data lives in the existing `CredentialStore` JSON file (`/credentials/shipit-credentials.json`). Two additions to `CredentialData`:

```typescript
interface CredentialData {
  // ... existing fields ...
  agentEnv?: Record<string, string>;          // now also holds mcp__* secrets
  mcpServers?: Record<string, McpServerConfig>;  // NEW: server configs keyed by name
}
```

Example persisted state:

```json
{
  "agentEnv": {
    "OPENAI_API_KEY": "sk-...",
    "mcp__linear__LINEAR_API_KEY": "lin_api_abc123",
    "mcp__sentry__SENTRY_AUTH_TOKEN": "sntrys_..."
  },
  "mcpServers": {
    "linear": {
      "name": "linear",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic-ai/linear-mcp"],
      "env": { "LINEAR_API_KEY": "$secret:mcp__linear__LINEAR_API_KEY" },
      "enabled": true
    },
    "sentry": {
      "name": "sentry",
      "type": "http",
      "url": "https://mcp.sentry.dev/mcp",
      "headers": { "Authorization": "Bearer $secret:mcp__sentry__SENTRY_AUTH_TOKEN" },
      "enabled": true
    }
  }
}
```

New `CredentialStore` methods:

```typescript
// MCP server CRUD
getMcpServer(name: string): McpServerConfig | undefined;
getAllMcpServers(): Record<string, McpServerConfig>;
setMcpServer(name: string, config: McpServerConfig): void;
deleteMcpServer(name: string): void;

// Secret resolution (used at agent start)
resolveMcpSecrets(config: McpServerConfig): McpServerConfig;  // replaces $secret: refs with real values
```

The `ALLOWED_ENV_KEYS` check in `app-di.ts` is updated to also allow keys prefixed with `mcp__` when loading env vars into `process.env`.

#### McpServerConfig type

```typescript
// src/server/shared/types/mcp-types.ts

interface McpStdioServerConfig {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;       // env var names → $secret: references or literal values
  npmPackage?: string;                 // package to npm install -g (e.g., "@anthropic-ai/linear-mcp")
  setup?: string;                      // optional setup command
  enabled: boolean;
}

interface McpHttpServerConfig {
  name: string;
  type: "http";
  url: string;                         // Streamable HTTP endpoint
  headers?: Record<string, string>;    // may contain $secret: references
  env?: Record<string, string>;
  enabled: boolean;
}

type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
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

1. Orchestrator loads user MCP servers from `CredentialStore.getAllMcpServers()`
2. Filters to `enabled: true` servers
3. Calls `resolveMcpSecrets()` for each — replaces `$secret:mcp__linear__LINEAR_API_KEY` with the real value from `agentEnv`
4. Passes the resolved server list in `AgentRunParams` (new field: `mcpServers: McpServerConfig[]`)
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

## Phasing

### Phase 1 — API key / token auth + stdio + HTTP

Covers ~80% of MCP servers. Users paste API keys or pre-obtained tokens.

- CredentialStore extensions (mcpServers map, mcp__* agentEnv keys, $secret: resolution)
- API routes for CRUD + test
- session-worker merges user servers into MCP config
- claude.ts tool allowlist additions
- Settings UI for add/edit/remove/toggle/test
- Client store

### Phase 2 — Native OAuth

Browser-based OAuth consent flow for providers that support it. ShipIt acts as an OAuth client.

- OAuth callback endpoint (`/api/mcp-servers/oauth/callback`)
- Token refresh logic in CredentialStore (store refresh_token, check expiry at agent start)
- Provider registry: Linear and Notion first (both support OAuth 2.1 + dynamic client registration)
- "Connect with Linear" button in Settings UI that triggers the OAuth flow
- Fallback: users can still paste tokens manually

### Phase 3 — Advanced features

- MCP server sharing across sessions (single instance, multiple agents connect via SSE bridge)
- Per-repo MCP config in `shipit.yaml` (auto-prompted on clone)
- MCP server marketplace with one-click install
- Pre-installed popular servers in the container base image

## Key files

### New files
- `src/server/shared/types/mcp-types.ts` — MCP server config types
- `src/server/orchestrator/api-routes-mcp.ts` — HTTP routes for CRUD + test
- `src/server/orchestrator/services/mcp.ts` — Service layer for MCP operations
- `src/client/stores/mcp-store.ts` — Client state store
- `src/client/components/McpServerSettings.tsx` — Settings UI component

### Modified files
- `src/server/orchestrator/credential-store.ts` — Add mcpServers map, mcp__* env keys, $secret: resolution
- `src/server/shared/types/agent-types.ts` — Add `mcpServers` to `AgentRunParams`
- `src/server/shared/agent-registry.ts` — Replace `ALLOWED_ENV_KEYS` set with prefix-based check
- `src/server/session/session-worker.ts` — Extend `generateMcpConfig()` to merge user servers
- `src/server/session/claude.ts` — Extend tool allowlists with user MCP namespaces
- `src/server/orchestrator/container-session-runner.ts` — Pass MCP servers in agent start params
- `src/server/orchestrator/proxy-agent-process.ts` — Thread MCP config through proxy
- `src/server/orchestrator/api-routes.ts` — Register new MCP routes
- `src/server/orchestrator/app-di.ts` — Update ALLOWED_ENV_KEYS logic for mcp__* prefix
- `src/client/components/Settings.tsx` — Add MCP Servers section
