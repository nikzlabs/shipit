---
issue: https://linear.app/shipit-ai/issue/SHI-112
description: Surface an agent-agnostic approve/deny card when an agent's edit to a sensitive file (or escalated action) is gated, so the user can grant it.
---

# 193 — Sensitive-file permission prompt (SHI-112)

## Context

ShipIt runs every agent CLI headless. Each backend has a built-in permission gate
for sensitive actions — Claude classifies files like `.npmrc` / `.env` as
sensitive and prompts before editing them (even when `Write`/`Edit` are
allowlisted); Codex's app-server can raise a blocking approval request for an
escalated command or file change. Headless, there is no human at the prompt, so:

- **Claude** auto-**denied** the gated edit (`"Claude requested permissions to
  edit <path> which is a sensitive file"`), and **no approve/deny UI ever
  appeared** — an approved, benign change became unwriteable. The agent couldn't
  route around it either (Write, then `cat >`, then `printf >>` all re-gated).
- **Codex** silently **auto-approved** every escalation — the opposite failure:
  the user never saw the gate at all.

The gate is correct in intent; the defect was the missing grant affordance. This
feature adds one — an **agent-agnostic** approve/deny (+ remember) card that any
backend plugs into, so a gated action becomes a real, user-answerable prompt
rather than a dead-end or a silent bypass.

## How it works

A worker-owned **`PermissionBroker`** is the single locus. It holds pending
requests, the per-session "remember" allow-set, broadcasts the canonical
request/resolved events, and resolves uniformly — regardless of which agent
raised the request.

```
Claude:  CLI sensitive-file gate ──(--permission-prompt-tool)──▶ mcp-permission-bridge
                                                                      │ POST /agent-ops/permission/request (blocks)
Codex:   app-server requestApproval ──(injected requestPermission)────┤
                                                                      ▼
                                                            PermissionBroker.request()
                                                              │ broadcast agent_permission_request (SSE agent_event)
                                                              ▼
                          orchestrator agent-listeners → emitChatCard → PermissionRequestCard (persisted, pending)
                                                              │
                              user clicks Approve/Deny(+remember) → resolve_permission (WS)
                                                              ▼
        ProxyAgentProcess.resolvePermission → /agent/permission/resolve → PermissionBroker.resolve()
                                                              │ unblocks the held bridge/RPC call → action proceeds/denied
                                                              ▼ broadcast agent_permission_resolved
                          agent-listeners → updatePermissionCard + permission_resolved (WS) → terminal card
```

Key properties:

- **The turn stays alive** while a request is pending (the CLI/app-server is
  blocked inside the tool call), so — unlike AskUserQuestion — there's no
  interrupt/resume. Approving lets the agent's *next write* succeed directly.
- **No prompt spam.** Claude's `--permission-prompt-tool` only fires for
  "ask"-tier calls; allowlisted working-dir edits still auto-approve. Codex only
  raises a request for genuinely escalated actions.
- **Remember** is a per-session, per-path allow-set in the broker: an approved
  "remember" auto-allows later requests for the same file with no card.
- **Fail-safe.** The Claude bridge fails *closed* (a broker/transport error → a
  deny envelope, never an unconfirmed proceed). Codex falls back to its historical
  auto-accept only when no broker is wired or the broker path throws (never hangs
  a turn). A 30-min timeout and agent-teardown both auto-deny + expire any
  pending card.
- **Persisted** like every transcript card (docs/188 contract): the card and its
  approved/denied/expired terminal state survive a reconnect, switch, and reload.
  A still-pending card comes back actionable after a reload — the worker holds
  the request.

## Agent-agnostic seam

The canonical core is agent-neutral; each adapter only translates its native
mechanism to/from it:

