---
status: in-progress
---

# 088 — User MCP Server Integration

> **Implementation note (Phase 1 landed).** The server name regex was tightened
> from `/^[a-z][a-z0-9-]*$/` to `/^[a-z][a-z0-9]*$/` — hyphens are disallowed
> because the name becomes part of the `mcp__<name>__<KEY>` env-var identifier
> and env var names can't contain hyphens. The `collectMcpAgentEnv()` merge is
> wired through `ServiceManager` via a new `mcpAgentEnvLoader` option (closure
> over `CredentialStore`). The connectivity-test endpoint proxies to a minimal
> MCP JSON-RPC client in `src/server/session/mcp-test.ts`.
>
> **Compose-less sessions (follow-up landed).** The `ServiceManager`-piggybacked
> push only reaches sessions that *have* a `ServiceManager` (i.e. a compose
> config). Compose-less sessions are now covered by a per-turn awaited push in
> `ws-handlers/agent-execution.ts`: when the resolved runner is a
> `ContainerSessionRunner` with no `ServiceManager`, the orchestrator `await`s
> `runner.tryPushAgentSecrets(credentialStore.getAllAgentEnv())` before
> `/agent/start`. This also closes the per-turn secrets-before-agent-start race
> for those sessions. Compose sessions deliberately keep the `syncSecrets()`
> path (the per-turn push is guarded on `!serviceManager` so it can't clobber
> their merged compose+MCP set, since the worker REPLACES its tracked set on
> every `PUT /secrets`).

## Overview

Allow users to connect their own MCP servers (e.g., Linear, Notion, Sentry, Datadog) to the Claude agent running inside session containers. This gives the inner agent access to external tools and data sources beyond the built-in filesystem/browser tools.

## Motivation

Today the inner agent only has access to Playwright MCP (built-in). Users building real applications need the agent to interact with external services — filing Linear issues, querying Sentry errors, reading Notion docs, checking Datadog metrics. MCP is the standard protocol for this, and Claude Code CLI already supports `--mcp-config` for arbitrary servers.

## Relationship to 087 (Reusable Preview Secrets)

[087 — Reusable Preview Secrets](../087-reusable-preview-secrets/plan.md) shipped a secrets pipeline for **per-repo, compose-service** secrets: `SecretStore` (SQLite keyed by repo URL), `x-shipit-secrets` compose declarations, `secret-resolver.ts` for declaration → env-file resolution, `.shipit/.env.<service>` and `.shipit/.env.agent` env-file injection, and `source: platform:*` for forwarding outer-session credentials. This MCP design layers on top of 087's transport substrate (env-file delivery + worker `PUT /secrets`) but does **not** plug into 087's resolver, since MCP secrets aren't declared in compose and aren't repo-scoped.

| Concern | 087 mechanism | MCP relationship |
|---|---|---|
| Per-repo service secrets | `SecretStore` (SQLite, keyed by repo URL) | **Not used** — MCP servers are account-level |
| Account-level credentials | `CredentialStore` (JSON on credentials volume) | **Reused** — extended with `mcpServers` map and `mcp__*` entries in `agentEnv` |
| Compose-driven secret declaration | `x-shipit-secrets` in `docker-compose.yml`, parsed by `secret-resolver.ts` | **Not used** — MCP secrets are not declared in compose |
| Compose-driven resolver | `resolveSecrets()` in `secret-resolver.ts` (consumes only `userSecrets` + `platformCredentials` today) | **New parallel wiring** — MCP introduces an account-level pusher that does **not** route through `resolveSecrets`. See "Agent env transport" below. |
| Agent env-file delivery | `.shipit/.env.agent` written by the orchestrator, mounted on container create | **Reused** for the static portion; MCP secrets are appended/merged at write time |
| Live agent env updates | Session-worker `PUT /secrets` endpoint (called via `tryPushAgentSecrets`) | **Reused** — MCP secret rotations push the same way |
| Platform credential forwarding | `source: platform:claude_oauth`, `source: platform:github_token` | Phase 2 extends this registry with one entry per OAuth-capable provider; see Phase 2 for limitations |

### Agent env transport: what's new vs. what's reused

087's `resolveSecrets()` is purpose-built for compose declarations and intentionally does not touch `CredentialStore.agentEnv` — it is keyed off `composeSecrets` and reads `userSecrets` from `SecretStore`. Wiring `mcp__*` keys through that function would conflate two different scopes (per-repo declared secrets vs. account-level agent env). Instead, this design adds a small new orchestrator-side step that runs alongside the existing `syncSecrets()` flow:

1. `resolveSecrets()` runs unchanged and produces `agentValues` from compose declarations.
2. **NEW** — `collectMcpAgentEnv()` reads `CredentialStore.getAllAgentEnv()`, filters to keys matching `/^mcp__/`, and merges them into the same `agentValues` map (with compose entries winning on key collision, since those are explicit per-repo overrides).
3. The combined map is written to `.shipit/.env.agent` and pushed via `tryPushAgentSecrets()` — both already exist; only the input changes.

This means the lifecycle remains: (a) on session activation, the merged file is written before the agent container is created; (b) on user MCP secret changes, the orchestrator calls the same refresh path that compose secret saves use today.

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
| `env` | stdio only | Environment variables the spawned server process receives (e.g., `LINEAR_API_KEY`). Not applicable to HTTP servers, which use `headers` instead. |
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

