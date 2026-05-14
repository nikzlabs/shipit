# 088 — MCP Integration · Checklist

## Phase 1 — landed

- [x] `mcp-types.ts` shared types (`McpServerConfig`, status/test types)
- [x] `CredentialStore`: `mcpServers` map + CRUD + `mcp__*` secret helpers
- [x] `isAllowedAgentEnvKey()` predicate; `app-di.ts` / `services/settings.ts` switched
- [x] `collectMcpAgentEnv()` + `renderAgentEnvBody()`; wired into `ServiceManager.syncSecrets()` via `mcpAgentEnvLoader`
- [x] `services/mcp.ts` (validation, name conflicts, enabled-server cap)
- [x] `api-routes-mcp.ts` (CRUD + connectivity test), registered
- [x] `session-worker.ts` `generateMcpConfig()` resolves `$secret:` placeholders, merges Playwright, emits `mcp_server_status`
- [x] `POST /mcp/install` (per-package mutex + marker) and `POST /mcp/test` (minimal MCP JSON-RPC client)
- [x] MCP npm installs fired at session activation from `app-lifecycle.ts`
- [x] `claude.ts` tool allowlist (`auto`/`normal` only) + normal-mode prompt note
- [x] `AgentRunParams.mcpServers` plumbed through; `claude-adapter.ts` derives `mcpServerNames`
- [x] Client `mcp-store.ts` + `McpServerSettings.tsx` + Settings tab
- [x] `mcp_server_status` WS message relayed worker SSE → WS → store
- [x] Unit tests: `agent-registry`, `credential-store`, `secret-resolver`, `services/mcp`

## Phase 1 — remaining work to fix

- [ ] **MCP secrets only reach sessions that have a `ServiceManager`.** The
  secret transport piggybacks on `ServiceManager.syncSecrets()`
  (`mcpAgentEnvLoader` merge), but `setupServiceManager()` returns early when
  the project has no compose config — so a compose-less session never gets a
  `ServiceManager`, never writes `.shipit/.env.agent`, and never pushes
  `mcp__*` keys to its worker. The `mcpServers` config blobs still arrive in
  `AgentRunParams`, so `generateMcpConfig()` drops every server with a missing
  secret. Fix: give compose-less sessions a path to push `mcp__*` agent env to
  the worker (e.g. a runner-level push that runs regardless of compose, or
  always create a minimal `ServiceManager`). Same gap exists for 087's
  `agent: true` secrets — consider fixing both together.
- [ ] Per-server `mcp_server_status` driven by a real liveness signal — Phase 1
  only emits `loaded` / `failed` from `generateMcpConfig()` at agent start; no
  `crashed` detection mid-session.
- [ ] Integration tests for `/api/mcp-servers` routes (CRUD, secret non-echo,
  cap enforcement, test-endpoint 409/proxy) and the agent-env push flow.
- [ ] Client component tests for `McpServerSettings.tsx` and `mcp-store.ts`
  (form validation, status badges, error states).
- [ ] `session-worker.test.ts` coverage for `generateMcpConfig()` placeholder
  resolution + missing-secret drop, and `mcp-test.ts` handshake.
- [ ] Confirm the `await`-the-`PUT /secrets`-before-agent-ready sequencing from
  the plan ("Sequencing: secrets must arrive before the agent starts") — the
  at-activation push is currently still fire-and-forget via `secrets_status`.

## Phase 2 — Native OAuth (not started)

- [ ] OAuth callback endpoint + popup-close landing page
- [ ] Extend `platform-credentials.ts` with `platform:linear_oauth`, `platform:notion_oauth`
- [ ] `mcpOAuth` token storage + refresh logic
- [ ] Worker resolves `$platform:<source>` placeholders (`MCP_PLATFORM_*` env mapping)
- [ ] "Connect with Linear" UI

## Phase 3 — Advanced (not started)

- [ ] MCP server sharing across sessions
- [ ] Per-repo MCP config in `shipit.yaml`
- [ ] MCP server marketplace
- [ ] Pre-installed popular servers in the base image
- [ ] Multi-instance OAuth
