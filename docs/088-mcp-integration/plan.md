---
status: planned
---

# 088 — User MCP Server Integration

## Overview

Allow users to connect their own MCP servers (e.g., Linear, Notion, Sentry, Datadog) to the Claude agent running inside session containers. This gives the inner agent access to external tools and data sources beyond the built-in filesystem/browser tools.

## Motivation

Today the inner agent only has access to Playwright MCP (built-in). Users building real applications need the agent to interact with external services — filing Linear issues, querying Sentry errors, reading Notion docs, checking Datadog metrics. MCP is the standard protocol for this, and Claude Code CLI already supports `--mcp-config` for arbitrary servers.

## Relationship to 087 (Reusable Preview Secrets)

[087 — Reusable Preview Secrets](../087-reusable-preview-secrets/plan.md) shipped a complete secrets pipeline: `SecretStore` (per-repo SQLite) for compose-service secrets, `x-shipit-secrets` compose declarations, `secret-resolver.ts` for source merging, `.shipit/.env.<service>` and `.shipit/.env.agent` env-file injection, and `source: platform:*` for forwarding outer-session credentials. This MCP integration design assumes 087 as a baseline and reuses its primitives wherever possible:

| Concern | Mechanism (from 087) | How MCP uses it |
|---|---|---|
| Per-repo service secrets | `SecretStore` (SQLite, keyed by repo URL) | **Not used** — MCP servers are account-level |
| Account-level credentials | `CredentialStore` (JSON on credentials volume) | **Reused** — holds `mcpServers` map and `mcp__*` agent env entries |
| Agent container env injection | `.shipit/.env.agent` on container create, worker `PUT /secrets` for live updates | **Reused** — `mcp__*` keys flow through the same path; MCP server child processes inherit them |
| Compose-service secret declarations | `x-shipit-secrets` in `docker-compose.yml` | **Not used** — MCP server credentials are consumed inside the agent container, never by compose services |
| Platform credential forwarding | `source: platform:claude_oauth`, `source: platform:github_token` | Phase 2 extends this with `source: platform:<provider>_oauth` for native OAuth (see Phase 2) |

The two key boundaries: (a) MCP servers are configured **once per account**, not per repo, so they live in `CredentialStore`, not `SecretStore`; (b) MCP server credentials never need to reach compose services, so they don't appear in `x-shipit-secrets` — they flow only into the agent container.

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

MCP servers authenticate in three ways. Phase 1 covers API keys and pre-obtained tokens. Phase 2 adds native OAuth via the platform-credential pattern from 087.

#### Phase 1: API key / Bearer token (covers ~80% of servers)

Most MCP servers (Linear, Sentry, Datadog) accept an API key via env var or a Bearer token via HTTP header. The user obtains the key from the service's settings page and pastes it into ShipIt.

```
User opens Settings → MCP Servers → "Add Server"
  → fills in name, command/url
  → enters env vars (e.g., LINEAR_API_KEY) or headers (e.g., Authorization: Bearer ...)
  → clicks Save

POST /api/mcp-servers  ──►  CredentialStore (account-level, JSON)
                              │
                              │  Config blob (no secrets, safe to log):
                              │    mcpServers["linear"] = {
                              │      type, command, args, enabled,
                              │      env: { LINEAR_API_KEY: "$secret:mcp__linear__LINEAR_API_KEY" }
                              │    }
                              │
                              │  Secret value (separate field):
                              │    agentEnv["mcp__linear__LINEAR_API_KEY"] = "lin_api_abc123..."
                              ▼
                          (agent env pipeline from 087)
                              │
                              │  Orchestrator merges CredentialStore.agentEnv into
                              │  the resolved agent-env set, writes .shipit/.env.agent,
                              │  and pushes to the running session-worker via
                              │  PUT /secrets (existing endpoint).
                              ▼
                          Session worker process.env now contains
                          mcp__linear__LINEAR_API_KEY=lin_api_abc123…
                              │
                              ▼
On agent start:
  → Orchestrator passes the UNRESOLVED mcpServers list to the worker
    (configs still contain "$secret:..." refs; raw secrets do NOT travel
    in AgentRunParams — they're already in the worker's process.env)
  → session-worker.generateMcpConfig() resolves $secret: refs locally
    by looking the key up in process.env
  → Worker merges built-in (Playwright) + user MCP servers
  → Writes /tmp/mcp-config-{ts}.json with real credentials
  → Spawns Claude CLI with --mcp-config
  → Config file deleted on agent exit
```

