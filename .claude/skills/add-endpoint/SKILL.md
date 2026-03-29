---
name: add-endpoint
description: "Step-by-step guide for adding new server functionality to ShipIt: HTTP endpoints (service -> route -> client hook -> test), WebSocket messages (type -> handler -> dispatcher -> client), deploy targets, tool activity labels, and the WebSocket vs HTTP decision framework. Load when adding a new API endpoint, WS message type, deploy target, or activity label."
user-invocable: true
---

# Adding New Endpoints & Features

## When to use WebSocket vs HTTP

ShipIt uses HTTP for most operations and reserves WebSocket for a narrow set of cases. When adding a new feature, use this decision framework:

**Use HTTP** (default) when:
- The operation is a simple read (GET) or mutation (POST/PATCH/DELETE) with a single request-response cycle
- The client needs the result directly (e.g., to update UI state from the response)
- The operation is stateless — any client tab could make the same request
- Examples: fetching file content, renaming a session, creating a PR, saving settings

**Use WebSocket** only when one of these applies:
1. **Streaming output** — the server produces incremental data over time (Claude CLI events, deploy progress, terminal output). HTTP would require polling or SSE; WS gives us a natural push channel already connected.
2. **Per-connection state** — the operation modifies state tied to *this specific browser tab*, not the user globally. Session activation (`activate_session`) attaches a runner and file watcher to the connection. Agent selection (`set_agent`) sets the agent for this tab only. These don't make sense as HTTP because they bind to the socket's lifecycle.
3. **Bidirectional real-time interaction** — the client and server exchange messages in rapid succession as part of one logical flow: sending a prompt and receiving streamed tokens, answering permission questions mid-turn, interactive terminal I/O.
4. **Server-initiated push** — the server needs to notify the client without a preceding request: file change events, preview status updates, session status broadcasts, queue notifications.

**Gray area — lean HTTP:**
- If an operation triggers server-side effects that push WS events (e.g., `fork_session` triggers a `session_list` broadcast), that's fine — the trigger is HTTP, the notification is WS. Don't put the trigger on WS just because it has side effects.
- If you're unsure, start with HTTP. It's simpler to test (`app.inject()`), easier to debug (curl), and doesn't couple the operation to connection lifecycle. You can always add a WS broadcast for notifications on top.

**Current WS message types** (18 client -> server):
`send_message`, `answer_question`, `home_send_with_repo`, `new_session`, `activate_session`, `set_agent`, `interrupt_claude`, `fork_thread`, `switch_thread`, `initiate_deploy`, `cancel_deploy`, `cancel_queued_message`, `init_preview_config`, `diff_comment`, `clear_logs`, `terminal_start`, `terminal_input`, `terminal_resize`

See `docs/001-websocket-protocol/plan.md` for the full endpoint and message reference.

## Adding an HTTP endpoint (most cases)

**Prefer HTTP** for new endpoints unless the operation requires per-connection state or real-time streaming (see decision framework above).

1. Add the service function in the appropriate `src/server/orchestrator/services/*.ts` file — pure function that accepts explicit parameters (session ID, managers) and returns data or throws `ServiceError`
2. Add the Fastify route in `src/server/orchestrator/api-routes.ts` — call the service function, handle errors, return JSON
3. On the client, call the endpoint via `useApi` hook (`apiGet()` / `apiPost()` / etc.) from `src/client/hooks/useApi.ts`
4. Add integration tests using `app.inject()` in `src/server/orchestrator/integration_tests/`

## Adding a WebSocket message (streaming, per-connection state only)

1. Add the interface to `src/server/shared/types/ws-client-messages.ts` (and/or `ws-server-messages.ts` for server-to-client)
2. Add the handler in the appropriate `src/server/orchestrator/ws-handlers/*-handlers.ts` file
3. Add a `case` to the `switch (msg.type)` dispatcher in `src/server/orchestrator/index.ts`
4. Add the client-side handler in `src/client/hooks/useMessageHandler.ts`
5. Add integration tests in `src/server/orchestrator/integration_tests/`

**Key conventions:**
- Use `Extract<WsClientMessage, { type: "..." }>` to get the narrowed message type — don't import individual message interfaces.
- Handler functions are `async` only if they `await` something; otherwise use `void` return.
- Access per-connection state via `ctx` getters/setters (`ctx.getActiveAppSessionId()`, `ctx.setActiveSessionDir(...)`, etc.), not closure variables.
- Access app-level managers directly from `ctx` (`ctx.sessionManager`, `ctx.deploymentStore`, etc.).
- Import `getErrorMessage` from `./validation.js` for consistent error formatting (within orchestrator).

## Adding a new deploy target

1. Create a new file in `src/server/orchestrator/deploy-targets/` implementing the `DeployTarget` interface
2. Implement `info` (metadata + config fields) and `deploy(ctx)` method
3. Optionally implement `prepare(ctx)` for pre-deploy setup
4. Register the target in `index.ts` inside the `deploymentManager` initialization block
5. The UI automatically renders config fields from `info.configFields` — no client changes needed

## Adding a new tool activity label

Add a case to `activityFromTool()` in `src/client/components/StreamingIndicator.tsx`. The function receives the tool name and its input object, and returns a `StreamingActivity` with a human-readable label.
