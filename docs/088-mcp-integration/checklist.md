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

- [x] **MCP secrets now reach compose-less sessions.** The secret transport
  used to piggyback solely on `ServiceManager.syncSecrets()`
  (`mcpAgentEnvLoader` merge), but `setupServiceManager()` returns early when
  the project has no compose config — so a compose-less session never got a
  `ServiceManager` and never pushed `mcp__*` keys to its worker. Fixed in
  `ws-handlers/agent-execution.ts`: on every turn, if the resolved runner is a
  `ContainerSessionRunner` with **no** `ServiceManager`, the orchestrator
  `await`s `runner.tryPushAgentSecrets(credentialStore.getAllAgentEnv())`
  before calling `/agent/start`. This (a) covers compose-less sessions, (b)
  closes the per-turn sequencing race (the push is awaited ahead of agent
  start), and (c) picks up servers added mid-session. The `!serviceManager`
  guard is the correctness boundary — compose sessions still get the *merged*
  (compose-declared + MCP) set via `syncSecrets()`, and pushing the partial
  account-level set for them would clobber their `agent: true` secrets since
  the worker REPLACES its tracked set on every push. `tryPushAgentSecrets`
  was made public for this. Covered by `container-agent-wiring.test.ts`
  (`tryPushAgentSecrets()` describe block).
- [x] **Per-server `mcp_server_status` now driven by a real liveness signal.**
  The Claude CLI's init event includes an `mcp_servers[]` field reporting the
  actual per-server connection result (`connected` / `failed` / `needs-auth`).
  `ClaudeAdapter` parses this and emits an `mcp_status` event on a new
  AgentProcess channel; `SessionWorker.wireAgentEvents()` broadcasts each
  entry as an `mcp_server_status` SSE event. The speculative `loaded` emit
  in `generateMcpConfig()` is gone — that path now only emits `failed` for
  missing secrets (a definitive pre-spawn failure). `mapCliMcpStatus()`
  maps `connected→loaded`, `needs-auth→failed("authentication required")`,
  `failed→failed("connection failed")`, unknown→`failed("unknown status: ...")`.
  Covered by `claude-adapter.test.ts` (the new "MCP server liveness" describe
  block + `mapCliMcpStatus` unit cases).
- [ ] Mid-session `crashed` detection — the init event covers cold-start
  liveness only. Spotting a server that dies mid-turn requires inspecting
  tool-result error payloads (or waiting for a future CLI signal); deferred
  for now since the failure surface still reaches the user via the
  individual tool-call error.
- [x] Integration tests for `/api/mcp-servers` routes (CRUD, secret non-echo,
  cap enforcement, test-endpoint 409 with no active session). Landed in
  `integration_tests/mcp-routes.test.ts` — 16 cases covering name/type
  validation, duplicate-name 409, secret-namespace 400, the enabled-server
  cap, rename clearing old secrets, and 404 paths. The agent-env push flow
  (`tryPushAgentSecrets` on compose-less sessions) is exercised in
  `container-agent-wiring.test.ts`.
- [x] Client component tests for `McpServerSettings.tsx` and `mcp-store.ts`.
  Landed in `stores/mcp-store.test.ts` (9 cases: CRUD round-trips through a
  fake fetch, error surfacing, `applyStatus()` merge semantics, `reset()`)
  and `components/McpServerSettings.test.tsx` (9 cases: empty state, server
  list, status badge from `useMcpStore.statuses`, disabled Test button
  without an active session, form validation for invalid names + missing
  command, store-level error banner, secrets-not-echoed on edit).
- [x] `session-worker.test.ts` coverage for `generateMcpConfig()` placeholder
  resolution + missing-secret drop. The `$secret:` resolver was extracted to
  `src/server/session/mcp-resolve.ts` (pure function over env map) so it can
  be unit-tested without spinning up a Fastify worker — `mcp-resolve.test.ts`
  exercises substring substitution in env/headers/args, the missing-secret
  drop path (incl. empty-string and undefined-as-missing), the dedupe of
  reported missing keys, and the no-placeholder pass-through.
