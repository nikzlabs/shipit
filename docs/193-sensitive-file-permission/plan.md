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
Claude:  CLI gate ──(--permission-prompt-tool)──▶ mcp-permission-bridge
                                                       │ POST /request → { requestId }   (returns immediately)
                                                       │ POST /await   (bounded long poll, repeats until answered)
Codex:   app-server requestApproval ──(injected requestPermission)──▶ PermissionBroker.request() (direct await)
                                                       ▼
                                            PermissionBroker.openRequest() / poll()
                                              │ broadcast agent_permission_request (SSE agent_event)
                                              ▼
                          orchestrator agent-listeners → emitChatCard → PermissionRequestCard (persisted, pending)
                                              │ also → sseBroadcast session_attention (cross-session sidebar signal, Thread C)
                                              │
                              user clicks Approve/Deny(+remember) → resolve_permission (WS)
                                              ▼
        ProxyAgentProcess.resolvePermission → /agent/permission/resolve → PermissionBroker.resolve()
                                              │ unblocks the bridge's next poll / the awaited RPC → action proceeds/denied
                                              ▼ broadcast agent_permission_resolved
                          agent-listeners → updatePermissionCard + permission_resolved (WS) → terminal card
```

### Resilient long poll + idempotency (Thread B)

The Claude bridge originally held ONE HTTP fetch open for the entire wait. When
the user took their time — or stepped away to another session entirely — that
fetch tripped undici's headers/body timeout and surfaced as `"fetch failed"`.
The bridge then failed closed, the CLI denied the edit, and the model retried,
**stacking a fresh permission card each loop**. Fix:

- **`openRequest()` + `poll()` replace a single blocking `request()` HTTP call.**
  `POST /agent-ops/permission/request` registers and returns `{ requestId }` (or
  `{ behavior }` for a pre-approved action) immediately; `POST
  /agent-ops/permission/await` holds for a BOUNDED window (≤25 s) and returns
  `{ behavior }` once answered or `{ pending: true }` to poll again. Short holds
  mean a slow user never trips a client timeout; a brief worker unreachability
  is a quick failed poll the bridge retries with exponential backoff rather than
  a hard failure. It only fails closed on a real 4xx/5xx rejection or sustained
  unreachability.
- **Idempotency on `toolUseId`.** A still-pending request for the same gated
  call re-attaches to the one card (no second broadcast), so a retried/duplicated
  open can't stack a duplicate. A genuine model retry carries a new `toolUseId`
  and correctly gets its own card.
- **Codex is unchanged.** Its app-server approval RPC is a one-shot native
  blocking channel, so its adapter still calls `broker.request()` and awaits the
  decision directly (no HTTP timeout to ride over).

### Cross-session attention signal (Thread C)

A session blocked awaiting a permission answer is invisible to a user focused on
another session. The orchestrator now tracks the outstanding requestIds per
runner (`SessionRunner.awaitingPermissionIds`) and broadcasts a global SSE
`session_attention` event (live toggle + connect snapshot). The client feeds it
into the existing `computeAttentionReason` derivation as the highest-priority
reason ("Needs your approval to continue" — it outranks the `isAgentRunning`
short-circuit because the agent IS held inside the gated call), so the sidebar
border, tooltip, and `useAttentionNotifications` all light up from one place.
This is the smallest useful slice of the larger unbuilt docs/060 notification
center.

### Card copy is generic, not a reason ShipIt doesn't know (Thread D)

ShipIt has **no sensitive-file matcher of its own** — the classification is
entirely the backend CLI's. The card therefore says "needs your approval" rather
than the old hard-coded "which is a protected file", which mislabeled
plan-mode-gated or otherwise-gated ordinary files as "protected."

Key properties:

- **The turn stays alive** while a request is pending (the CLI/app-server is
  blocked inside the tool call), so — unlike AskUserQuestion — there's no
  interrupt/resume. Approving lets the agent's *next write* succeed directly.
- **No prompt spam.** Claude's `--permission-prompt-tool` only fires for
  "ask"-tier calls; allowlisted working-dir edits still auto-approve. Codex only
  raises a request for genuinely escalated actions.
- **ShipIt-handled interrupt tools are never gated.** `AskUserQuestion` and
  `ExitPlanMode` are control-class tools ShipIt resolves via its own
  interrupt/resume flow (question card / PlanApproval card), but the Claude CLI
  still routes them through `--permission-prompt-tool`. The broker auto-allows
  them (`HANDLED_INTERRUPT_TOOLS` in `permission-broker.ts`) with no card — the
  CLI then emits the `tool_use` and the normal interrupt flow renders the right
  card. Without this, a dead-end approve/deny card appeared in place of the
  question/plan card.
- **Remember** is a per-session, per-path allow-set in the broker: an approved
  "remember" auto-allows later requests for the same file with no card.
- **No ShipIt-imposed deadline.** A permission decision is the user's, so the
  broker has **no timeout** — a pending prompt stays answerable for as long as
  the backend holds the call open (you can step away and come back). There is no
  "expired" state: if a turn is abandoned before the prompt is answered, the
  worker settles the held promise internally (so it doesn't leak) but broadcasts
  nothing, leaving the card in its honest pending form.
- **Fail-safe.** The Claude bridge fails *closed* (a broker/transport error → a
  deny envelope, never an unconfirmed proceed). Codex falls back to its historical
  auto-accept only when no broker is wired or the broker path throws (never hangs
  a turn).
- **Persisted** like every transcript card (docs/188 contract): the card and its
  approved/denied terminal state survive a reconnect, switch, and reload. A
  still-pending card comes back actionable after a reload — the worker holds the
  request, so the user can answer it later.
  - **Mid-turn resolution must patch the recorded card, not just the DB row.**
    Unlike bug-report (docs/164) / issue-write (docs/177) cards — which resolve
    *after* their proposing turn finalizes, so a DB-only `updateXCard` is safe —
    the permission card resolves *while the agent is still blocked mid-turn*. Its
    proposing row is still `in_progress=1`, so the next `replaceInProgress`
    rebuild re-inserts from the turn's `recordedCards` (still holding the pending
    snapshot) and **clobbers a DB-only `updatePermissionCard` patch back to
    pending** — the card reverted to its Approve/Deny variant on the next
    switch/reload. Fix: `agent_permission_resolved` patches the *recorded card*
    in place via `updateRecordedCard` (`chat-card-persistence.ts`) then
    `persistTurnInProgress`, so every rebuild and the final end-of-turn persist
    carry the terminal phase; it falls back to the DB-row `updatePermissionCard`
    only when the card isn't in this turn's recorded set. This mirrors the
    `emitOrReplaceChatCard` rationale used by docs/203's mid-turn re-review.

## Agent-agnostic seam

The canonical core is agent-neutral; each adapter only translates its native
mechanism to/from it:

| Piece | Shared (agent-neutral) | Claude | Codex |
|---|---|---|---|
| Raise a request | `PermissionBroker.request` | `mcp-permission-bridge` → `/agent-ops/permission/request` | `setPermissionRequester` injected → `handleServerRequest` |
| Surface the card | `agent_permission_request` event → `emitChatCard` → `PermissionRequestCard` | (same) | (same) |
| Resolve | `resolve_permission` WS → `/agent/permission/resolve` → `broker.resolve` | bridge's next `/await` poll returns the allow/deny envelope | JSON-RPC `{decision:"accept"\|"reject"}` |
| Persist | `permissionPrompt` `PersistedMessage` field + card store | (same) | (same) |

A future backend implements `setPermissionRequester` (or bridges to
`/agent-ops/permission/request`) and gets the card for free.

## Key files

**Worker / agent-agnostic core**
- `src/server/session/permission-broker.ts` — the broker. `openRequest()`/`poll()` (long poll + `toolUseId` idempotency), `request()` (Codex direct-await), `resolve()`/`clearPending()`.
- `src/server/session/mcp-permission-bridge.ts` — Claude's `--permission-prompt-tool`. `createPermissionBridgeServer()` factory; open + bounded `/await` poll loop with retry/backoff (Thread B).
- `src/server/session/session-worker.ts` — broker construction, `/agent-ops/permission/request` (now non-blocking) + `/agent-ops/permission/await` (Thread B) + `/agent/permission/resolve`, `permissionBridgePaths`, Codex requester injection, reject-all on teardown.
- `src/server/session/agents/claude/{adapter,process}.ts` — register `shipit-permission`; pass `--permission-prompt-tool`.
- `src/server/session/agents/codex/adapter.ts` — `setPermissionRequester` + `resolveApproval` routing (replaces unconditional auto-accept); `buildCodexPermissionInput`.
- `src/server/shared/types/agent-types.ts` — `AgentPermissionRequestEvent`, `AgentPermissionResolvedEvent`, `PermissionDecision`, `PermissionRequester`, `AgentMcpPermissionBridge`, `AgentProcess.{resolvePermission,setPermissionRequester}`.

**Orchestrator**
- `src/server/orchestrator/proxy-agent-process.ts` + `container-session-runner.ts` — `resolvePermission` → `/agent/permission/resolve`.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `agent_permission_request` → emitChatCard + `session_attention` (Thread C); `agent_permission_resolved` → patch the recorded card via `updateRecordedCard` + `persistTurnInProgress` (mid-turn clobber fix; DB-row `updatePermissionCard` fallback) + `permission_resolved` + clear attention.
- `src/server/orchestrator/chat-card-persistence.ts` — `updateRecordedCard` (patch a recorded card in place for a transition that lands within its own turn, without re-emitting it).
- `src/server/orchestrator/{session-runner,container-session-runner}.ts` — `awaitingPermissionIds` per-runner set (Thread C).
- `src/server/orchestrator/index.ts` — `session_attention` connect snapshot.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `handleAnswerQuestion` forwards the session's permission mode so a clarifying answer stays in plan mode (Thread A).
- `src/server/orchestrator/ws-handlers/permission-handlers.ts` — `handleResolvePermission` (new); dispatch in `index.ts`.
- `src/server/orchestrator/chat-history.ts` + `src/server/shared/database.ts` — `permissionPrompt` field/column + migration + `updatePermissionCard`.
- WS types: `ws-client-messages.ts` (`WsResolvePermission`), `ws-server-messages.ts` (`WsPermissionRequestCard`, `WsPermissionResolved`).

**Client**
- `src/client/stores/permission-store.ts`, `src/client/components/PermissionRequestCard.tsx` — card store + render (generic copy, Thread D).
- `src/client/hooks/message-handlers/{permission-request-card,permission-resolved}.ts` + registration.
- `src/client/components/MessageList.tsx` (render + `onResolvePermission`), `visual-elements.ts` (`CARD_MESSAGE_FIELDS`), `utils/session-data.ts` (rehydrate), `App.tsx` (send `resolve_permission`; forward permission mode on `answer_question`, Thread A).
- `src/client/hooks/useServerEvents.ts` (`session_attention` listener), `stores/session-store.ts` (`awaitingPermissionSessions`), `hooks/{useAttentionInfo,useAttentionNotifications}.ts` (Thread C).

## Degraded modes

- **Local mode** (dogfood) has no worker/broker, so the Claude bridge POST fails
  → deny. Sensitive-file edits there remain a dead-end (dev-only, already
  degraded per docs/118). Production (container) is the path that matters.
- The exact Codex reject enum (`reject` / `denied`) is inferred from the v2/v1
  schemas; verify against `codex app-server generate-json-schema` if a Codex
  deny ever misbehaves. Allow (`accept`/`approved`) is confirmed by existing tests.

## Tests

- `permission-broker.test.ts` — request/resolve/remember/no-timeout/clearPending(silent)/unknown-id; plus `openRequest`/`poll` long-poll, `toolUseId` idempotency, post-resolution poll consumption (Thread B).
- `mcp-permission-bridge.test.ts` — open→poll→allow envelope, inline pre-approval, `pending` loop, transient-failure retry, sustained-failure fail-closed, 4xx no-retry (Thread B).
- `session-worker.test.ts` (integration) — open returns requestId + await-then-resolve round-trip, and duplicate-open idempotency (Thread B).
- `ask-user-question.test.ts` (integration) — answering a question in plan mode re-pins plan mode on resume (Thread A).
- `useAttentionInfo.test.ts` — `awaitingPermission` is the highest-priority reason and outranks `isAgentRunning` (Thread C).
- `chat-history.test.ts` — round-trip + `updatePermissionCard` + the `EVERY_OPTIONAL_FIELD_MESSAGE` / `CARD_MESSAGE_FIELDS` guards.
- `process.test.ts` — `--permission-prompt-tool` presence/absence.
- `claude/mcp-writer.test.ts` — `shipit-permission` registration.
- `codex/adapter.test.ts` — requester routing (allow→accept, deny→reject), `buildCodexPermissionInput`, auto-accept fallback preserved.
- `visual-elements.test.ts` — empty-text carrier render guard.