For HTTP servers that use Bearer tokens (like Linear's hosted MCP at `https://mcp.linear.app/mcp`), the same flow applies — the token is stored as a `mcp__*` secret and the `$secret:` placeholder is interpolated into the `headers` field at resolve time inside the worker. **The placeholder is substring-substituted, not whole-value-replaced**, so users can write the literal `Bearer ` prefix in the config and have only the token portion replaced:

```
Stored config:    { headers: { "Authorization": "Bearer $secret:mcp__linear__TOKEN" } }
Worker resolves:  { headers: { "Authorization": "Bearer lin_oauth_xyz789..." } }
```

**Substitution rule:** the worker walks each string in `env` / `headers` / `args` and applies the regex `/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g`. Each match is replaced with `process.env[capturedGroup]`. If the env var is absent, the entire server is dropped from this turn's config and a `mcp_server_status` event with `reason: "missing secret: <KEY>"` is emitted (see "Error handling"). Phase 2's `$platform:<source>` placeholder uses the same substring-substitution mechanism with a parallel regex and the source-to-env-var mapping documented in Phase 2.

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
                              ├── (A) Secret values via the agent-env transport
                              │      ──────────────────────────────────────────
                              │      secret-resolver.ts builds compose-declared
                              │      agentValues, then NEW collectMcpAgentEnv()
                              │      merges mcp__* keys from CredentialStore
                              │      → .shipit/.env.agent
                              │      → worker PUT /secrets (awaited at session
                              │        activation, before agent is signaled ready)
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
- Transport into the container reuses 087's *delivery* substrate (`.shipit/.env.agent` + worker `PUT /secrets`) but adds a new orchestrator step (`collectMcpAgentEnv()`) that merges `mcp__*` keys from `CredentialStore.agentEnv` into the `agentValues` map *after* `resolveSecrets()` runs. `resolveSecrets()` itself stays focused on per-repo compose declarations and does not learn about MCP — see "Agent env transport" in the relationship-to-087 section.
- Resolution happens **inside the worker**, not the orchestrator: the worker's `generateMcpConfig()` reads `$secret:` placeholders from the configs in `AgentRunParams` and substitutes values from `process.env`. The orchestrator never has to handle decrypted credentials in flight, and rotated secrets take effect on the next agent turn without a container restart.
- The ephemeral MCP config file (`/tmp/mcp-config-{ts}.json`) is the only place real credentials are written to disk inside the container; it is deleted on agent exit.
- The existing `ALLOWED_ENV_KEYS` allowlist (`{ "OPENAI_API_KEY" }`, declared in `src/server/shared/agent-registry.ts`) is replaced with a prefix-aware predicate: any key matching `/^mcp__/` is allowed in addition to the existing literal allowlist. This lets users add servers without code changes. Two consumers of this predicate need updating: (a) `app-di.ts`, which uses it to decide which persisted `CredentialStore.agentEnv` keys to load into the orchestrator's `process.env` at startup; (b) `services/settings.ts`, which validates `set_agent_env` writes from the client.

**3. Tool allowlisting: user controls which MCP tools the agent can call**

The `--allowedTools` flag already supports glob patterns (`mcp__linear__*`), so we add each enabled server's namespace to the allowlist per permission mode. Because there's no reliable way to classify a third-party MCP tool as read vs. write without server metadata, the modes treat the entire namespace uniformly:

- `auto` mode — all tools from enabled user MCP servers are allowed (`mcp__<name>__*` added to `autoTools`).
- `normal` mode — all tools from enabled user MCP servers are allowed, but the existing `normal`-mode prompt convention requires the agent to confirm side-effecting actions with the user via `AskUserQuestion`. We rely on the system prompt rather than per-tool gating.
- `plan` mode — all tools from enabled user MCP servers are excluded. `plan` mode is intentionally read-only at the system level, and we cannot guarantee any third-party MCP tool is read-only.

Future refinement: if Anthropic's MCP protocol adds a standard read/write annotation, we can opt MCP tools into `plan` mode based on that metadata. Until then, "blocked in `plan`, allowed elsewhere" is the conservative default.

**4. Server availability in containers: npm-based install at session activation**

Stdio MCP servers are typically distributed as npm packages (e.g., `@linear/mcp-server`). Rather than baking every possible MCP server into the container image, we install them at session activation:

- The install runs **once at session activation**, between container start and agent ready, alongside the existing `agent.install` step from `shipit.yaml`. It does **not** run lazily on the first agent turn — that would mean turn 1 blocks on `N` sequential network installs with no progress feedback in chat.
- Triggered orchestrator-side via the existing session-worker `POST /install` endpoint (or a new sibling endpoint) with the npm package names. The worker process runs as root in the agent container image and `npm install -g` works without privilege elevation; this assumption is documented here so future image changes don't silently break it.
- Packages from multiple servers are installed in parallel (`npm install -g pkg1 pkg2 ...` accepts multiple in one invocation) — single network round-trip, single npm cache warm-up.
- The worker holds a per-package mutex so concurrent install requests for the same package coalesce into one install (defense in depth — the orchestrator already serializes activation, but this protects against test endpoints and Phase 3 features that may install on demand).
- Installs are recorded in `/tmp/mcp-installed.json` so worker restarts within the same container don't reinstall. Cross-container caching (idle disposal + reconnect) is **not** part of Phase 1 — a fresh container reinstalls everything.
- On install failure: log the error, skip that server, surface as a structured "MCP server failed to load" entry to the McpStore (UI shows red badge with the npm error), and continue with other servers and the agent.

For non-npm servers (binary, Python, etc.), users can specify a `setup` command that runs before the server starts. The `setup` command runs in the agent container's working directory with the same privileges and at the same lifecycle point as the npm install.

A future optimization (Phase 3) pre-installs popular servers in the base image to skip the activation-time install for the common case.

### Data model

#### CredentialStore extensions

MCP data lives in the existing `CredentialStore` JSON file (`/credentials/shipit-credentials.json`). Two additions to `CredentialData`:

```typescript
interface CredentialData {
  // existing fields (see src/server/orchestrator/credential-store.ts):
  agentEnv?: Record<string, string>;             // existing — now also holds mcp__* secrets
  githubToken?: string;
  maxIdleContainers?: number;
  agentSystemInstructionsEnabled?: boolean;
  autoCreatePr?: boolean;

  // NEW for this feature:
  mcpServers?: Record<string, McpServerConfig>;  // server configs keyed by name,
                                                  // values use $secret: refs
}
```

(Claude OAuth state is owned by `AuthManager` and persisted at `/root/.claude` — not in `CredentialStore` — so there's no `claudeAuth` field to coexist with.)

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

The `ALLOWED_ENV_KEYS` set lives in `src/server/shared/agent-registry.ts` (line 62, currently `new Set(["OPENAI_API_KEY"])`). The change is to replace the set membership test in its consumers with a predicate (`isAllowedAgentEnvKey(key)`) that returns true for any literal allowlist entry **or** any key matching `/^mcp__/`. The two consumers that need updating: `app-di.ts` (loads persisted `CredentialStore.agentEnv` into `process.env` at startup) and `services/settings.ts` (validates `set_agent_env` writes from the client). The new `collectMcpAgentEnv()` step described above is a separate, orchestrator-only callsite — it doesn't share the predicate, since by construction it only reads `mcp__*` keys.

A second validation gate exists worker-side: the `PUT /secrets` handler in `session-worker.ts` validates env-var names against `/^[A-Za-z_][A-Za-z0-9_]*$/`, which already accepts `mcp__<server>__<KEY>` (double underscores are valid). No worker-side change is required for the names themselves; only the orchestrator-side allowlist widens.

`mcp__*` keys are always agent-bound (no opt-in `agent: true` required, since unlike compose-declared secrets, every MCP secret is by definition consumed by the agent container).

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
  enabled: boolean;
}

type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;
```

`env` is intentionally absent from `McpHttpServerConfig` — HTTP MCP servers are reached via outbound network requests, not as child processes, so there's no environment to inject. Auth on HTTP servers travels via `headers` only.

#### Map-vs-array convention

Storage is a map: `CredentialData.mcpServers` is `Record<string, McpServerConfig>` keyed by `name`. Transport (HTTP responses, `AgentRunParams`, the client store) is an array of values: `McpServerConfig[]`. The conversion is `Object.values(record)` — service-layer code does this once and the wire format is always an array. The invariant is that `record[name].name === name` (the service layer enforces this on write); duplicating `name` inside the value is what makes the array form self-describing.

### API endpoints

All endpoints under `/api/mcp-servers`. Following the service layer pattern (routes → services → store).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/mcp-servers` | List all configured MCP servers |
| `POST` | `/api/mcp-servers` | Add a new MCP server |
| `PUT` | `/api/mcp-servers/:id` | Update an MCP server config |
| `DELETE` | `/api/mcp-servers/:id` | Remove an MCP server |
| `POST` | `/api/mcp-servers/:id/test` | Test connectivity (delegates to the active session container — see below) |

**Response shapes:**
- `GET /api/mcp-servers` → `{ servers: McpServerConfig[] }` — the unresolved blobs, with `$secret:` placeholders intact. Safe to return because raw values live in `agentEnv`, not in the blobs.
- `POST` / `PUT` → 200 with the saved blob, same shape; the secret value (if provided in the request body separately) is stored in `agentEnv` and never echoed back.
- The route MUST NOT return values from `agentEnv` under any code path. Reading `mcp__*` values is intentionally not exposed via HTTP.

**Test endpoint isolation:**

The test endpoint must not run user-supplied stdio binaries inside the orchestrator process — the orchestrator does not exec user-provided commands as a trust boundary. Instead, the test endpoint:

1. Requires an active session container for the user (returns 409 if there isn't one, with a UI hint to start a session first).
2. Proxies the test to a new session-worker endpoint (`POST /mcp/test`) inside that container. The worker spawns the configured stdio server (or opens an HTTP connection), calls `tools/list` over MCP, captures the result, and tears the connection down.
3. Returns `{ ok: true, tools: McpTool[] }` on success or `{ ok: false, error: string }` on failure. Timeout: 30 seconds.

If a Phase-3 "test without active session" flow is needed (e.g., for the marketplace), it would be implemented by spawning a short-lived dedicated tester container — still never inside the orchestrator process.

### Agent start flow (modified)

Current flow in `session-worker.ts` generates MCP config with only Playwright. The new flow keeps secrets out of the orchestrator → worker request payload by leveraging 087's agent-env pipeline:

**Orchestrator side (per session activation, inside `ServiceManager.syncSecrets()`):**

1. Existing 087 flow runs: `resolveSecrets()` consumes compose declarations + `SecretStore` + `platformCredentials` and produces the per-service env files plus the compose-declared `agentValues` map. `resolveSecrets()` is unchanged.
2. **NEW** — `collectMcpAgentEnv(credentialStore)` returns a `Record<string, string>` of all `CredentialStore.agentEnv` entries with keys matching `/^mcp__/`. `ServiceManager.syncSecrets()` merges this map into `agentValues` *before* writing `.shipit/.env.agent` and emitting `secrets_status` (compose-declared entries win on key collision since those are explicit per-repo overrides).
3. Existing 087 flow continues: write `.shipit/.env.agent`, push to worker via `tryPushAgentSecrets()` → `PUT /secrets`. The push is awaited at session activation before the agent is signaled ready (see "Sequencing" below).

**Orchestrator side (per agent turn, via `runClaudeWithMessage`):**

4. Load user MCP servers from `CredentialStore.getAllMcpServers()`.
5. Filter to `enabled: true` servers.
6. Pass the **unresolved** server list (configs still contain `$secret:` placeholders) in `AgentRunParams.mcpServers`. **No secrets in the payload.**

**Worker side (`session-worker.ts` `generateMcpConfig()`):**

7. For each user server, resolve `$secret:KEY` placeholders in `env` / `headers` against `process.env`. If a referenced key is missing, log a warning, drop that server, emit a structured `mcp_server_status` event over SSE, and emit a `system_message` to the chat (deduplicated per-session-per-server) — don't block agent start.
8. Merge built-in Playwright + resolved user servers.
9. Write `/tmp/mcp-config-{ts}.json`.
10. Pass to Claude CLI via `--mcp-config`. Delete the file when the agent process exits.

(Note: npm install for stdio servers happens at session activation, not here. See "Server availability in containers" key decision.)

**Sequencing: secrets must arrive before the agent starts**

There is a real race between path (A) — pushing `mcp__*` keys via `PUT /secrets` — and path (B) — starting the agent via `POST /agent/start`. Today, `tryPushAgentSecrets()` is fire-and-forget (`void this.tryPushAgentSecrets(...)` in `container-session-runner.ts`) which is fine for compose secrets that don't gate any single agent turn. For MCP, if (B) lands before (A) completes, the worker calls `generateMcpConfig()` against a `process.env` missing the relevant `mcp__*` keys and silently drops every user server.

Phase 1 closes the race in two ways:

1. **At session activation:** the orchestrator awaits the `PUT /secrets` push to complete before signaling the worker that the agent is ready to take messages. This is the simple fix and covers the common case (cold start).
2. **At per-turn agent start:** `_startAgentViaProxy` includes the *current* `mcpServers` list in `AgentRunParams`, but the worker also re-reads `process.env` at every `generateMcpConfig()` call. If the user adds a new server mid-session, the orchestrator pushes the secret (awaited), then the next user message kicks off a turn that picks up both the new config and the new secret atomically.

The lifecycle of "MCP server added → secret pushed → agent ready to use it" is therefore: ack the `POST /api/mcp-servers` only after both the CredentialStore write **and** the `PUT /secrets` round-trip succeed. The UI can rely on the response to know the agent will see the new tools on the very next turn.

**On secret rotation (user updates a `mcp__*` value via Settings):**

- Orchestrator persists to `CredentialStore.agentEnv`.
- Calls the agent-env refresh path (compose `syncSecrets` + new `collectMcpAgentEnv` step) → `.shipit/.env.agent` rewrite + worker `PUT /secrets`.
- The next agent turn picks up the new value transparently — no container restart, no agent restart.

### Server lifecycle and credential clearing

Five lifecycle events affect MCP state. Each must be explicit so secrets don't linger on disk or in worker memory:

| Event | Effect on `mcpServers` blob | Effect on `mcp__<name>__*` agentEnv | Effect on running session worker(s) |
|---|---|---|---|
| User edits server config (rename / disable) | Updated in place | Untouched (unless renamed; see below) | Next agent turn picks up new shape |
| User updates a secret value | Untouched | New value written | `PUT /secrets` push removes/updates the value in worker `process.env` |
| User deletes a server | Removed from map | All `mcp__<name>__*` entries removed | `PUT /secrets` push **with the deleted keys included as empty string** so the worker clears them from `process.env` (matches existing 087 behavior for removed keys) |
| User signs out of Claude (clears `AuthManager`) | Untouched (account-level state survives, mirroring how `githubToken` survives Claude sign-out today) | Untouched | No change |
| User runs full reset / clears `CredentialStore` | All entries cleared | All `mcp__*` entries cleared | `PUT /secrets` push with all `mcp__*` keys set to empty so worker drops them |

Renaming a server is treated as delete-then-add: the old `mcp__<old>__*` keys are cleared (and pushed) before the new `mcp__<new>__*` keys are written. The UI surfaces a confirm prompt warning that the secret values must be re-entered after rename.

Deleting a server while it's actively spawned by the Claude CLI is safe because the deletion only affects the next agent turn — the current turn's `/tmp/mcp-config-*.json` is already on disk and the running stdio child or HTTP connection is unaffected. The cleared `process.env` entries take effect on the *next* `generateMcpConfig()` call.

### Tool allowlist changes

In `claude.ts`, the tool allowlist construction adds user MCP server namespaces per mode (matching the policy in §"Key decisions" #3):

```typescript
// auto + normal: include each enabled user MCP server's namespace
for (const server of userMcpServers) {
  if (!server.enabled) continue;
  autoTools.push(`mcp__${server.name}__*`);
  normalTools.push(`mcp__${server.name}__*`);
  // plan mode: deliberately omitted — third-party MCP tools cannot be assumed read-only
}
```

The `normal`-mode system prompt continues to require the agent to confirm side-effecting actions via `AskUserQuestion` before calling them; user MCP tools inherit that convention via the prompt, not via per-tool gating.

### Client UI

#### Settings panel addition

New section in Settings: **"MCP Servers"** (between "Instructions" and "Secrets").

- List of configured servers with name, type, status (enabled/disabled, plus per-server load state from the `mcp_server_status` event channel), and actions (edit/delete/toggle).
- Per-server status states from the worker:
  - `loaded` (green) — server connected, tools discovered.
  - `failed` (red) — install failed, missing secret, or startup error. Hover/expand for the reason; "Retry" action.
  - `crashed` (yellow) — server died mid-session.
  - `disabled` (gray) — explicitly disabled by the user.
- "Add MCP Server" button opens a form:
  - Name field (validated: lowercase alphanumeric + hyphens, unique).
  - Type selector (stdio / http).
  - Conditional fields based on type (`command` + `args` for stdio, `url` for http).
  - Environment variables section (stdio only — HTTP servers don't accept env). Key-value pairs, values masked. Each value is stored as a `mcp__<server>__<key>` secret and the form-rendered config substitutes `$secret:` automatically.
  - Headers section (http only — same UX as env vars but for `headers`).
  - npm package field (stdio only, optional).
  - Test button — calls `POST /api/mcp-servers/:id/test`; requires an active session container.

The session sidebar does NOT render per-MCP-server health in Phase 1 — that requires aggregating `mcp_server_status` events from the active runner and isn't worth the wiring before users have asked for it. The Settings panel is the single source of truth for server health. Phase 3 may add a sidebar pill if user feedback demands it.

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
5. **Resource limits**: Each enabled stdio MCP server is an additional child process inside the agent container at agent-run time. The account-level cap on **enabled** servers is 10 (a soft ceiling — past this, the install step latency and the per-turn config-generation cost become noticeable on cold containers). The cap is enforced in the service layer (`services/mcp.ts` validates on `POST` / `PUT` and on `enable`). Disabled servers don't count against the cap.
6. **Logging discipline**: Because `mcpServers` blobs only contain `$secret:` placeholders, it's safe for HTTP routes, audit logs, and the UI to render them. The single point where raw values appear in code is the worker's `generateMcpConfig()` substitution step — that function must not log resolved configs.

### Error handling

Per-server failures are surfaced through a structured channel so the McpStore (and the Settings UI) can render persistent state — not just one-shot chat messages that scroll away.

- **Server fails to start**: Worker emits a `mcp_server_status` event over SSE with `{ name, state: "failed", reason: "..." }`. The McpStore stores this; the Settings row for the affected server shows a red error badge with the reason on hover. The agent continues without that server's tools. A `system_message` is also posted to chat once per session per server (deduplicated, so retries don't spam) so the user knows why a tool they expected is missing.
- **Missing-secret resolution**: If a `$secret:KEY` placeholder references a key not in `process.env`, the worker treats it as a "failed to load" event with reason `"missing secret: KEY"`. The server is dropped from this turn's MCP config. The Settings row for the server shows the missing-secret state until the user provides the secret. Critically, the agent should **not** silently lose tools — the system_message tells the user "Linear MCP not loaded — set LINEAR_API_KEY in Settings".
- **Real connection state from the CLI**: Two distinct emission paths feed `mcp_server_status`, in this order. (a) `generateMcpConfig()` emits `failed` for any server with a missing-secret placeholder, *before* the CLI is even spawned — this is a definitive "we won't try to connect" signal. (b) When the Claude CLI emits its init event with an `mcp_servers[]` field, `ClaudeAdapter` translates each entry via `mapCliMcpStatus()` and emits an `mcp_status` event on the `AgentProcess` channel; the worker rebroadcasts each entry as `mcp_server_status` SSE. Mapping: `connected→loaded`, `needs-auth→failed("authentication required")`, `failed→failed("connection failed")`. The McpStore's `applyStatus()` is last-write-wins, so if the secret resolves but the connection fails (network down, bad API key) the user sees the real `failed` from path (b) — not a stale `loaded`.
- **Server crashes mid-session**: Claude CLI handles MCP server crashes internally (tool calls return errors). The worker observes via the same channel and updates the McpStore state to `"crashed"`. The UI shows a warning indicator and a "Restart" button (Phase 1: restart = next agent turn re-spawns; Phase 3: live restart).
- **Install fails**: `npm install -g` failure routes through the same `mcp_server_status` channel with reason `"install failed: <stderr tail>"`. The Settings row shows the error and a "Retry install" action.
- **Test endpoint**: see "Test endpoint isolation" above. Returns the tool list on success or the error on failure. Timeout: 30 seconds.

## Phasing

### Phase 1 — API key / token auth + stdio + HTTP

Covers ~80% of MCP servers. Users paste API keys or pre-obtained tokens. Builds entirely on top of 087's existing agent-env pipeline.

**Migration:** No schema migration required. `CredentialData.mcpServers` defaults to `{}` for existing credential files; `agentEnv` already exists. Sessions running an older worker simply ignore `mcp__*` env vars (the worker accepts them via `PUT /secrets` since the regex already matches, and unused env vars are harmless). Sessions running a newer worker against an older orchestrator see no `mcpServers` in `AgentRunParams` and behave exactly as today.

- [x] `CredentialStore` extensions: `mcpServers` map, CRUD methods, `mcp__*` agentEnv setters (`setMcpSecret` / `deleteMcpSecret` / `deleteMcpSecretsForServer`), `clear()` covers both (it already wipes `this.data`).
- [x] Added an exported `isAllowedAgentEnvKey()` predicate to `agent-registry.ts` (literal allowlist + `mcp__*`); `ALLOWED_ENV_KEYS` kept for tests/re-exports; consumers in `app-di.ts` and `services/settings.ts` switched to the predicate.
- [x] New `collectMcpAgentEnv()` helper in `secret-resolver.ts`; wired into `ServiceManager.syncSecrets()` via a new `mcpAgentEnvLoader` option, merged into `agentValues` (compose-wins) before `.shipit/.env.agent` write + worker push. `renderAgentEnvBody()` added to render the merged map.
- [x] API routes for CRUD + connectivity test (`api-routes-mcp.ts`, registered in `api-routes.ts`), backed by `services/mcp.ts` (validation, name conflicts, enabled-server cap).
- [x] `session-worker.ts` `generateMcpConfig()` extension: resolves `$secret:` substring placeholders locally, merges user servers with built-in Playwright, emits `mcp_server_status` SSE events.
- [x] New `POST /mcp/install` (per-package mutex, `/tmp/mcp-installed.json` marker) and `POST /mcp/test` (minimal MCP JSON-RPC client in `mcp-test.ts`) endpoints on the session worker; install fired at session activation from `app-lifecycle.ts`.
- [x] `claude.ts` `AUTO_TOOLS` / `NORMAL_TOOLS` extended with `mcp__<server>__*` per enabled server; `PLAN_TOOLS` excludes them. `normalInstruction` prompt updated to require `AskUserQuestion` confirmation for side-effecting MCP tools.
- [x] `AgentRunParams.mcpServers` field added; populated in `agent-execution.ts` with enabled (unresolved) configs; carried whole through `proxy-agent-process.ts` / `POST /agent/start`; `claude-adapter.ts` derives `mcpServerNames` for the allowlist.
- [x] Settings UI (`McpServerSettings.tsx`, new "MCP Servers" tab in `Settings.tsx`) for add / edit / remove / toggle / test, with per-server status badges driven by the `mcp_server_status` WS message.
- [x] Client store (`mcp-store.ts`); `mcp_server_status` WS message type added and relayed from the worker SSE through `container-session-runner.ts` → `useMessageHandler.ts`.
- [x] **Real liveness signal from the Claude CLI init event.** `ClaudeSystemEvent` extended with `mcp_servers?: Array<{ name; status }>`. `ClaudeAdapter` parses this and emits an `mcp_status` event on a new `AgentProcessEvents.mcp_status` channel; `SessionWorker.wireAgentEvents()` broadcasts each entry as an `mcp_server_status` SSE event. The speculative `loaded` emit in `generateMcpConfig()` is gone — that path now only emits `failed` for missing secrets (a definitive pre-spawn failure). `mapCliMcpStatus()` maps `connected→loaded`, `needs-auth→failed("authentication required")`, `failed→failed("connection failed")`, unknown→`failed("unknown status: ...")` so we don't silently swallow a new CLI signal. Codex deliberately never emits `mcp_status` — it doesn't support MCP.
- Tests: `agent-registry.test.ts`, `credential-store.test.ts`, `secret-resolver.test.ts`, `services/mcp.test.ts`, `mcp-resolve.test.ts` (pure substring resolver extracted from `session-worker.ts`), `integration_tests/mcp-routes.test.ts` (HTTP CRUD + secret non-echo + cap + test-endpoint 409), `client/stores/mcp-store.test.ts`, `client/components/McpServerSettings.test.tsx`, `claude-adapter.test.ts` (new "MCP server liveness" describe block + `mapCliMcpStatus` unit cases).
- Deferred to a follow-up: mid-session `crashed` detection (the init-event signal covers cold-start liveness only; spotting a server that dies mid-turn would require inspecting tool-result error payloads).

### Phase 2 — Native OAuth (extends 087's platform-credentials) — **landed**

Browser-based OAuth consent flow for providers that support it. ShipIt acts as an OAuth client. Treat each MCP OAuth provider as a new entry in 087's platform-credentials registry rather than building a parallel system.

> **Implementation note (Phase 2 landed).** The first cut ships with two
> seeded providers (Linear, Notion) and uses operator-supplied OAuth client
> ids (env vars `LINEAR_OAUTH_CLIENT_ID` / `NOTION_OAUTH_CLIENT_ID`).
> Dynamic client registration (RFC 7591) is intentionally deferred — neither
> provider exposes it today, so we'd be writing infrastructure with no
> production target. The provider config schema (`McpOAuthProviderConfig.registrationEndpoint`)
> reserves the field for when a future provider supports it. The
> `clientSecretEnv` field is also wired through but optional; PKCE alone
> protects the flow for public clients, which is what ShipIt is.
>
> Token refresh runs on two cadences: (a) at orchestrator startup (deferred
> to a follow-up — currently triggered per-turn only), and (b) before each
> agent turn in `ws-handlers/agent-execution.ts`, where the existing
> `refreshExpiredMcpOAuthTokens()` call refreshes any token within 5 minutes
> of expiry before pushing the merged env set to the worker. Refresh
> failures leave the stale token in place so the worker emits a meaningful
> `failed` `mcp_server_status` (mapped from the CLI's `needs-auth` signal)
> instead of silently dropping the server.
>
> The worker-side resolver (`mcp-resolve.ts`) now recognizes both
> `$secret:KEY` and `$platform:<source>` placeholders. `$platform:linear_oauth`
> looks up `MCP_PLATFORM_LINEAR_OAUTH` — the orchestrator writes that key
> into the merged env set via `collectMcpAgentEnv()`, which now reads both
> `CredentialStore.agentEnv` (`mcp__*` namespace) AND
> `CredentialStore.mcpOAuth` (each `accessToken` → `MCP_PLATFORM_<UPPER>`).
> The mapping is documented in `mcp-oauth-providers.ts` as the single
> source of truth.

**Scope: one connection per provider per account.** 087's `PlatformCredentialProvider` is a singleton resolver — `platform:claude_oauth` resolves to "the" Claude token, no parameter for "which one." Phase 2 adopts the same constraint: one Linear connection per ShipIt account, one Notion connection per ShipIt account. Users with multiple workspaces pick one as the active connection. Multi-instance support (e.g., `platform:linear_oauth:<workspace_id>`) is **out of scope for Phase 2** and would require parameterizing `PlatformCredentialProvider.resolve(source)` to accept an instance qualifier — flagged as a Phase 3 follow-up if demand exists.

**Source-to-env-var mapping (the contract worker and orchestrator share):**

`$platform:<source_id>` placeholders in `mcpServers` blobs are resolved by the worker against `process.env` under the key `MCP_PLATFORM_<UPPERCASE_UNDERSCORED_SOURCE_ID>`. Examples:

| Placeholder | Env var name |
|---|---|
| `$platform:linear_oauth` | `MCP_PLATFORM_LINEAR_OAUTH` |
| `$platform:notion_oauth` | `MCP_PLATFORM_NOTION_OAUTH` |

The orchestrator-side flow at session activation:
1. For each enabled MCP server whose blob contains a `$platform:` reference, resolve via `platform-credentials.ts` (refreshing the token if expired).
2. Write the resolved value into `agentValues` under the corresponding `MCP_PLATFORM_*` key.
3. Push to the worker via the same `tryPushAgentSecrets` path used for `mcp__*` keys.

The worker's resolver is extended to recognize both `$secret:KEY` and `$platform:source_id` placeholders; both look up `process.env[…]` after applying the appropriate name transform.

**Phase 2 work items:**

- [x] OAuth callback endpoint (`GET /api/mcp-servers/oauth/callback`).
- [x] Callback page closes the popup via `postMessage` to the opener so the user is returned to the Settings panel without manually switching tabs (per ShipIt principle: external tabs only for things ShipIt doesn't own — the consent screen is, but the post-auth landing isn't).
- [x] Provider registry (`mcp-oauth-providers.ts`) seeded with `linear_oauth` and `notion_oauth`. Each entry encapsulates the provider's authorization endpoint, token endpoint, scopes, MCP URL, and the env var name for the operator-supplied client id.
- [x] `platform-credentials.ts` extended: `createPlatformCredentialProvider` now resolves `platform:<provider_id>` for any registered MCP OAuth provider by reading the persisted access token from `CredentialStore.mcpOAuth`. `isPlatformSource` accepts the union of hand-maintained sources + MCP OAuth provider ids. `knownSources()` returns both.
- [x] Token storage in `CredentialStore.mcpOAuth?: Record<string, OAuthTokens>` with `setMcpOAuthTokens` / `getMcpOAuthTokens` / `getAllMcpOAuthTokens` / `deleteMcpOAuthTokens`. `clear()` wipes the map. Persistence survives reload.
- [x] Token refresh logic in `services/mcp-oauth.ts` (`refreshOAuthTokens` + `refreshExpiredMcpOAuthTokens`). The platform-credentials resolver stays sync (087's contract) and reads the most recently persisted access token; refresh runs on an async path before agent start.
- [x] Worker resolves `$platform:<source>` refs via the parallel regex `/\$platform:([a-z][a-z0-9_]*)/g`, looking up `MCP_PLATFORM_<UPPER_SOURCE>` in `process.env`. The env var name contract is owned by `platformSourceEnvName()` in `mcp-oauth-providers.ts`.
- [x] "Connect with Linear" / "Connect with Notion" button in the Settings → MCP Servers panel. Opens the authorize URL in a popup, awaits a `postMessage` from the callback page, and refreshes the provider list. On successful connect, auto-creates a placeholder MCP server entry with `headers: { Authorization: "Bearer $platform:<id>" }` so the connection is usable immediately.
- [x] Fallback: users can still paste tokens manually as Phase 1 Bearer tokens — the two paths coexist on the same server type. The new OAuth path is additive.
- [x] PKCE-only flow (no `client_secret` required, per RFC 8252 for native apps). When the operator does set `<PROVIDER>_OAUTH_CLIENT_SECRET`, the service passes it along for providers that mandate confidential clients.
- [x] In-memory `InMemoryOAuthStateStore` with a 10-minute TTL holds per-flow PKCE state between `POST /start` and `GET /callback`. Single-use (consumed by `take()`).
- [x] Per-turn awaited refresh in `ws-handlers/agent-execution.ts`: `refreshExpiredMcpOAuthTokens` runs before the worker push so tokens within 5 minutes of expiry are rotated proactively. Failures are logged and don't block agent start.
- Deferred to a follow-up:
  - Dynamic client registration (RFC 7591) — neither Linear nor Notion supports it today; the schema field is reserved for when a future provider does.
  - Startup-time refresh sweep (currently per-turn only — a long-idle session has fresh tokens on its first turn).
  - Multi-instance OAuth (parameterized `platform:linear_oauth:<workspace_id>`) — Phase 3.

### Phase 3 — Advanced features

- MCP server sharing across sessions (single instance, multiple agents connect via SSE bridge)
- Per-repo MCP config in `shipit.yaml` (auto-prompted on clone)
- MCP server marketplace with one-click install
- Pre-installed popular servers in the container base image
- Multi-instance OAuth (parameterized `platform:linear_oauth:<workspace_id>`) for users who want multiple workspaces of the same provider connected simultaneously

## Tests

Per ShipIt's testing-and-quality conventions (server tests use temp dirs and the `TestClient` integration helper; client tests use `render` / `renderHook` / `FakeWebSocket`):

### Phase 1

**Unit tests:**
- `credential-store.test.ts` — `mcpServers` CRUD round-trip; `mcp__*` agentEnv writes survive `load()`; rename clears old keys.
- `agent-registry.test.ts` — `isAllowedAgentEnvKey()` predicate accepts `OPENAI_API_KEY` + any `mcp__*` key; rejects empty / invalid names.
- `secret-resolver.test.ts` — new `collectMcpAgentEnv()` helper returns `mcp__*` entries from a fake `CredentialStore` and is independent of `resolveSecrets()`.
- `service-manager.test.ts` — `syncSecrets()` merges `collectMcpAgentEnv()` output into `agentValues` after `resolveSecrets()` returns; collisions resolve compose-wins; the `secrets_status` payload includes the merged `mcp__*` keys; `.shipit/.env.agent` write reflects the merged set.
- `agent-instructions.test.ts` — `normal`-mode prompt mentions confirming `mcp__*` tool calls via `AskUserQuestion`; `auto` and `plan` mode prompts unchanged.
- `session-worker.test.ts` — `generateMcpConfig()` resolves `$secret:KEY` substring placeholders against `process.env` (regex `/\$secret:([A-Za-z_][A-Za-z0-9_]*)/g`); drops servers with missing keys and emits a `mcp_server_status` event; merges built-in Playwright config; deletes the temp file on agent exit.
- `claude.test.ts` (or wherever the allowlist construction lives) — enabled MCP servers add `mcp__<name>__*` to `auto` and `normal` modes; absent from `plan` mode.

**Integration tests** (under `src/server/orchestrator/integration_tests/`):
- `mcp-crud.test.ts` — full CRUD over `/api/mcp-servers`; secret values not echoed in responses; name validation; account-level cap enforcement.
- `mcp-agent-env-push.test.ts` — adding a server with a secret triggers `tryPushAgentSecrets`; updating the secret triggers another push; deleting the server pushes the cleared key.
- `mcp-test-endpoint.test.ts` — `POST /api/mcp-servers/:id/test` returns 409 with no active session, proxies through the worker when one exists, returns the tool list (using a stub MCP server), surfaces errors on failure.
- `mcp-tool-allowlist.test.ts` — agent process spawned with the right `--allowedTools` glob per mode.

**Client tests:**
- `mcp-store.test.ts` — `fetchServers`, `addServer`, `updateServer`, `removeServer`, `testServer`; status updates from `mcp_server_status` events update the right rows.
- `McpServerSettings.test.tsx` — render, add form validation, missing-secret badge state, error states from the store.

### Phase 2

- `platform-credentials.test.ts` — `linear_oauth` source resolves to a fresh token; expired tokens trigger refresh; refresh failures surface a structured error.
- `mcp-oauth-flow.test.ts` — callback endpoint exchanges code for tokens; persists to `mcpOAuth` map; subsequent `resolve()` returns the persisted token.
- `mcp-platform-secret.test.ts` — `$platform:linear_oauth` placeholder resolves to `MCP_PLATFORM_LINEAR_OAUTH` env var inside the worker.

## Key files

### New files
- `src/server/shared/types/mcp-types.ts` — MCP server config types (`McpStdioServerConfig`, `McpHttpServerConfig`). Extended in Phase 2 with `OAuthTokens`, `McpOAuthProviderConfig`, `McpOAuthStatus`.
- `src/server/orchestrator/api-routes-mcp.ts` — HTTP routes for CRUD + test (Phase 1) + OAuth start/callback/disconnect/providers (Phase 2).
- `src/server/orchestrator/services/mcp.ts` — Service layer for MCP operations (validation, name conflicts, server count cap).
- `src/server/orchestrator/services/mcp-oauth.ts` — **(Phase 2)** OAuth service: PKCE start, callback exchange, refresh, in-memory state store, normalization, listing, disconnect. Pure functions over `CredentialStore`; the `fetch` boundary is injectable for tests.
- `src/server/orchestrator/mcp-oauth-providers.ts` — **(Phase 2)** Provider registry seeded with Linear and Notion. Owns the `MCP_PLATFORM_<UPPER_SOURCE>` env-var contract via `platformSourceEnvName()`.
- `src/server/session/mcp-resolve.ts` — Pure `$secret:` / `$platform:` substring resolver consumed by `session-worker.ts`'s `generateMcpConfig()`. Extracted so the substitution contract (env walk, missing-key drop, dedup) is unit-testable without a Fastify worker.
- `src/server/session/mcp-test.ts` — Minimal MCP JSON-RPC client used by the `POST /mcp/test` connectivity endpoint.
- `src/client/stores/mcp-store.ts` — Client state store. Extended in Phase 2 with `oauthProviders`, `fetchOAuthProviders`, `startOAuthFlow` (with popup + postMessage), `disconnectOAuth`.
- `src/client/components/McpServerSettings.tsx` — Settings UI component. Extended in Phase 2 with a "One-click connections" section that surfaces every registered OAuth provider as a Connect / Disconnect button.

### Modified files (orchestrator)
- `src/server/orchestrator/credential-store.ts` — Add `mcpServers` map, MCP CRUD methods, `setMcpSecret` / `deleteMcpSecret` helpers for `mcp__*` agentEnv writes, ensure `clear()` wipes both.
- `src/server/orchestrator/secret-resolver.ts` — Add `collectMcpAgentEnv(credentialStore)` helper (returns `Record<string, string>` of `mcp__*` entries from `CredentialStore.agentEnv`). `resolveSecrets()` itself is unchanged — MCP secrets do **not** flow through compose declarations or `userSecrets`.
- `src/server/orchestrator/service-manager.ts` — Inside `syncSecrets()`, merge `collectMcpAgentEnv()` into the `agentValues` map (after `resolveSecrets()` runs, before writing `.shipit/.env.agent` and emitting `secrets_status`). This is the actual callsite where the merge happens.
- `src/server/orchestrator/container-session-runner.ts` — Pass unresolved MCP server configs in `AgentRunParams`. `tryPushAgentSecrets()` is now `public` so the per-turn agent-start path can `await` it for compose-less sessions (callers must pass the *full* account-level agent env — the worker REPLACES its tracked set).
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — Build the enabled `mcpServers` blob list for `AgentRunParams`; for compose-less `ContainerSessionRunner`s (no `ServiceManager`), `await runner.tryPushAgentSecrets(credentialStore.getAllAgentEnv())` before `/agent/start` so `mcp__*` keys land in the worker's `process.env` ahead of `generateMcpConfig()`.
- `src/server/orchestrator/app-di.ts` — Update the `ALLOWED_ENV_KEYS` consumer to use the new `isAllowedAgentEnvKey()` predicate when loading persisted `CredentialStore.agentEnv` into `process.env` at startup.
- `src/server/orchestrator/services/settings.ts` — Update the `set_agent_env` validation site to use the new predicate.
- `src/server/orchestrator/proxy-agent-process.ts` — Thread `mcpServers` field through the proxy to the worker (`AgentRunParams` already crosses this boundary; this is purely additive).
- `src/server/orchestrator/api-routes.ts` — Register new MCP routes.
- `src/server/orchestrator/platform-credentials.ts` — (Phase 2) extend with MCP OAuth providers; document the `MCP_PLATFORM_<…>` env-var-name mapping.
- `src/server/orchestrator/agent-instructions.ts` — Add a sentence to the `normal`-mode prompt directing the agent to confirm side-effecting MCP tool calls via `AskUserQuestion` (existing convention is general-purpose; this makes it explicit for unfamiliar `mcp__*` tools).

### Modified files (shared)
- `src/server/shared/agent-registry.ts` — Add an exported `isAllowedAgentEnvKey(key)` predicate that accepts the literal allowlist plus `/^mcp__/`. Keep `ALLOWED_ENV_KEYS` exported alongside the predicate (the `agent-registry.test.ts` test imports the set directly, and dependent re-export sites at `src/server/session/agents/agent-registry.ts` and `src/server/session/agents/index.ts` re-export it); existing consumers (`app-di.ts`, `services/settings.ts`) switch to the predicate. `ALLOWED_ENV_KEYS` becomes "literal exact-match allowlist" and the predicate is "literal OR `mcp__*`".
- `src/server/shared/types/agent-types.ts` — Add `mcpServers?: McpServerConfig[]` to `AgentRunParams`.

### Modified files (session worker)
- `src/server/session/session-worker.ts` — Extend `generateMcpConfig()` to resolve `$secret:KEY` substring placeholders against `process.env` and merge user servers with built-in Playwright. Add `POST /mcp/install` (per-package mutex, `/tmp/mcp-installed.json` tracking, parallel `npm install -g`). Add `POST /mcp/test` to support the orchestrator-routed test endpoint. Add `mcp_server_status` SSE event emission.
- `src/server/session/claude.ts` — Extend the `AUTO_TOOLS`, `NORMAL_TOOLS`, and `PLAN_TOOLS` constant strings (lines 38–46) by appending `mcp__<server>__*` per enabled user server. `AUTO_TOOLS` and `NORMAL_TOOLS` include user servers; `PLAN_TOOLS` excludes them. The Codex adapter and any future adapters that own their own allowlists do the same in their own files; `claude-adapter.ts` itself only forwards `mcpConfigPath` and is not modified.

### Modified files (client)
- `src/client/components/Settings.tsx` — Add MCP Servers section between "Instructions" and "Secrets".
