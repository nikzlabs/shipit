---
status: planned
priority: medium
title: Goal command
description: ShipIt-managed `/goal` per docs/132's Bucket-4 design — session metadata + per-turn agent-instructions injection, with optional Codex `thread/goal/*` augmentation when the pinned CLI supports it.
---

# Goal command

## Problem

ShipIt should support `/goal …` in chat without adding a new command surface.
Both supported CLIs ship a `/goal` slash command in their interactive TUIs,
but ShipIt does not run those TUIs — it talks to `claude -p` / streaming
stdin and to `codex app-server` over JSON-RPC. The question is which of those
backend paths can carry `/goal`, and which can't.

This doc is the implementation slice for `/goal` under the slash-command
architecture defined in [docs/132](../132-slash-commands/plan.md). It does
**not** redefine the design. It investigates what each CLI actually exposes
today, picks the implementation shape consistent with docs/132's Bucket-4
classification, and pins down the wiring.

## Relationship to docs/132

docs/132 classifies every backend slash command into five buckets and places
`/goal` in **Bucket 4 — needs native feature**:

> Stateful agent-behavior ShipIt doesn't model yet. Build a native feature:
> persist on session metadata, inject into agent context each turn.
> Backend-agnostic: it is a ShipIt construct, not a proxy of either CLI's
> `/goal`.

That decision is load-bearing for this doc. The substrate for `/goal` is the
ShipIt-managed feature described in docs/132's §"`/goal` as a native
feature": stored on the session, rendered inline in chat, injected into the
agent's context each turn via `agent-instructions.ts`. The investigation in
this doc confirms why a proxy approach won't work today (see "Why not
pass-through" below) and identifies one optional adapter-level **augmentation**
— Codex's experimental `thread/goal/*` JSON-RPC API — that ShipIt can layer
on once the pinned Codex CLI advances to a version where the API is stable.

If a future investigation reverses any of these conclusions (e.g. Claude
later starts dispatching `/goal` over stream-json input, or Codex's API
becomes a documented stable surface), docs/132's classification is the
governing doc — update it first, then this one.

## Why not pass-through