- [~] `await`-the-`PUT /secrets`-before-agent-start sequencing — **done for
  compose-less sessions** (the per-turn awaited push above). Compose sessions
  still rely on the fire-and-forget `secrets_status`-driven push at activation;
  closing that race needs a merge-aware push (the worker REPLACES its set, so
  the per-turn push must carry the *full* compose+MCP set) and is deferred.

## Phase 2 — Native OAuth — landed

- [x] **OAuth callback endpoint + popup-close landing page.**
  `GET /api/mcp-servers/oauth/callback` exchanges code → tokens, persists,
  and renders a small HTML page that `postMessage`s the result to the
  opener (the Settings panel) and closes itself. Falls back to a static
  success/failure message if the popup wasn't opened with `window.open()`.
- [x] **Extend `platform-credentials.ts` with `platform:linear_oauth`,
  `platform:notion_oauth`.** `createPlatformCredentialProvider` now takes
  an optional `credentialStore` and resolves any registered MCP OAuth
  source by reading the persisted access token from
  `CredentialStore.mcpOAuth`. `isPlatformSource` recognizes the union of
  hand-maintained sources + dynamically-registered MCP OAuth provider ids.
- [x] **`mcpOAuth` token storage + refresh logic.** `CredentialStore` got
  `mcpOAuth?: Record<string, OAuthTokens>`, plus
  `setMcpOAuthTokens` / `getMcpOAuthTokens` / `getAllMcpOAuthTokens` /
  `deleteMcpOAuthTokens`. `services/mcp-oauth.ts` owns the flow:
  `startOAuthFlow` (PKCE + state), `handleOAuthCallback` (code exchange),
  `refreshOAuthTokens` (single source), and `refreshExpiredMcpOAuthTokens`
  (sweep within a 5-minute safety margin). Refresh runs per agent turn
  via `ws-handlers/agent-execution.ts`; the resolver itself stays sync
  per 087's contract.
- [x] **Worker resolves `$platform:<source>` placeholders.** `mcp-resolve.ts`
  now applies the parallel regex `/\$platform:([a-z][a-z0-9_]*)/g` and
  looks up `MCP_PLATFORM_<UPPER_SOURCE>`. The orchestrator writes those
  env vars via `collectMcpAgentEnv()`, which reads
  `CredentialStore.mcpOAuth.accessToken` and maps each entry to
  `MCP_PLATFORM_<UPPER>`. Missing source → drops the server with the
  env-var name in the missing list (consistent with `$secret:`).
- [x] **"Connect with Linear" UI.** Settings → MCP Servers now shows a
  "One-click connections" section listing every provider in the registry
  with Connect / Disconnect buttons. Connect opens a popup, awaits
  `postMessage` from the callback, refreshes the provider list, and
  auto-creates a placeholder MCP server config with
  `headers: { Authorization: "Bearer $platform:<id>" }`.

### Phase 2 — deferred / follow-up

- [ ] **Dynamic client registration (RFC 7591).** Neither Linear nor
  Notion supports it today; the schema field is reserved
  (`McpOAuthProviderConfig.registrationEndpoint`). Once a provider needs
  it, plug it into `startOAuthFlow` between the source lookup and the
  authorize-URL build.
- [ ] **Startup-time token refresh sweep.** Currently refresh runs only
  on the per-turn path (`agent-execution.ts`). A long-idle session has
  fresh tokens on its first turn — fine — but a session that ran a turn
  > 1h ago and then the orchestrator restarts gets the stale persisted
  token until the next turn rotates it. Easy to add via `app-lifecycle.ts`
  `scheduleStartupTasks`.

## Phase 3 — Advanced (not started)

- [ ] MCP server sharing across sessions
- [ ] Per-repo MCP config in `shipit.yaml`
- [ ] MCP server marketplace
- [ ] Pre-installed popular servers in the base image
- [ ] Multi-instance OAuth
