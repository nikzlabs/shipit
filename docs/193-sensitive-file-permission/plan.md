---
issue: planning#114
description: Surface an agent-agnostic approve/deny card when an agent's edit to a sensitive file (or escalated action) is gated, so the user can grant it.
---

# 193 — Sensitive-file permission prompt (planning#114)

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
  the user never saw the gate at all. A later implementation routed every
  native approval RPC through the broker, but Codex can emit those RPCs for
  ordinary commands and workspace changes even under `approvalPolicy: "never"`,
  causing repeated approval cards after worker recreation. ShipIt now uses the
  v1/v2 payload's explicit extra-access fields (`reason`, `grantRoot`, network
  context, or policy amendments) as the broker boundary; requests without such
  evidence are immediately accepted inside the isolated worker container.

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
  routes native requests to the broker when their payload explicitly requests
  extra filesystem, network, or execution-policy access; routine v1/v2 command
  and workspace-change requests receive the native allow decision directly.
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
- **No ShipIt-imposed deadline, but no card outlives the agent's wait.** A
  permission decision is the user's, so the broker has **no timeout** — a
  pending prompt stays answerable for as long as the backend holds the call open.
  The backend can stop waiting on its own, though, and then the card becomes
  **Denied** and the session stops asking for attention: the worker settles the
  request as deny and broadcasts `agent_permission_resolved`, which the
  orchestrator handles exactly like a user's Deny. Three signals, one per way the
  wait ends:
  - **The gated call gets a result** (`PermissionBroker.endToolUse`, called by
    `agent-controller.ts` for every `tool_result` id). This is the Claude
    timeout: the CLI ends an MCP call that sends no response or progress for
    `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (30 min for stdio), emits an error
    `tool_result` for the gated `tool_use`, and **never sends
    `notifications/cancelled`** — verified against Claude Code 2.1.284 with a
    never-answering `--permission-prompt-tool`. The bridge therefore kept
    polling, and the card stayed Approve/Deny forever, holding the session in
    "Needs your approval". Stop takes the same path: a streaming-mode interrupt
    also yields the gated call's `tool_result` (verified the same way).
  - **Codex clears its own request** (`serverRequest/resolved` for a JSON-RPC id
    still awaiting the broker). The Codex handler aborts the `signal` it passed
    in `PermissionRequestInput`, and does not answer a request Codex already
    dropped.
  - **The agent process exits** (`clearPending`, on `done`/`error`).

  A request the user already answered is never re-announced. The broker is
  shared by successive agent processes, so an exit clears it only while the
  exiting process still holds the slot; a kill clears it at the kill, before a
  replacement can open a request that a late exit event would otherwise deny.
  **The orchestrator denies what the worker cannot.** A dead worker cannot
  broadcast, and a worker still on an image from before this rule stays silent
  on exit. So `permission-cards.ts` `denyAbandonedPermissionCards` gives every
  id still in `runner.awaitingPermissionIds` the same transition as a user's
  Deny, at each place the orchestrator learns the agent is gone: the agent
  process's exit (`turn-executor.ts`, a `postTurnStep` so the commit cannot be
  skipped) and error (`agent-listeners.ts`), both only while that process still
  holds the runner's agent slot; a turn the worker reports as having no agent
  (`turn_abandoned`, wired in `runner-registry-factory.ts`, which also finalizes
  that turn's rows — nothing else does, and the next turn's `replaceInProgress`
  would delete the denied card with them); and a container exit
  (`handleContainerExited`, before the partial turn is saved). Each call is
  guarded so a failed write cannot skip the commit or the queue release that
  follows it. A runner
  disposed with `preserveAgent` at shutdown is deliberately not a trigger: its
  worker lives on for restart adoption. Every transition — the user's answer,
  the worker's deny, this backstop — goes through `settlePermissionCard`, which
  uses `persistCardTransition`, so a card settled after its turn finished is
  patched in its row instead of rewriting that finished turn as in-progress.

  **Saved cards are checked against the worker when a runner first reaches it.**
  The backstop knows a request only through the in-memory
  `awaitingPermissionIds`, which an orchestrator restart empties, and a new
  container holds none of its predecessor's requests. So `/agent/status` reports
  `pendingPermissionIds` (the broker's unanswered requests), and
  `ContainerSessionRunner` `reconcileSavedPermissionCards` uses the status reading
  that turn adoption already made — one reading, so adoption and this check
  cannot disagree — before the first SSE connect, so no card can be saved while it
  runs. A runner whose container is still being created uses an empty list: that
  container has never held a request. Then `reconcilePermissionCards` compares
  the list with the session's saved pending cards (`pendingPermissionRequestIds`):
  a card the worker still waits on goes back into `awaitingPermissionIds` and
  re-sends the attention signal, so the backstop covers a worker that dies later;
  every other card is denied through `settlePermissionCard`. Without an agent in
  the runner (no turn was adopted), nothing can relay the user's answer or the
  worker's result, so every saved card is denied. When the runner has no running
  turn, the in-progress rows are finalized, for the same reason as
  `turn_abandoned`. The check is skipped when the status probe fails or the worker
  image predates the field; the next runner or container checks again.

  Cards left pending by builds before this rule are denied once by a database
  migration (`STALE_PERMISSION_CARD_MIGRATION`) — only those older than Claude's
  30-minute idle timeout, since a session worker outlives an orchestrator
  restart and a younger card may still be answerable.
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
    switch/reload. Fix: `settlePermissionCard` patches the *recorded card* in
    place and rewrites the in-progress turn (`persistCardTransition`,
    `chat-card-persistence.ts`), so every rebuild and the final end-of-turn
    persist carry the terminal phase; it falls back to the DB-row
    `updatePermissionCard` when the turn no longer owns in-progress rows or the
    card isn't in its recorded set. This mirrors the `emitOrReplaceChatCard`
    rationale used by docs/203's mid-turn re-review.
  - **A mid-turn card must also advance the turn-event replay cursor (the
    "pending card vanishes on switch" bug, planning#114).** `emitChatCard` persists a
    snapshot of the turn-so-far the instant the card fires — but a gated tool's
    `agent_assistant` event sits *unpersisted* in the turn-event buffer
    (`lastPersistedBufferIndex` only advanced at tool-result / agent_result
    boundaries). So the snapshot sat **ahead** of the buffer cursor. On a session
    switch / WS reconnect, the orchestrator replays `buffer.slice(cursor)` *on
    top of* that snapshot; the buffered pre-card `agent_assistant` then merges
    into the card's carrier message — which `loadSessionHistory` marked
    `streaming: true` (in-progress → streaming) — and the client's streaming
    merge (`agent-event.ts`) rebuilds the message from a fixed field set,
    **dropping `permissionPrompt`**. The card showed only after the agent
    *stopped* (interrupt clears the buffer). Fix (two layers): `emitChatCard`
    advances `lastPersistedBufferIndex` past the buffer after persisting — the
    same thing the tool-result boundary does — so no buffered event overlaps the
    snapshot; and the client never treats a card-carrying message as a merge
    target (it falls to close-and-append, which preserves the card via `...m`).
    This protects **every** mid-turn card, not just permission.

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

## What the card shows, and what the card must not break

Two things the live production build got wrong, both fixed after the fact.

**The gated call is readable in full.** The card's `summary` is a clipped
one-liner (`describePermissionRequest`, ~100 chars), and for a `sed -i` the
clip lands exactly on the target path — the part that explains why the backend
gated the call, leaving the user approving something they can't read. The
broker now also emits `details`: the raw `command` when there is one (both
backends supply it), otherwise the pretty-printed tool input, bounded by
`PERMISSION_DETAILS_CHARS` (4 000) so a `Write`'s file body can't push
megabytes through the WS card and the persisted `permission_prompt` blob. It
rides the existing card payload end to end (event → `emitChatCard` →
`PersistedPermissionRequest` → permission store) and renders behind a collapsed
disclosure on the **pending** card only — once resolved, the tool's own
transcript row carries the full command and its output.

`details` is omitted whenever there is nothing left to disclose, which is *most*
requests — a toggle expanding to what the card already shows is noise, and
persisted noise at that. Two cases, both the common shape rather than an edge:
the collapsed summary already contains the whole body unclipped (`Bash: ls` over
`ls`), or the input's only content is the path the card renders on its own line
(`apply_patch` with a bare `file_path`). An exact `details !== summary` check
caught neither, since the summary is prefixed with the tool name.

Still NOT asserted: a *reason*. The CLI
supplies only `{tool_name, input, tool_use_id}`, so the generic copy stands
(Thread D).

**A card must not orphan the gated tool's result.** The card is appended as its
own `role: "assistant"` message, so it sits between the message holding the
gated `tool_use` and that tool's later `tool_result`. The client's
`agent_tool_result` branch used to attach results to `prev[prev.length - 1]`
blindly, while `buildVisualElements` pairs a tool with its result strictly
WITHIN one message — so the result landed on the card, the tool row resolved
`result === undefined`, and once streaming ended `isInspectable` was false: no
`onClick`, no "Show output", the command and output reachable only by reloading
the page (the server's `attachToolResultsToGroup` was always correct, which is
why a reload repaired it). Results now route to the message whose `toolUse`
holds the matching id, falling back to the last assistant message — skipping
terminal card carriers, the same `isTerminalTranscriptEntry` predicate the
streaming-text merge branch uses. The two branches disagreeing was the bug; any
mid-turn card in that position reproduced it, not just this one.

## Key files

**Worker / agent-agnostic core**
- `src/server/session/permission-broker.ts` — the broker. `openRequest()`/`poll()` (long poll + `toolUseId` idempotency), `request()` (Codex direct-await, withdrawn by its `signal`), `resolve()`, and the abandoned-request deny: `endToolUse()`/`clearPending()`.
- `src/server/session/agent-controller.ts` — `wireAgentEvents` ends the request for every `tool_result` id, and clears pending requests when the agent exits. `/agent/status` reports the broker's `unansweredIds` as `pendingPermissionIds`.
- `src/server/session/mcp-permission-bridge.ts` — Claude's `--permission-prompt-tool`. `createPermissionBridgeServer()` factory; open + bounded `/await` poll loop with retry/backoff (Thread B).
- `src/server/session/session-worker.ts` — broker construction, `/agent-ops/permission/request` (now non-blocking) + `/agent-ops/permission/await` (Thread B) + `/agent/permission/resolve`, `permissionBridgePaths`, Codex requester injection, reject-all on teardown.
- `src/server/session/agents/claude/{adapter,process}.ts` — register `shipit-permission`; pass `--permission-prompt-tool`.
- `src/server/session/agents/codex/adapter.ts` — `setPermissionRequester` + `resolveApproval` routing (replaces unconditional auto-accept); `buildCodexPermissionInput`. `codex-event-handler.ts` withdraws a request on `serverRequest/resolved`.
- `src/server/shared/types/agent-types.ts` — `AgentPermissionRequestEvent`, `AgentPermissionResolvedEvent`, `PermissionDecision`, `PermissionRequester`, `AgentMcpPermissionBridge`, `AgentProcess.{resolvePermission,setPermissionRequester}`.

**Orchestrator**
- `src/server/orchestrator/proxy-agent-process.ts` + `container-session-runner.ts` — `resolvePermission` → `/agent/permission/resolve`.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `agent_permission_request` → emitChatCard + `session_attention` (Thread C); `agent_permission_resolved` → `settlePermissionCard`; an agent `error` denies the cards its process left.
- `src/server/orchestrator/permission-cards.ts` — `settlePermissionCard` (patch the recorded card mid-turn via `persistCardTransition`, else the DB row; `permission_resolved`; clear attention with the last id) and `denyAbandonedPermissionCards`, called from `turn-executor.ts` (exit), `runner-registry-factory.ts` (`turn_abandoned`) and `startup-tasks.ts` (`handleContainerExited`); `reconcilePermissionCards`, called from `container-session-runner.ts` `reconcileSavedPermissionCards`.
- `src/server/orchestrator/chat-card-persistence.ts` — `updateRecordedCard` (patch a recorded card in place for a transition that lands within its own turn, without re-emitting it); `emitChatCard` advances `lastPersistedBufferIndex` past the buffer after persisting (the switch/reconnect overlap fix that kept a pending card from vanishing).
- `src/client/hooks/message-handlers/agent-event.ts` — the streaming-assistant merge excludes card-carrying messages (`CARD_MESSAGE_FIELDS`) as merge targets, so a replayed event can't rebuild a card message and drop its card field; `agent_tool_result` routes each result to the message whose `toolUse` holds the id (`indexOfToolUse` / `fallbackResultTarget`), so a card between a call and its result can't orphan the tool row.
- `src/server/orchestrator/{session-runner,container-session-runner}.ts` — `awaitingPermissionIds` per-runner set (Thread C).
- `src/server/orchestrator/index.ts` — `session_attention` connect snapshot.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `handleAnswerQuestion` forwards the session's permission mode so a clarifying answer stays in plan mode (Thread A).
- `src/server/orchestrator/ws-handlers/permission-handlers.ts` — `handleResolvePermission` (new); dispatch in `index.ts`.
- `src/server/orchestrator/chat-history.ts` + `src/server/shared/database.ts` — `permissionPrompt` field/column + migration + `updatePermissionCard` + `pendingPermissionRequestIds`.
- WS types: `ws-client-messages.ts` (`WsResolvePermission`), `ws-server-messages.ts` (`WsPermissionRequestCard`, `WsPermissionResolved`).

**Client**
- `src/client/stores/permission-store.ts`, `src/client/components/PermissionRequestCard.tsx` — card store + render (generic copy, Thread D; `details` disclosure on the pending card).
- `src/client/hooks/message-handlers/{permission-request-card,permission-resolved}.ts` + registration.
- `src/client/components/MessageList.tsx` (render + `onResolvePermission`), `visual-elements.ts` (`CARD_MESSAGE_FIELDS`), `utils/session-data.ts` (rehydrate), `App.tsx` (send `resolve_permission`; forward permission mode on `answer_question`, Thread A).
- `src/client/hooks/useServerEvents.ts` (`session_attention` listener), `stores/session-store.ts` (`awaitingPermissionSessions`), `hooks/{useAttentionInfo,useAttentionNotifications}.ts` (Thread C).

## Degraded modes

- **Local mode** (dogfood) has no worker/broker, so the Claude bridge POST fails
  → deny. Sensitive-file edits there remain a dead-end (dev-only, already
  degraded per docs/118). Production (container) is the path that matters.
- The Codex deny enum is confirmed against `codex app-server generate-json-schema`
  (planning#114): v2 deny is `"decline"` (deny + continue the turn; `"cancel"` would
  also interrupt — not our semantics) and v1 deny is `"denied"`. An earlier
  inferred value `"reject"` was stale — the schema defines no such variant — and
  is fixed in `codex-event-handler.ts`. Allow (`accept`/`approved`) is confirmed
  by existing tests.

## Tests

- `permission-broker.test.ts` — request/resolve/remember/no-timeout/unknown-id; plus `openRequest`/`poll` long-poll, `toolUseId` idempotency, post-resolution poll consumption (Thread B); the abandoned-request deny from `endToolUse`, `clearPending` and an aborted `signal`, and that none re-announces an answered request.
- `agent-controller.test.ts` — a gated call's `tool_result` (the Claude idle-timeout shape) and an agent exit each broadcast the deny; `/agent/status` reports the unanswered ids.
- `codex/adapter.test.ts` — `serverRequest/resolved` aborts the pending request and sends no response.
- `database.test.ts` — the migration denies legacy pending cards and leaves answered cards and unreadable JSON alone.
- `permission-cards.test.ts` — mid-turn vs. finished-turn persistence, attention cleared only with the last id, the abandoned-card deny, and the reconcile against the worker's live ids.
- `restart-turn-adoption.test.ts` (integration) — after a restart, a saved card the adopted worker still waits on stays pending and needs attention, an older one is denied, and a card no adopted turn can relay, or one from a replaced container, is denied.
- `agent-listeners.test.ts` — an agent error denies its cards; a replaced process's late error does not; the worker's deny settles the card.
- `turn-crash-commit.test.ts` — an exit with a pending card denies it and still commits; `runner-registry-factory.test.ts` — `turn_abandoned`; `container-exit-logging.test.ts` — a container exit denies the card and saves the turn with it denied.
- `mcp-permission-bridge.test.ts` — open→poll→allow envelope, inline pre-approval, `pending` loop, transient-failure retry, sustained-failure fail-closed, 4xx no-retry (Thread B).
- `session-worker.test.ts` (integration) — open returns requestId + await-then-resolve round-trip, and duplicate-open idempotency (Thread B).
- `ask-user-question.test.ts` (integration) — answering a question in plan mode re-pins plan mode on resume (Thread A).
- `useAttentionInfo.test.ts` — `awaitingPermission` is the highest-priority reason and outranks `isAgentRunning` (Thread C).
- `chat-history.test.ts` — round-trip + `updatePermissionCard` + the `EVERY_OPTIONAL_FIELD_MESSAGE` / `CARD_MESSAGE_FIELDS` guards.
- `process.test.ts` — `--permission-prompt-tool` presence/absence.
- `claude/mcp-writer.test.ts` — `shipit-permission` registration.
- `codex/adapter.test.ts` — requester routing (allow→accept, deny→reject), `buildCodexPermissionInput`, auto-accept fallback preserved.
- `visual-elements.test.ts` — empty-text carrier render guard.
- `agent-event.test.ts` — a tool result routes to the message that issued the call: the gated tool pairs with its result **live, with no reload**, when a permission card lands in between; per-caller routing across several open messages; the no-match fallback, which skips a terminal card row.
- `PermissionRequestCard.test.tsx` — the `details` disclosure is collapsed by default, expands to the full command, and is absent when the broker had nothing beyond the summary.
- `permission-broker.test.ts` — `describePermissionDetails` (raw command whole, JSON fallback, `PERMISSION_DETAILS_CHARS` bound) and the broadcast carrying `details` alongside the clipped `summary`.