The instinctive design ("the user types `/goal X`, ShipIt forwards it to the
agent, the CLI handles it") fails on both backends, for different reasons.

### Claude: `-p` and stream-json do not dispatch `/goal`

The pinned `@anthropic-ai/claude-code@2.1.140` advertises a slash-command set
in the stream-json `init` event that includes `goal`. Despite that
advertisement, slash-command **dispatch** is gated on the interactive TUI
input path. An empirical probe — piping `/goal Make all tests pass` into
`claude -p --output-format stream-json` — confirms the CLI treats the text
as a model prompt, not as a slash command: the model echoes back something
like "Goal acknowledged: make all tests pass …" and no session-scoped Stop
hook is installed. The CLI does emit the announcements (`Goal set: …`,
`A session-scoped Stop hook is now active …`, `Goal achieved`,
`Goal cleared: …`) when run interactively, and the binary contains the
expected machinery (`tengu_goal_achieved`, `restoreGoalFromTranscript`, hook
preconditions), but none of that fires through ShipIt's spawn paths today.

`--disable-slash-commands` is **not** a useful counter-test: its help text in
2.1.140 is "Disable all skills," and the doc-138 work establishes that the
flag governs skill resolution (`/skill-name` invocation), not the broader
slash-command dispatcher. So the absence of that flag from ShipIt's spawn
args proves nothing about whether `/goal` would dispatch.

ShipIt currently uses two Claude spawn shapes
(`src/server/session/claude.ts`):

- `ClaudeProcess` (legacy, one turn per process): `claude -p <prompt>
  --output-format stream-json --verbose …`. The prompt is a positional
  argument; `--input-format` defaults to `text`.
- `StreamingClaudeProcess` (used when `useStreaming` / live steering is on,
  see docs/140): `claude --print --input-format stream-json --output-format
  stream-json …`, with user turns delivered as stream-json `user` messages.

The probe was run against the legacy path. The stream-json input path needs
the same probe before any pass-through option is reconsidered, but the
working assumption is that both behave the same way: the model sees the
text. Slash-command dispatch is a TUI affordance, not a wire-protocol one.

### Codex: TUI-only too, plus a CLI-version gap

Codex CLI has the same TUI-vs-app-server split. `/goal <objective>` works
inside the interactive TUI, where the TUI translates the user's keystrokes
into `thread/goal/set` calls on a long-lived app-server. ShipIt does not run
the TUI; it spawns `codex app-server` directly through `CodexAdapter`. The
slash command itself is not parsed on the app-server side, so a literal
`/goal …` reaches the model as text just like on Claude.

A real Codex augmentation is possible, but two upstream gates apply:

1. **CLI version.** The codex-adapter in this repo is written against the
   v2 protocol shipped in CLI 0.132.x (see comments and the explicit
   `thread.id ?? threadId` double-reads in `src/server/session/agents/codex-adapter.ts`),
   while `docker/agent-cli/package.json` currently pins `@openai/codex@0.130.0`.
   The `thread/goal/*` request methods are only visible from
   `codex app-server generate-json-schema --out DIR --experimental` (without
   `--experimental` the dump contains only the
   `ThreadGoalUpdatedNotification` / `ThreadGoalClearedNotification`
   schemas), and stability/availability on 0.130 has not been verified in
   this repo. Before the Codex augmentation in this doc is implementable,
   the CLI pin must move to a version where the API is observably present
   and the request shapes are pinned. That bump is a precondition, not part
   of this doc's scope.
2. **Feature flag.** Even on a CLI that exposes the API, requests are
   accepted only when both gates hold: `codex app-server --enable goals`
   and `initialize.capabilities.experimentalApi: true`. The `goals` feature
   is also settable via `-c features.goals=true` or `config.toml`; the
   plan picks `--enable goals` so enablement is visible in the adapter's
   spawn args rather than buried in user config.

So the substrate for both backends is the ShipIt-managed feature. The Codex
augmentation is a downstream upgrade gated on the CLI bump.

## Substrate: ShipIt-managed `/goal` (docs/132 Bucket 4)

This section is the source-of-truth wiring for what docs/132's "`/goal` as a
native feature" entails. It does not introduce new design — it pins
implementation contracts the other section needs to call into.

### Storage

Per docs/132, the goal is stored on the session. Concrete shape:

```ts
type SessionGoal = {
  text: string;            // user-supplied objective
  setAt: number;           // ms epoch
  setBy: "user";           // reserved for future system-set goals
  status: "active" | "cleared" | "achieved";
  clearedAt?: number;
};
```

Persisted alongside other session metadata in `sessions.ts`. Survives
session switches, reconnects, and `--resume` because it is not tied to the
agent process.

### Slash-command interception

In `src/server/orchestrator/ws-handlers/send-message.ts`, before
`runAgentWithMessage` dispatches the turn, the Bucket-4 handler intercepts:

| Composer input | Behavior |
|---|---|
| `/goal <text>` | Set/replace the session goal, emit a `goal_updated` WS server message, optionally proceed with `<text>` as the first turn against the new goal. |
| `/goal status` | Emit `goal_updated` with the current goal (or `goal_cleared` if none). No agent turn. |
| `/goal clear` | Clear the goal, emit `goal_cleared`. No agent turn. |
| `/goal` (no args) | Emit a help/usage system message; no agent turn. |

Pause/resume is not exposed at the substrate layer — there is no agent-side
machinery to pause against. (See "Codex augmentation" for the case where
pause/resume becomes meaningful.)

The intercept must obey the WS lifecycle discipline that governs every
other handler in `send-message.ts` (CLAUDE.md "WebSocket lifecycle MUST NOT
affect server behavior", docs/095): resolve the runner via
`resolveRunner(ctx)` (which prefers the registry over `ctx.getRunner()`),
capture `sessionId` / `sessionDir` once at handler entry, emit goal events
via `runner.emitMessage()` so they land in the turn-event buffer for
reconnecting viewers, and never invoke `runner.dispose()` from this path.

### Context injection

Each turn, `agent-instructions.ts` reads the session's active goal and
appends a compact directive to the system-prompt fragment:

```
Active goal: "<text>". Keep working until the goal is met; when you believe
it has been satisfied, say so explicitly in your reply so the user can
confirm or clear the goal.
```

This is how the goal survives the agent-process model on both backends —
each new `agent_init` event reflects the goal in the system prompt without
the orchestrator having to talk to the CLI between turns.

Cleared goals are not injected. Goal text is not duplicated into the user
turn (the model would otherwise treat it as a new request each turn).

### Achievement model

The substrate does **not** auto-detect achievement. The model is invited to
declare achievement in its reply, and the user either confirms (`/goal
clear`) or keeps going. This is a deliberate scoping decision: an
auto-detection path duplicates the Stop-hook machinery Claude has and the
runtime continuation Codex has, neither of which ShipIt would be authoring
from scratch.

If the Codex augmentation lands, that backend gets real achievement
detection through `thread/goal/updated { status: "complete" }`; the
substrate's user-confirmation model still applies on Claude.

### Rendering

- A compact inline assistant/system message when the goal is set, queried,
  or cleared, rendered in chat history.
- A session-level status chip on the chat surface while a goal is active,
  fed by a small Zustand slice (e.g. `session-store` or a new `goal-store`)
  keyed by session id so the chip persists across scrolls and reloads.
- No separate command button — per CLAUDE.md §5, the user types the
  command in chat; the chip is passive status only.

### WS message shape

Add to `src/server/shared/types/ws-server-messages.ts`:

```ts
{ type: "goal_updated"; sessionId: string; goal: SessionGoal }
{ type: "goal_cleared"; sessionId: string }
```

These ride the existing per-session WebSocket. `useMessageHandler` on the
client dispatches them into the goal store. They are **not** `AgentEvent`s
and do **not** go through `agent-listeners.ts` — they are ShipIt-side
state, not adapter-emitted.

### Composer autocomplete

`/goal` joins the Bucket-1/2/3 entries in the composer's `/`-autocomplete
menu (docs/132 §"Composer `/` autocomplete"). No change to the autocomplete
machinery beyond adding the entry.

## Codex augmentation (gated on CLI bump)

This section is an **optional** upgrade. The substrate above is the v1 ship;
this section is what becomes possible once the Codex CLI pin moves to a
version where `thread/goal/*` is observably present.

### What it adds over the substrate

- Real `thread/goal/updated` and `thread/goal/cleared` notifications from
  the app-server, replacing the substrate's user-confirmation model on
  Codex sessions.
- Token-budget and time-used telemetry on the chip
  (`tokenBudget`, `tokensUsed`, `timeUsedSeconds` from `ThreadGoal`).
- Pause / resume affordances (no separate method — `thread/goal/set` with
  `status: "paused" | "active"` is the update path; see "Verified upstream
  behavior" below).
- Runtime continuation: the CLI keeps working toward the goal across turns
  on its own, instead of needing the user to keep typing.

### Verified upstream behavior

Verified against `@openai/codex@0.130.0` as a baseline (with the caveat that
the request methods are only observable with `--experimental` schema dumps;
runtime behavior on 0.130 has not been re-probed in this repo, and the
adapter is written for 0.132 protocol shapes):

- Top-level CLI help does not list `/goal`; the command is a TUI slash
  command, not a normal CLI subcommand.
- `codex app-server generate-json-schema --out DIR` emits goal
  *notifications* (`v2/ThreadGoalUpdatedNotification.json`,
  `v2/ThreadGoalClearedNotification.json`) but no goal *request* schemas.
  The request schemas (`ThreadGoalGetParams`, `ThreadGoalSetParams`,
  `ThreadGoalClearParams`) appear only when `--experimental` is passed to
  `generate-json-schema`. Runtime gating is the same: requests are accepted
  only when `initialize.capabilities.experimentalApi: true`.
- The `goals` feature can be enabled via `app-server --enable goals` or via
  `-c features.goals=true` / `config.toml`. The plan picks `--enable goals`
  for spawn-arg visibility.

JSON-RPC methods (request shapes pinned from `--experimental` schemas;
response shapes are **not** pinned in the schema dump and must be probed
against the real CLI before the adapter relies on them — see "Response shape
caution" below):

| Method | Behavior |
|---|---|
| `thread/goal/get` | Returns the current goal or `null`. |
| `thread/goal/set` | Creates or updates the goal; emits `thread/goal/updated`. |
| `thread/goal/clear` | Clears the goal; emits `thread/goal/cleared`. |

`ThreadGoal` shape from the generated schema:

```ts
type ThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};
```

`ThreadGoalSetParams` requires only `threadId`; `objective`, `status`, and
`tokenBudget` are all optional. So `thread/goal/set` is both create and
update, and pause/resume are
`thread/goal/set { threadId, status: "paused" | "active" }`. There is no
separate `thread/goal/resume`.

**Response shape caution.** The existing adapter has burned-in evidence that
Codex's app-server nests result envelopes and changes shapes across CLI
bumps — see the explicit `thread.id ?? threadId` and `turn.id ?? turnId`
double-reads in `codex-adapter.ts` added specifically to absorb that. The
goal-method response shapes must be probed against the real CLI before the
adapter encodes a single canonical form, and the implementation should
defensively double-read nested/flat envelopes the same way.

**Mid-turn pause probe.** docs/140 documents that the app-server rejects
`turn/steer` during review and manual-compaction turns with
`ActiveTurnNotSteerable`. `/goal pause` is specifically a mid-turn
affordance (the user types it while a goal-managed turn is running).
Whether `thread/goal/set { status: "paused" }` is accepted concurrently
with an in-flight turn on the same JSON-RPC channel — and whether it
actually interrupts the running work or only takes effect at the next turn
boundary — is unstated upstream and must be probed before the augmentation
exposes a mid-turn pause affordance.

### Adapter wiring

`src/server/session/agents/codex-adapter.ts` gains:

- Spawn args: `["app-server", "--enable", "goals"]`. The flag is added only
  when goals are enabled for the session (a session setting; non-goal
  Codex sessions keep their current spawn args).
- `initialize` payload: `capabilities: { experimentalApi: true }`.
- Methods: `getGoal()`, `setGoal({ objective?, status?, tokenBudget? })`,
  `clearGoal()`. Each calls `sendRequest()` with `threadId: this.threadId`
  on the live app-server channel. If `this.threadId` is null (no
  initialized thread), return a visible error rather than implicitly
  creating one.
- Notification translation: `thread/goal/updated` → a new `agent_goal_updated`
  variant on `AgentEvent`; `thread/goal/cleared` → `agent_goal_cleared`.
  Precedent for this kind of sideband event is `agent_rate_limits` in the
  current `AgentEvent` union (`src/server/shared/types/agent-types.ts`) —
  it rides `AgentEvent` but is short-circuited out of the chat-message
  accumulator in `src/server/orchestrator/ws-handlers/agent-listeners.ts`.

### Process lifetime (the critical change)

`CodexAdapter.handleTurnCompleted` currently calls `this.kill()` after every
`turn/completed`. That made sense when the adapter was modeled on the
one-shot-per-turn legacy `ClaudeProcess` shape, but it cannot coexist with
Codex's goal-managed continuation, which keeps the app-server running across
turns. Under `--enable goals`, the adapter must keep the process alive
across turns, mirroring `StreamingClaudeProcess`. Concretely:

- Suppress the post-`turn/completed` kill when the session was spawned with
  `--enable goals`.
- Reset per-turn bookkeeping (`streamedAgentItems`, `lastTokenUsage`,
  in-flight `pendingRequests`) at the start of each new `turn/start` rather
  than letting it be released by process death.
- `agent-listeners.ts:wireAgentListeners` is per-turn today and gates
  "Agent process started" on a local `hasLoggedAgentStart` flag and
  captures `requestedPermissionMode` / `turnModel` at turn start. Decide
  per turn whether to rewire listeners (mirroring the
  `StreamingClaudeProcess` post-result reuse) or hold them across turns;
  either way the wiring must be explicit, not implicit.
- `session-worker.ts:wireAgentEvents` nulls `this.agent` on `done`. A
  persistent Codex never emits `done` at `turn/completed` under the new
  model — only `kill()` does. Disposal, idle eviction (docs/127's
  `restartAgent` path), and the orchestrator's `verifyRunningState()`
  recovery path (which assumes the worker has a process iff a turn is in
  flight) all need updating so they don't assume "no turn in flight ⇒ no
  process."
- Crash recovery: if the long-lived app-server dies between turns, the
  next `/goal` op should surface "no agent" instead of silently respawning.
  Restart is a separate orchestrator action.

These changes are gated on `--enable goals`, so non-goal Codex sessions are
unaffected.

### Container-boundary proxy

Production ShipIt talks to session containers over HTTP. Mirror the existing
agent proxy chain (`session-worker.ts` already exposes `/agent/start`,
`/agent/stdin`, `/agent/message`, `/agent/interrupt`, `/agent/kill`,
`/agent/status` — all operating on `this.agent`):

- `POST /agent/goal` on the worker with body
  `{ op: "get" | "set" | "clear", goal?: …, status?: … }`. Operates on
  `this.agent`, which under the lifetime change above is the long-lived
  process.
- `worker-http.ts` helper.
- `ContainerSessionRunner` method.
- `ProxyAgentProcess` method.
- An `AgentProcess` interface addition (`getGoal` / `setGoal` / `clearGoal`)
  guarded by an `AgentCapabilities.supportsGoals` flag.

**Capability resolution.** docs/140 (steering) sets the precedent:
`supportsGoals` (and any other new capability) must be resolved via the
**shared `agent-registry`**, not via `ProxyAgentProcess.capabilities`. The
proxy's `capabilities` field is a deliberately conservative hardcoded
default (`proxy-agent-process.ts:60-74`) that returns `false` for advanced
capabilities to avoid pretending the remote agent supports things the proxy
shim can't introspect. Gating on `agent.capabilities.supportsGoals` would
be silently `false` in production container mode while passing every
local-mode unit test.

### Substrate / augmentation overlap

When Codex augmentation is on, the substrate's session-stored goal is
sourced from `thread/goal/updated` notifications rather than from the
intercept handler. The intercept handler still owns the user input:

| Composer input | With augmentation off (substrate) | With augmentation on (Codex) |
|---|---|---|
| `/goal <text>` | Write to session metadata, emit `goal_updated`, optionally start turn with `<text>`. | Call `thread/goal/set { objective: text, status: "active" }`. The `thread/goal/updated` notification feeds the session store and emits `goal_updated`. |
| `/goal status` | Read session metadata. | Call `thread/goal/get`, render. |
| `/goal pause` (augmentation only) | n/a — substrate has no pause. | Call `thread/goal/set { status: "paused" }`, pending the mid-turn probe above. |
| `/goal resume` (augmentation only) | n/a. | Call `thread/goal/set { status: "active" }`. |
| `/goal clear` | Update session metadata, emit `goal_cleared`. | Call `thread/goal/clear`; the notification clears the store. |

The session-store goal slice is the single source of truth for the client
chip in both cases; the augmentation just changes who writes to it.

## Claude: no augmentation

There is no Claude-side augmentation in this doc. The CLI's `/goal`
machinery is real (session-scoped Stop hook installed by the slash command,
condition-met detection in the hook, `Goal achieved` announcement,
transcript-backed restore on resume), but the dispatcher that wires it up
runs only on TUI input. Without that, ShipIt has no programmatic entry
point — there is no `claude goal` subcommand, no JSON-RPC method, and no
documented stream-json envelope that triggers the slash-command processor.

Claude sessions therefore run the substrate alone. The chip shows the
ShipIt-managed goal; the agent receives the goal as a system-prompt
fragment each turn; the user clears it manually.

If a future Claude CLI exposes `/goal` over stream-json or via a
non-interactive subcommand, this doc's Claude section gets revisited (and
docs/132 should be revisited first to confirm the Bucket-4 classification
still holds).

## Tests

### Substrate (both backends)

- Persistence: setting and clearing a goal mutates session metadata; the
  goal survives an orchestrator restart.
- Intercept: `/goal …`, `/goal status`, `/goal clear`, and bare `/goal`
  each route to the substrate handler and do not start an agent turn
  (except `/goal <text>` when the substrate is configured to also kick a
  turn off with the text).
- Context injection: `agent-instructions.ts` includes the active goal in
  the per-turn system-prompt fragment for both Codex and Claude sessions;
  a cleared goal does not appear.
- WS messages: `goal_updated` and `goal_cleared` round-trip through the
  per-session WS to a fake client.
- Rendering: chip renders active / cleared states; chip is passive (no
  command button).

### Codex augmentation

- Spawn args under `--enable goals` include the flag; non-goal sessions
  don't get it.
- `initialize` payload includes `capabilities.experimentalApi: true`.
- `thread/goal/updated` and `thread/goal/cleared` notifications translate
  to `agent_goal_updated` / `agent_goal_cleared` events.
- `agent-listeners.ts` short-circuits goal events out of the chat-message
  accumulator (mirroring `agent_rate_limits`).
- Goal request methods send the expected JSON-RPC payloads and defensively
  read both nested and flat response envelopes (per the
  `thread.id ?? threadId` / `turn.id ?? turnId` precedent in
  `codex-adapter.ts`).
- Process lifetime: under `--enable goals`, the adapter does **not** kill
  the app-server at `turn/completed`; per-turn bookkeeping
  (`streamedAgentItems`, `lastTokenUsage`, `pendingRequests`) is reset on
  the next `turn/start`; `agent-listeners.ts` rewiring is explicit.
- Capability gating: `/goal` augmentation activates from
  `agent-registry.ts`, not from `ProxyAgentProcess.capabilities` (regress
  the docs/140 trap).

### Mid-turn pause probe (Codex)

- Live probe (not a unit test): with a goal-managed turn in flight,
  `thread/goal/set { status: "paused" }` either (a) interrupts the running
  work, (b) is queued until the next turn boundary, or (c) is rejected
  with `ActiveTurnNotSteerable` or similar. Whichever it is, the
  composer's `/goal pause` UX is built against that observed behavior, not
  against an assumption.

### Claude pass-through regression

- A literal `/goal …` typed in a Claude session reaches the substrate
  handler (which intercepts it) — it never reaches `claude -p` unmodified
  as a model prompt. This regression-tests the docs/132 contract on the
  empirical evidence that `claude -p` would otherwise treat the text as
  prose.

## Error handling

Substrate:

- Empty goal text → emit a usage system message; do not write metadata.
- `/goal status` with no active goal → emit `goal_cleared` with the
  current empty state; do not error.

Codex augmentation:

- App-server rejects `--enable goals` (CLI too old): surface the adapter
  error, mark `supportsGoals: false` for the session, and fall back to the
  substrate transparently.
- App-server returns "goals feature is disabled": configuration bug in
  the adapter — log the raw response.
- `thread/goal/set` fails because the thread hasn't been created: surface
  the error inline; the substrate's session-stored goal is already
  persisted, so the chip still shows the goal even though continuation
  hasn't started.
- Persistent app-server crashes mid-session: next goal op surfaces
  "no agent"; restart is a separate orchestrator action (see "Process
  lifetime" above).

## Key files

Substrate (docs/132 Bucket-4 wiring):

- `src/server/orchestrator/sessions.ts` — persist `SessionGoal` on session
  metadata.
- `src/server/orchestrator/agent-instructions.ts` — per-turn injection.
- `src/server/orchestrator/ws-handlers/send-message.ts` — Bucket-4
  intercept for `/goal …`. Must follow the WS lifecycle discipline
  (`resolveRunner`, capture sessionId/sessionDir at entry,
  `runner.emitMessage()` for events).
- `src/server/shared/types/ws-server-messages.ts` — `goal_updated`,
  `goal_cleared` server-message variants.
- `src/client/components/MessageList.tsx` or adjacent — inline message
  rendering for set/clear/status.
- A new client store slice (e.g. `goal-store.ts`) plus chip wiring on the
  chat surface.
- `src/client/components/MessageInput.tsx`, `message-editor.tsx` — `/goal`
  entry in the composer `/`-autocomplete (the menu work itself is owned
  by docs/132 / docs/138).

Codex augmentation:

- `src/server/session/agents/codex-adapter.ts` — spawn arg, initialize
  capability, goal methods, notification translation, lifetime change.
- `src/server/session/agents/codex-adapter.test.ts` — adapter tests.
- `src/server/shared/types/agent-types.ts` — `agent_goal_updated` /
  `agent_goal_cleared` variants on `AgentEvent`; `supportsGoals` capability.
- `src/server/shared/agent-registry.ts` — capability resolution (per
  docs/140).
- `src/server/session/session-worker.ts` — `POST /agent/goal` endpoint.
- `src/server/orchestrator/worker-http.ts` — orchestrator → worker helper.
- `src/server/orchestrator/proxy-agent-process.ts` — proxy delegation
  (and the docs/140 precedent that capability resolution does **not** go
  through this).
- `src/server/orchestrator/container-session-runner.ts` — runner method
  exposed to WS handlers.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — short-circuit
  goal events out of chat-message grouping (mirroring `agent_rate_limits`).
- `docker/agent-cli/package.json` — Codex pin bump precondition for the
  augmentation; coordinated with Renovate (see CLAUDE.md "Dependency
  policy").

Related plans:

- [docs/132-slash-commands/plan.md](../132-slash-commands/plan.md) —
  governing classification; this doc is the Bucket-4 slice for `/goal`.
- [docs/138-classifier-permission-mode/plan.md](../138-classifier-permission-mode/plan.md)
  and [docs/140-live-steering/plan.md](../140-live-steering/plan.md) —
  precedent for capability resolution via the shared registry and for
  persistent-process lifetime management.
- [docs/129-stop-hook-pr-enforcement/plan.md](../129-stop-hook-pr-enforcement/plan.md)
  — owns the managed auto-PR Stop hook in `docker/agent-hooks/managed-settings.json`.
  Relevant context only: the hook is self-gated on `SHIPIT_AUTO_CREATE_PR=1`
  and is inert for sessions where `autoCreatePr` is false, so it does not
  interact with the substrate's `/goal` even on Claude.

## Non-goals

- No command palette entry, toolbar button, or quick action for `/goal` —
  it is a chat input only, per CLAUDE.md §5.
- No pass-through of the text `/goal …` to either CLI's process. Both CLIs
  treat it as a model prompt under ShipIt's spawn paths; the intercept
  handles it.
- No ShipIt-side achievement detection on the substrate. The model
  declares; the user confirms.
- No Claude augmentation. The CLI exposes no programmatic entry point to
  its native `/goal`; the substrate is the only path.
- No Codex augmentation before the CLI pin advances to a version where
  `thread/goal/*` is observably present and the response shapes can be
  probed. The substrate ships first; the augmentation lands as a follow-up
  in the same doc once the pin moves.
- No mimicry of either CLI's TUI footer. ShipIt renders goal state in its
  own chat/session UI.