| Piece | Shared (agent-neutral) | Claude | Codex |
|---|---|---|---|
| Raise a request | `PermissionBroker.request` | `mcp-permission-bridge` → `/agent-ops/permission/request` | `setPermissionRequester` injected → `handleServerRequest` |
| Surface the card | `agent_permission_request` event → `emitChatCard` → `PermissionRequestCard` | (same) | (same) |
| Resolve | `resolve_permission` WS → `/agent/permission/resolve` → `broker.resolve` | held bridge HTTP returns allow/deny envelope | JSON-RPC `{decision:"accept"\|"reject"}` |
| Persist | `permissionPrompt` `PersistedMessage` field + card store | (same) | (same) |

A future backend implements `setPermissionRequester` (or bridges to
`/agent-ops/permission/request`) and gets the card for free.

## Key files

**Worker / agent-agnostic core**
- `src/server/session/permission-broker.ts` — the broker (new).
- `src/server/session/mcp-permission-bridge.ts` — Claude's `--permission-prompt-tool` (new).
- `src/server/session/session-worker.ts` — broker construction, `/agent-ops/permission/request` + `/agent/permission/resolve`, `permissionBridgePaths`, Codex requester injection, reject-all on teardown.
- `src/server/session/agents/claude/{adapter,process}.ts` — register `shipit-permission`; pass `--permission-prompt-tool`.
- `src/server/session/agents/codex/adapter.ts` — `setPermissionRequester` + `resolveApproval` routing (replaces unconditional auto-accept); `buildCodexPermissionInput`.
- `src/server/shared/types/agent-types.ts` — `AgentPermissionRequestEvent`, `AgentPermissionResolvedEvent`, `PermissionDecision`, `PermissionRequester`, `AgentMcpPermissionBridge`, `AgentProcess.{resolvePermission,setPermissionRequester}`.

**Orchestrator**
- `src/server/orchestrator/proxy-agent-process.ts` + `container-session-runner.ts` — `resolvePermission` → `/agent/permission/resolve`.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `agent_permission_request` → emitChatCard; `agent_permission_resolved` → patch + `permission_resolved`.
- `src/server/orchestrator/ws-handlers/permission-handlers.ts` — `handleResolvePermission` (new); dispatch in `index.ts`.
- `src/server/orchestrator/chat-history.ts` + `src/server/shared/database.ts` — `permissionPrompt` field/column + migration + `updatePermissionCard`.
- WS types: `ws-client-messages.ts` (`WsResolvePermission`), `ws-server-messages.ts` (`WsPermissionRequestCard`, `WsPermissionResolved`).

**Client**
- `src/client/stores/permission-store.ts`, `src/client/components/PermissionRequestCard.tsx` (new).
- `src/client/hooks/message-handlers/{permission-request-card,permission-resolved}.ts` + registration.
- `src/client/components/MessageList.tsx` (render + `onResolvePermission`), `visual-elements.ts` (`CARD_MESSAGE_FIELDS`), `utils/session-data.ts` (rehydrate), `App.tsx` (send `resolve_permission`).

## Degraded modes

- **Local mode** (dogfood) has no worker/broker, so the Claude bridge POST fails
  → deny. Sensitive-file edits there remain a dead-end (dev-only, already
  degraded per docs/118). Production (container) is the path that matters.
- The exact Codex reject enum (`reject` / `denied`) is inferred from the v2/v1
  schemas; verify against `codex app-server generate-json-schema` if a Codex
  deny ever misbehaves. Allow (`accept`/`approved`) is confirmed by existing tests.

## Tests

- `permission-broker.test.ts` — request/resolve/remember/timeout/reject-all/unknown-id.
- `chat-history.test.ts` — round-trip + `updatePermissionCard` + the `EVERY_OPTIONAL_FIELD_MESSAGE` / `CARD_MESSAGE_FIELDS` guards.
- `process.test.ts` — `--permission-prompt-tool` presence/absence.
- `claude/mcp-writer.test.ts` — `shipit-permission` registration.
- `codex/adapter.test.ts` — requester routing (allow→accept, deny→reject), `buildCodexPermissionInput`, auto-accept fallback preserved.
- `session-worker.test.ts` (integration) — full request→broadcast→resolve→reply round-trip + stale-id not-found.
- `visual-elements.test.ts` — empty-text carrier render guard.