Two layers of indirection are in play, and they map cleanly onto 087's primitives:

1. **Storage indirection** — `mcpServers` config blobs hold `$secret:...` placeholders. The blob is safe to log, return from `GET /api/mcp-servers`, and render in the UI. Raw values live separately in `agentEnv` under the `mcp__*` namespace.
2. **Transport indirection** — Raw secret values reach the session container through 087's existing agent-env pipeline (`.shipit/.env.agent` + worker `PUT /secrets`), not via `AgentRunParams`. The orchestrator hands the worker a config that *describes* what env vars to read; the worker resolves them against its own `process.env`. This keeps `AgentRunParams` payloads free of credentials and means secret rotation (worker `PUT /secrets`) automatically affects the next agent turn without restarting anything.

For HTTP servers that use Bearer tokens (like Linear's hosted MCP at `https://mcp.linear.app/mcp`), the same flow applies — the token is stored as a `mcp__*` secret and the `$secret:` placeholder is interpolated into the `headers` field at resolve time inside the worker:

```
Stored config:    { headers: { "Authorization": "Bearer $secret:mcp__linear__TOKEN" } }
Worker resolves:  { headers: { "Authorization": "Bearer lin_oauth_xyz789..." } }
```

#### Phase 2: Native OAuth (future) — via 087's platform-credential pattern

Some hosted MCP servers (Linear, Notion) support OAuth 2.1 with dynamic client registration, allowing a browser-based consent flow instead of manual token pasting. 087 already established `source: platform:claude_oauth` and `source: platform:github_token` as first-class platform credentials resolved from `AuthManager` / `GitHubAuthManager`. MCP OAuth integrations slot into the same pattern as new platform sources.

```
User clicks "Connect with Linear"
  → ShipIt opens OAuth consent screen (popup or redirect)
  → User authorizes ShipIt in Linear
  → Callback: /api/mcp-servers/oauth/callback?code=...&state=...
  → Orchestrator exchanges code for access + refresh tokens
  → Tokens stored in a new McpOAuthManager (or extension of CredentialStore)
  → Refresh logic centralized in platform-credentials.ts

MCP server config references the platform source instead of an agentEnv key:
  mcpServers["linear"] = {
    ...,
    headers: { Authorization: "Bearer $platform:linear_oauth" }
  }

On agent start:
  → Orchestrator checks token expiry, refreshes if needed
  → Refreshed token written into .shipit/.env.agent under a stable key
    (e.g., MCP_PLATFORM_LINEAR_OAUTH) and pushed via worker PUT /secrets
  → Worker resolves $platform: refs the same way it resolves $secret: refs
```

This requires ShipIt to register as an OAuth client with each provider. Start with Linear and Notion (both support OAuth 2.1 + dynamic client registration), then expand based on demand. Reusing 087's platform-credential machinery means the resolver, env-file writer, and worker injection all already work — only the OAuth dance and the new platform sources are new.

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
                          (JSON file, credentials volume — account-level)
                          ┌──────────────────────────────────┐
                          │ mcpServers: { config blobs with  │
                          │              $secret: refs }     │
                          │ agentEnv:   { mcp__* values,     │
                          │              + existing keys }   │
                          └──────────────────────────────────┘
                              │
                              │  Two parallel paths to the container:
                              │
                              ├── (A) Secret values via 087's agent-env pipeline
                              │      ──────────────────────────────────────────
                              │      secret-resolver.ts merges agentEnv (incl.
                              │      mcp__* keys) → .shipit/.env.agent
                              │                    → worker PUT /secrets
                              │      → session-worker process.env
                              │
                              └── (B) Server config (no secrets) via AgentRunParams
                                     ─────────────────────────────────────────────
                                     POST /agent/start with mcpServers: [...]
                                     where configs still contain "$secret:..." refs
                                     │
                                     ▼
                                 session-worker.ts
                                     │
                                     │ generateMcpConfig():
                                     │  1. resolve $secret: refs against process.env
                                     │  2. merge built-in (Playwright) + user servers
                                     │  3. write /tmp/mcp-config-{ts}.json
                                     ▼
                                 Claude CLI process
                                     │  --mcp-config /tmp/mcp-config-{ts}.json
                                     │
                                     ├──► stdio MCP server (spawned as child)
                                     └──► HTTP MCP server (outbound connection)
```

The split between (A) values and (B) config is deliberate: secrets travel through the same audited, reusable channel as every other agent env var (so rotation, revocation, and live-update semantics are uniform), while server *shapes* (commands, URLs, npm packages, allowlists) travel as ordinary, non-sensitive config in `AgentRunParams`. Neither channel ever carries the other's payload.

### Key decisions

**1. Where MCP servers run: inside the session container**

Stdio MCP servers are spawned as child processes of the Claude CLI inside the session container. SSE MCP servers connect outbound from the container. This is the simplest approach — it matches how `claude --mcp-config` works locally and requires no proxy infrastructure.

Trade-offs:
- (+) Zero new infrastructure — Claude CLI handles MCP protocol natively
- (+) Stdio servers get the same sandboxed environment as the agent
- (+) HTTP servers work with any hosted MCP endpoint (no network changes needed)
- (-) Stdio server binaries must be available inside the container (see "Server availability" below)
- (-) Each session spawns its own MCP server instances (no sharing)

**2. Secrets handling: CredentialStore + `$secret:` indirection, transported via 087's agent-env pipeline**

MCP server credentials reuse the existing `CredentialStore` (JSON file on the credentials volume) — *not* the per-repo `SecretStore` introduced in 087. Rationale:

- MCP servers are **account-level** ("I want Claude to access my Linear" is a property of the user, not a property of one repo).
- `SecretStore` is keyed by repo URL and tied to per-service compose declarations (`x-shipit-secrets`); MCP secrets fit neither.
- `CredentialStore.agentEnv` already holds account-level agent env vars (e.g., `OPENAI_API_KEY`) and survives session resets — exactly the lifetime MCP credentials need.

Concretely:

- Secret values are stored in `CredentialStore.agentEnv` with the `mcp__<server>__<KEY>` namespace.
- MCP server config blobs (`CredentialStore.mcpServers[name]`) reference secrets via `$secret:<agentEnv-key>` placeholders instead of embedding raw values, so the blobs are safe to log and return from `GET /api/mcp-servers`.
- Transport into the container reuses 087's existing pipeline: `secret-resolver.ts` already includes `CredentialStore.agentEnv` when assembling the agent env set; `mcp__*` keys get written to `.shipit/.env.agent` and pushed live via the session-worker `PUT /secrets` endpoint, just like any other agent env var.
- Resolution happens **inside the worker**, not the orchestrator: the worker's `generateMcpConfig()` reads `$secret:` placeholders from the configs in `AgentRunParams` and substitutes values from `process.env`. The orchestrator never has to handle decrypted credentials in flight, and rotated secrets take effect on the next agent turn without a container restart.
- The ephemeral MCP config file (`/tmp/mcp-config-{ts}.json`) is the only place real credentials are written to disk inside the container; it is deleted on agent exit.
- The existing `ALLOWED_ENV_KEYS` allowlist (`{ "OPENAI_API_KEY" }`) is replaced with a prefix-aware check: any key matching `mcp__*` is allowed in addition to the existing literal allowlist. This lets users add servers without code changes.

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
  // ... existing fields (githubToken, claudeAuth, etc.) ...
  agentEnv?: Record<string, string>;             // existing — now also holds mcp__* secrets
  mcpServers?: Record<string, McpServerConfig>;  // NEW: server configs keyed by name,
                                                  //      values use $secret: refs
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
// MCP server CRUD (orchestrator-side)
getMcpServer(name: string): McpServerConfig | undefined;
getAllMcpServers(): Record<string, McpServerConfig>;
setMcpServer(name: string, config: McpServerConfig): void;
deleteMcpServer(name: string): void;

// Setting/clearing the secret value associated with a server's $secret: ref
setMcpSecret(key: string, value: string): void;   // writes agentEnv[key] (key must match mcp__*)
deleteMcpSecret(key: string): void;
```

Note: `$secret:` resolution itself does **not** live in `CredentialStore`. It lives in the **worker's** `generateMcpConfig()` — by the time the worker is generating the MCP config file, the relevant `mcp__*` env vars have already been pushed into the worker's `process.env` via 087's agent-env pipeline. The worker simply walks each config's `env` and `headers` map and substitutes `$secret:KEY` → `process.env[KEY]`.

The `ALLOWED_ENV_KEYS` check in `app-di.ts` (currently a hardcoded set `{ "OPENAI_API_KEY" }`) is widened with a prefix rule: keys matching `/^mcp__/` are allowed in addition to the existing literal entries. Same change applies to `secret-resolver.ts` when it picks up `CredentialStore.agentEnv` keys for inclusion in `.shipit/.env.agent` — `mcp__*` keys are always agent-bound (no opt-in `agent: true` required, since unlike compose secrets, every MCP secret is by definition consumed by the agent container).

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

Current flow in `session-worker.ts` generates MCP config with only Playwright. The new flow keeps secrets out of the orchestrator → worker request payload by leveraging 087's agent-env pipeline:

**Orchestrator side (per session activation, via `secret-resolver.ts`):**

1. Existing 087 flow runs: assemble agent env set, write `.shipit/.env.agent`, push to worker via `PUT /secrets`.
2. Updated `secret-resolver.ts` includes all `CredentialStore.agentEnv` entries whose keys match `/^mcp__/` automatically (no compose declaration needed).

**Orchestrator side (per agent turn, via `runClaudeWithMessage`):**

3. Load user MCP servers from `CredentialStore.getAllMcpServers()`.
4. Filter to `enabled: true` servers.
5. Pass the **unresolved** server list (configs still contain `$secret:` placeholders) in `AgentRunParams.mcpServers`. **No secrets in the payload.**

**Worker side (`session-worker.ts` `generateMcpConfig()`):**

6. For each user server, resolve `$secret:KEY` placeholders in `env` / `headers` against `process.env`. If a referenced key is missing, log a warning, drop that server, and emit a `system_message` to the chat — don't block agent start.
7. If any stdio server has `npmPackage` and the package isn't installed yet, run `npm install -g <package>` (idempotent, cached across turns).
8. Merge built-in Playwright + resolved user servers.
9. Write `/tmp/mcp-config-{ts}.json`.
10. Pass to Claude CLI via `--mcp-config`. Delete the file when the agent process exits.

**On secret rotation (user updates a `mcp__*` value via Settings):**

- Orchestrator persists to `CredentialStore.agentEnv`.
- Calls the existing `secret-resolver.ts` refresh path → `.shipit/.env.agent` rewrite + worker `PUT /secrets`.
- The next agent turn picks up the new value transparently — no container restart, no agent restart.

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

1. **Secret isolation**: MCP credentials live in `CredentialStore.agentEnv` on the orchestrator and travel to the container only via 087's existing agent-env pipeline (`.shipit/.env.agent` + worker `PUT /secrets`). Inside the container they live in the worker's `process.env` for the lifetime of the session and in the ephemeral `/tmp/mcp-config-{ts}.json` for the lifetime of a single agent run (deleted on agent exit). They are never written to git-tracked files, never embedded in MCP server config blobs, and never appear in `AgentRunParams` payloads.
2. **Network access**: Session containers already have outbound network access (for npm, git). HTTP MCP servers use this existing access path. No new network policies needed.
3. **Command injection**: The `command` field for stdio servers is passed directly to Claude CLI's MCP config, which spawns it. We validate that `command` doesn't contain shell metacharacters and is a simple executable name or path.
4. **Name collisions**: User MCP server names are validated to not conflict with built-in servers (e.g., `playwright` is reserved). Names must match `/^[a-z][a-z0-9-]*$/`. The `mcp__<name>__*` tool namespace is reserved exclusively for MCP servers, preventing collision with other agent tools.
5. **Resource limits**: Each MCP server is an additional process in the container. We cap at 5 user MCP servers per session to prevent resource exhaustion.
6. **Logging discipline**: Because `mcpServers` blobs only contain `$secret:` placeholders, it's safe for HTTP routes, audit logs, and the UI to render them. The single point where raw values appear in code is the worker's `generateMcpConfig()` substitution step — that function must not log resolved configs.

### Error handling

- **Server fails to start**: Emit a `system_message` event to the chat with the error. Agent continues without that server's tools. Don't block the entire agent start.
- **Server crashes mid-session**: Claude CLI handles MCP server crashes internally (tools return errors). The UI shows a warning indicator on the server.
- **Install fails**: If `npm install -g` fails for an npm package, log the error, skip that server, and notify the user via system message.
- **Test endpoint**: The test endpoint starts the server, calls `tools/list`, and shuts down. Returns the tool list on success or the error on failure. Timeout: 30 seconds.

## Phasing

### Phase 1 — API key / token auth + stdio + HTTP

Covers ~80% of MCP servers. Users paste API keys or pre-obtained tokens. Builds entirely on top of 087's existing agent-env pipeline.

- `CredentialStore` extensions: `mcpServers` map, CRUD methods, `mcp__*` agentEnv keys.
- Prefix-aware allowlist update in `app-di.ts` and `secret-resolver.ts` (so `mcp__*` keys flow into `.shipit/.env.agent` automatically).
- API routes for CRUD + connectivity test (`/api/mcp-servers`).
- `session-worker.ts` `generateMcpConfig()` extension: resolves `$secret:` refs locally, merges user servers with built-in Playwright, runs `npm install -g` for stdio servers with `npmPackage`.
- `claude.ts` tool allowlist additions (`mcp__<server>__*` per enabled server).
- `AgentRunParams.mcpServers` field plumbed through `proxy-agent-process.ts` (configs only, no resolved secret values).
- Settings UI for add / edit / remove / toggle / test.
- Client store (`mcp-store.ts`).

### Phase 2 — Native OAuth (extends 087's platform-credentials)

Browser-based OAuth consent flow for providers that support it. ShipIt acts as an OAuth client. Treat each MCP OAuth provider as a new entry in 087's platform-credentials registry rather than building a parallel system.

- OAuth callback endpoint (`/api/mcp-servers/oauth/callback`).
- Provider registry extends `platform-credentials.ts` with `platform:linear_oauth`, `platform:notion_oauth`, etc.
- Token storage with refresh tokens (initially in `CredentialStore` under a new `mcpOAuth` field; can split into its own store later if it grows).
- Token refresh logic in `platform-credentials.ts` resolver — checks expiry, calls refresh endpoint, returns fresh token at agent start.
- Worker resolves `$platform:<key>` refs the same way it resolves `$secret:` refs. (087 currently routes platform creds through `.shipit/.env.<service>` for compose services; for MCP they need to also reach `.shipit/.env.agent` under stable env-var keys.)
- "Connect with Linear" button in Settings UI that triggers the OAuth flow.
- Provider list seeded with Linear and Notion first (both support OAuth 2.1 + dynamic client registration).
- Fallback: users can still paste tokens manually as Phase 1 Bearer tokens.

### Phase 3 — Advanced features

- MCP server sharing across sessions (single instance, multiple agents connect via SSE bridge)
- Per-repo MCP config in `shipit.yaml` (auto-prompted on clone)
- MCP server marketplace with one-click install
- Pre-installed popular servers in the container base image

## Key files

### New files
- `src/server/shared/types/mcp-types.ts` — MCP server config types (`McpStdioServerConfig`, `McpHttpServerConfig`).
- `src/server/orchestrator/api-routes-mcp.ts` — HTTP routes for CRUD + test.
- `src/server/orchestrator/services/mcp.ts` — Service layer for MCP operations (validation, name conflicts, server count cap).
- `src/client/stores/mcp-store.ts` — Client state store.
- `src/client/components/McpServerSettings.tsx` — Settings UI component.

### Modified files (orchestrator)
- `src/server/orchestrator/credential-store.ts` — Add `mcpServers` map, MCP CRUD methods, `mcp__*` agentEnv setters.
- `src/server/orchestrator/secret-resolver.ts` — Include `mcp__*` keys from `CredentialStore.agentEnv` in the agent env set automatically (no `agent: true` opt-in needed; MCP secrets are always agent-bound).
- `src/server/orchestrator/app-di.ts` — Replace literal `ALLOWED_ENV_KEYS` set with prefix-aware check covering `mcp__*`.
- `src/server/orchestrator/container-session-runner.ts` — Pass unresolved MCP server configs in agent start params.
- `src/server/orchestrator/proxy-agent-process.ts` — Thread `mcpServers` field through the proxy to the worker.
- `src/server/orchestrator/api-routes.ts` — Register new MCP routes.
- `src/server/orchestrator/platform-credentials.ts` — (Phase 2) extend with MCP OAuth providers.

### Modified files (session worker)
- `src/server/session/session-worker.ts` — Extend `generateMcpConfig()`: resolve `$secret:` refs against `process.env`, merge user servers, drive `npm install -g` for `npmPackage` entries.
- `src/server/session/claude.ts` — Extend tool allowlists with `mcp__<server>__*` per enabled user server.

### Modified files (shared / client)
- `src/server/shared/types/agent-types.ts` — Add `mcpServers?: McpServerConfig[]` to `AgentRunParams`.
- `src/server/shared/types/domain-types.ts` — If a `$platform:` source is added in Phase 2, extend the platform-source enum here.
- `src/client/components/Settings.tsx` — Add MCP Servers section between "Instructions" and "Secrets".
