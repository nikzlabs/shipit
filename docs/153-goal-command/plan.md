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

The probe was run against the legacy path. The stream-json input path
(used by live-steering sessions today, docs/140) has **not** been probed.
If a future probe shows it dispatches `/goal`, this doc gets revisited —
Claude augmentation would become possible on streaming sessions, at which
point docs/132's Bucket-4 classification for `/goal` should be re-evaluated
before adding a Claude proxy path. Until that probe runs, the working
position is "Claude has no augmentation path," which is correct under the
substrate even if a future stream-json probe widens the option.

### Codex: TUI-only too, plus a CLI-version gap

Codex CLI has the same TUI-vs-app-server split. `/goal <objective>` works
inside the interactive TUI, where the TUI translates the user's keystrokes
into `thread/goal/set` calls on a long-lived app-server. ShipIt does not run
the TUI; it spawns `codex app-server` directly through `CodexAdapter`. The
slash command itself is not parsed on the app-server side, so a literal
`/goal …` reaches the model as text just like on Claude.

A real Codex augmentation is possible. Two upstream gates apply, and one
runtime question is open:

1. **API surface is present on the pinned CLI.** Against
   `@openai/codex@0.130.0` (the version `docker/agent-cli/package.json`
   currently pins), `app-server --help` lists `--enable <FEATURE>`, and
   `codex app-server generate-json-schema --out DIR --experimental` emits
   all six `ThreadGoalGet/Set/Clear{Params,Response}` schemas plus the two
   notification schemas. Without `--experimental` the dump contains only
   the two notification schemas. So the API *shape* is observable on the
   pinned CLI; what is **not yet probed in this repo** is the runtime path:
   does the 0.130 app-server actually accept `--enable goals`,
   `experimentalApi: true`, and the three request methods, and emit the
   notifications? That probe is the substantive precondition for the
   augmentation in this doc — not a CLI version bump. If the probe fails
   on 0.130, the precondition becomes "bump to the first 0.13x where it
   succeeds," coordinated through Renovate per CLAUDE.md's Dependency
   policy.
2. **Feature flag at runtime.** Requests are accepted only when both gates
   hold: `codex app-server --enable goals` and
   `initialize.capabilities.experimentalApi: true`. The `goals` feature is
   also settable via `-c features.goals=true` or `config.toml`; the plan
   picks `--enable goals` so enablement is visible in the adapter's spawn
   args rather than buried in user config.

So the substrate for both backends is the ShipIt-managed feature. The Codex
augmentation is a downstream upgrade gated on the runtime probe on 0.130
(and, if that probe fails, on a Renovate bump to the first version where it
passes).

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

In `src/server/orchestrator/ws-handlers/send-message.ts`, the Bucket-4
handler intercepts **before** the `runnerForQueue?.running` check at
send-message.ts:94 — not after. Today every composer input with
`runner.running === true` is routed to either live steering
(`sendUserMessage`) or `runner.dispatch` (which enqueues). `/goal …` must
not enter either path: a goal op is metadata/control, not a turn, and it
must run synchronously while a turn is in flight (most acutely `/goal
pause`, which is meaningless if it lands after the turn it was supposed to
pause). The intercept is the first thing the handler does after image
validation, and `/goal pause` / `/goal resume` are explicitly allowed to
fire mid-turn — subject to the mid-turn pause probe below.

The substrate handles every command; when the session has Codex
augmentation active, the handler routes through the adapter's goal methods
instead of writing session metadata directly.

| Composer input | Substrate behavior | With Codex augmentation active |
|---|---|---|
| `/goal <text>` | Write `SessionGoal` to session metadata; emit `goal_updated`; optionally proceed with `<text>` as the first turn. | **Write `SessionGoal` to session metadata first** (so the orchestrator-restart-between-ack-and-notification window doesn't lose the goal); then call `setGoal({ objective: text, status: "active" })`. The `thread/goal/updated` notification handler re-applies state via `runner.applyGoalEvent` — idempotent against the metadata that's already there, but also the path that surfaces budget/time telemetry. |
| `/goal status` | Read session metadata, emit `goal_status` (the query-response variant — see "WS message shape" below). | Call `getGoal()`; reconcile result with session metadata per "Source-of-truth reconciliation"; emit `goal_status`. |
| `/goal clear` | Update session metadata to `status: "cleared"`; emit `goal_cleared`. | **Update session metadata first** (same persistence-window rationale); then call `clearGoal()`. The notification handler is idempotent. |
| `/goal pause` | Not exposed — autocomplete hides it. | Call `setGoal({ status: "paused" })`, pending the mid-turn probe below. Session metadata stays `active` per the status-mapping table. |
| `/goal resume` | Not exposed — autocomplete hides it. | Call `setGoal({ status: "active" })`. Session metadata already `active`; no write. |
| `/goal` (no args) | Emit a help/usage system message. | Same. |

The "write-first, RPC-second" ordering on the augmentation path closes
a narrow persistence window: between a `thread/goal/set` request ack
and the `thread/goal/updated` notification arriving back, anything that
relies on the metadata (orchestrator restart, container eviction,
SessionInfo bootstrap from a freshly attached viewer) would otherwise
see stale state. With the substrate writing first and the notification
handler reconciling, both paths converge on the same persisted state at
the same point in the flow.

The intercept must obey the WS lifecycle discipline that governs every
other handler in `send-message.ts` (CLAUDE.md "WebSocket lifecycle MUST NOT
affect server behavior", docs/095): resolve the runner via
`resolveRunner(ctx)` (which prefers the registry over `ctx.getRunner()`),
capture `sessionId` / `sessionDir` once at handler entry, emit goal events
via `runner.emitMessage()` so they land in the turn-event buffer for
reconnecting viewers, and never invoke `runner.dispose()` from this path.

### Context injection

The goal is injected as a **prelude on the user turn**, not as part of the
cached system prompt. Concretely: `assembleAgentPrompt` in
`src/server/orchestrator/ws-handlers/agent-execution.ts` (the function that
already composes `userText`, `fileContext`, and `imageContext` into the
prompt fed to the adapter) gains a `goalContext` strand whose position
depends on whether the turn is a slash-invocation:

- **Non-slash turn** (the common case): order becomes
  `[goalContext, imageContext, fileContext, userText]`. The prelude reads:

  ```
  [Active goal for this session: "<text>". Treat each turn as one step toward
  this goal: do the per-turn work the user asks for, including the normal
  turn-end actions ShipIt requires (opening a PR when the policy applies, per
  the standing instructions). When you believe the goal is satisfied, say so
  explicitly in your reply so the user can confirm or clear it. Do not skip
  or defer the normal turn-end actions in order to make further progress
  toward the goal.]
  ```

- **Slash-invocation turn** (`userText` starts with `/skill-name`): order
  stays `[userText, fileContext, imageContext]` so the `/` token remains at
  position 0 — the existing contract from docs/138 that
  `assembleAgentPrompt` was specifically written to protect. The
  `goalContext` strand is **omitted** on slash-invocation turns: skills are
  short, scoped, one-off invocations, and bracketing them with goal
  framing would re-purpose the skill's prompt. Skipping the prelude for
  the single slash-invocation turn does not lose the goal — the session
  record still has it, and the next non-slash turn re-injects.

- **Augmentation-active Codex turn** (Codex session with
  `goalsEnabled` true and `supportsGoals` resolved true on the registry):
  the prelude is **omitted**. Codex's own goal scaffolding ("keep working
  across turns until the goal is met") is already informing the model
  via the runtime continuation path; layering ShipIt's prelude on top
  produces two goal voices that frame the work differently (the prelude
  says "treat each turn as one step…do the per-turn work the user asks
  for"; Codex's scaffolding pushes the model to keep going autonomously).
  The chip and the session record still drive ShipIt-side state; the
  model just hears the goal once, from Codex. On augmentation-active
  Codex, the per-turn behavior reverts to Codex's native goal framing.

  This is also the path that makes the substrate's PR-hook composition
  work asymmetrically across backends: the "do not skip turn-end
  actions" clause only ships to Claude (where the prelude is the only
  goal voice) and to substrate-only Codex sessions (`goalsEnabled` off
  or `supportsGoals` not resolved). Augmentation-active Codex sessions
  rely on the broader product principle that turn-end actions are
  standing instructions (already in the cached system prompt) rather
  than on the prelude restating them.

Why not the system prompt: `buildAgentSystemInstructions` in
`agent-instructions.ts` is contractually **static within a session** (its
own docstring: "intentionally static within a session — the only axis is
`agentId`… so the Anthropic prompt cache stays warm across turns"), and
`agent-instructions.test.ts` enforces determinism via
`expect(buildAgentSystemInstructions()).toBe(buildAgentSystemInstructions())`.
Injecting per-session goal text there would break the cache contract on
every goal change, and — more importantly — wouldn't even reach a live
agent: under the persistent-process model below (`keepAliveAcrossTurns`),
subsequent turns reuse `existingAgent` via `sendUserMessage()` and
**never** re-call `buildAgentRunParams` / `buildAgentSystemInstructions`
(agent-execution.ts:261-263, 628-637). On Claude streaming the
`--append-system-prompt` is fixed at spawn (claude.ts:369-374); on Codex
`developerInstructions` is sent only once at `thread/start`/`thread/resume`
(codex-adapter.ts:979-998). The user-turn prelude is the only injection
point that works on both fresh and reused agents.

Trade-offs of the prelude shape:

- **Goal updates take effect on the very next turn**, including on
  persistent processes. `/goal set` and `/goal clear` are immediate, with
  no kill+respawn dance.
- The bracketed framing keeps the prelude visually distinct from the
  user's actual request so the model treats it as standing context, not
  the latest instruction.
- The prelude is sent every turn (not just the first); cleared goals omit
  the strand entirely. Goal text is not duplicated as a separate user
  message — it lives inside the prompt the user already sent.

The "do not skip turn-end actions" clause is load-bearing: with
`autoCreatePr: true`, `docker/agent-hooks/managed-settings.json`'s Stop
hook (docs/129) refuses to let a turn end without an open PR for the
branch. A goal directive that read "keep working until the goal is met"
would interleave with that hook — either by nudging the agent past the
hook's expectations, or (with the hook active) by trapping the agent in a
no-exit state where it can't end the turn and can't open a PR either. The
prompt above explicitly subordinates "make progress" to "end the turn
correctly," so the two systems compose: each turn does its scoped work
(including PR creation), the goal carries across turns via the next turn's
prelude, the user remains the achievement-confirmer. When `autoCreatePr`
is false (the hook is registered but inert because it self-gates on
`SHIPIT_AUTO_CREATE_PR=1`), the same prompt still produces correct
behavior — the PR clause is a no-op.

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

### Persistence and hydration

The session record (`sessions.ts`) is the source-of-truth for the goal,
not the per-runner event buffer:

- Write path: every state-changing intercept (substrate `/goal <text>`,
  `/goal clear`; augmentation `thread/goal/updated` /
  `thread/goal/cleared` translator) writes `SessionGoal` onto the session
  record before emitting the WS notification. This includes the
  augmentation path — `thread/goal/updated` is *also* a session-metadata
  write, not just a chip refresh. That keeps the goal alive across
  orchestrator restart, container disposal, idle eviction, and any other
  case where the live process state vanishes. See "Source-of-truth
  reconciliation" below for what happens on the next spawn.
- Hydration path: the existing `SessionInfo` payload that the orchestrator
  emits on session activation (bootstrap + SSE catch-up) is extended with
  an optional `goal: SessionGoal | null` field. A fresh client (new tab,
  reconnect after the turn has long ended) picks the goal up from this
  payload at activation time, not from the turn-event buffer. The chip
  populates from `SessionInfo.goal` immediately.
- Change path: `runner.emitMessage()` carries `goal_updated` /
  `goal_cleared` / `goal_status` to clients currently attached during the
  change. That replays correctly inside a turn but is **not** the
  hydration mechanism for late attachers — bootstrap is. The two paths
  are complementary, not redundant.

### Rendering

- A compact inline assistant/system message when the goal is set or
  cleared (change events only — `goal_status` does not emit a chat
  message), rendered in chat history.
- A session-level status chip on the chat surface while a goal is active,
  fed by a small Zustand slice (e.g. `session-store` or a new `goal-store`)
  keyed by session id. The chip is initially populated from
  `SessionInfo.goal` on session activation and updated by subsequent
  `goal_updated` / `goal_cleared` / `goal_status` messages.
- No separate command button — per CLAUDE.md §5, the user types the
  command in chat; the chip is passive status only.

### WS message shape

Three new variants on `src/server/shared/types/ws-server-messages.ts`
carry goal state. The distinction matters because clients drive different
side-effects off each:

```ts
{ type: "goal_updated"; sessionId: string; goal: SessionGoal }    // state changed
{ type: "goal_cleared"; sessionId: string }                       // state changed: cleared
{ type: "goal_status"; sessionId: string; goal: SessionGoal | null } // query response, no state change
```

`goal_updated` and `goal_cleared` are *change* notifications: clients
update the chip and emit an inline "Goal set: …" / "Goal cleared" message
into chat history. `goal_status` is the response to `/goal status` (and
to the bootstrap-hydration path described in "Persistence and hydration"
below): the chip refreshes from `goal`, but no inline chat message is
emitted and no clearedAt timestamp is recorded for the `null` case. This
prevents `/goal status` on an empty session from firing the clear-side-
effects of `goal_cleared`.

These ride the existing per-session WebSocket. `useMessageHandler` on the
client dispatches them into the goal store. They are **not** `AgentEvent`s
and do **not** go through `agent-listeners.ts` — they are ShipIt-side
state, not adapter-emitted.

User-facing prose lines (help, error, capability-rejection) reuse the
existing `system_notice` message shape that `agent-listeners.ts` already
emits for similar surfaces (it carries `sessionId / level / message`). No
new WS variant is needed for any of these cases:

- `/goal` with no args → `system_notice` with the usage line.
- `/goal <empty>` → `system_notice` rejecting the empty objective; no
  metadata write.
- `/goal pause` or `/goal resume` on a non-augmentation session →
  `system_notice` explaining the command is only available on Codex
  sessions with goal management enabled.
- Augmentation surfacing of "goals feature is disabled" or any other
  adapter error → `system_notice` at `level: "warn"`. `WsSystemNotice.level`
  is currently typed `"info" | "warn"` (ws-server-messages.ts:704); the
  goal feature does not need a new `"error"` member, since augmentation
  failures degrade transparently to the substrate (see "Error handling").

### Composer autocomplete

`/goal` joins the Bucket-1/2/3 entries in the composer's `/`-autocomplete
menu (docs/132 §"Composer `/` autocomplete"). The menu is capability-aware
per session, matching docs/132's "the `/` menu only lists what the active
agent supports" requirement:

- All sessions see: `/goal`, `/goal status`, `/goal clear`.
- Codex sessions with `goalsEnabled` true **and** registry-resolved
  `supportsGoals` true additionally see: `/goal pause`, `/goal resume`.

The capability check uses the same registry-vs-`ProxyAgentProcess`
discipline as `supportsSteering` (see "Activation split" below). The
unrecognized-`/foo`-warns behavior from docs/132 catches a user typing
`/goal pause` on a session where it isn't available — the intercept
handler should explicitly produce a "goal pause is only available on
Codex sessions with goal management enabled" inline message rather than
falling into the generic-unknown branch.

The skill-invocation slash-menu machinery this builds on lives in
[docs/138-skill-invocation](../138-skill-invocation/plan.md).

## Codex augmentation

This section is an **optional** upgrade. The substrate above is the v1 ship;
this section is what becomes possible on a Codex CLI where the
`thread/goal/*` runtime path works — provisionally 0.130 (pinned), pending
the runtime probe described in "Why not pass-through → Codex" above.

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

Verified against `@openai/codex@0.130.0` (the pinned CLI). The API *shape*
is fully observable on this version; runtime acceptance on 0.130 is the
open probe described above.

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

JSON-RPC methods (request **and** response shapes both pinned from the
`--experimental` schema dump):

| Method | Request → Response | Behavior |
|---|---|---|
| `thread/goal/get` | `ThreadGoalGetParams { threadId }` → `ThreadGoalGetResponse { goal: ThreadGoal \| null }` | Reads the current goal. |
| `thread/goal/set` | `ThreadGoalSetParams { threadId, objective?, status?, tokenBudget? }` → `ThreadGoalSetResponse { goal: ThreadGoal }` | Creates or updates; emits `thread/goal/updated`. |
| `thread/goal/clear` | `ThreadGoalClearParams { threadId }` → `ThreadGoalClearResponse` | Clears; emits `thread/goal/cleared`. |

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
`tokenBudget` are all nullable optionals. So `thread/goal/set` is both
create and update, and pause/resume are
`thread/goal/set { threadId, status: "paused" | "active" }`. There is no
separate `thread/goal/resume`.

**Substrate-write rule.** Because the schema accepts `objective: null`,
the substrate's intercept must enforce its own non-empty rule before
writing anywhere. Specifically: `SessionGoal.text` is mandatory and
user-supplied, so an empty composer input under `/goal <text>` is rejected
with a `system_notice` (see "WS message shape" above) and **does not**
write session metadata or call `thread/goal/set`. A `thread/goal/set`
issued by the augmentation handler with `objective: null` is reserved for
status-only updates (pause/resume/tokenBudget changes) and is never used
to create or rename a goal — the chip's display text must always reflect
a real user-supplied objective, not a server-side null.

**Defensive read advice.** Even though the response envelope is pinned in
the schema, the existing adapter has burned-in evidence that Codex's
app-server quietly nests/un-nests identifiers across CLI minor bumps —
see the explicit `thread.id ?? threadId` and `turn.id ?? turnId`
double-reads in `codex-adapter.ts`, added specifically to absorb 0.130 →
0.132 protocol drift. The goal-method implementations should follow the
same pattern (e.g. `response.goal ?? response`) so the adapter survives
the same class of mid-CLI re-shaping.

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
`turn/completed` (line 895 of `codex-adapter.ts`). That made sense when the
adapter was modeled on the one-shot-per-turn legacy `ClaudeProcess` shape,
but it cannot coexist with Codex's goal-managed continuation. Under
augmentation, the adapter must keep the process alive across turns.

**This doc introduces Codex keep-alive that docs/140 deliberately
deferred.** docs/140's "Codex live-steering" section explicitly notes that
Codex still kills its app-server at `turn/completed` because steering
happens *within* a live turn — "Codex needs no lifecycle rework for this
feature." The unconditional `this.kill()` at codex-adapter.ts:895 today
confirms that. So this doc is *the* lifecycle change for Codex; it isn't
ratifying an existing flag. The implementation:

- `CodexAdapter` gains an `isKeepingAlive(): boolean` getter that returns
  `params.goalsEnabled === true` (set at `run()` time). The orchestrator
  uses this getter — not a flag it derives independently — to compute
  `keepAliveAcrossTurns`. There is one boolean, owned by the adapter,
  surfaced through a method, consumed by the orchestrator. No
  same-named flag exists in two places with different definitions.
- `handleTurnCompleted` skips `this.kill()` when `isKeepingAlive()` is
  true.
- `params.goalsEnabled` **does not include `params.useStreaming`** for
  Codex. Live steering on Codex today does not require cross-turn
  keep-alive (the existing live-steering path already works on Codex
  without keep-alive because steering is mid-turn only), and widening
  `liveSteering` to flip Codex into keep-alive would change the
  live-steering surface area (cross-turn steering of an already-completed
  turn, idle process accounting on every steering-enabled Codex session)
  without explicit product sign-off. Until that decision is made
  elsewhere, only `goalsEnabled` activates Codex keep-alive.
- Per-turn bookkeeping (`streamedAgentItems`, `lastTokenUsage`) is reset
  at the next `turn/start` boundary instead of by process death.
  **`pendingRequests` is per-process, not per-turn**, and must survive
  the boundary: it's the JSON-RPC client's `id → {resolve, reject}`
  correlation map (codex-adapter.ts:300, 480, 553-555) that tracks
  every in-flight RPC, including the between-turn `getGoal()` /
  `setGoal()` / `clearGoal()` calls this augmentation specifically
  introduces. Today the only path that clears `pendingRequests` is
  `kill()` (lines 467-468); that contract is preserved.

On the Claude side, `StreamingClaudeProcess` already keeps the process
alive across turns under `useStreaming` (docs/140), and that path is
unchanged by this doc. The two backends now have analogous keep-alive
behavior but are gated by separate per-feature signals; the orchestrator
treats both uniformly via `keepAliveAcrossTurns`, defined as
`useStreaming || adapter.isKeepingAlive()` so it stays in lockstep with
whatever the adapter actually does.

**Post-turn flow rides `agent_result`, not `done`.** docs/140 already
solved this for streaming agents by gating three call sites in
`src/server/orchestrator/ws-handlers/agent-execution.ts` on a single
`useStreaming` boolean. This doc widens those gates so they accept either
signal:

```ts
// Existing live-steering predicate, unchanged in meaning:
const useStreaming = liveSteering && capabilities.supportsSteering;
// New unified keep-alive predicate. Sourced from the adapter's own
// `isKeepingAlive()` so the orchestrator and adapter cannot drift apart.
const keepAliveAcrossTurns = useStreaming || agent.isKeepingAlive();
```

The three sites in `agent-execution.ts` then key off
`keepAliveAcrossTurns` instead of `useStreaming`:

| Site | Today | Under this doc |
|---|---|---|
| (a) `existingAgent` reuse path (line 261) — `useStreaming ? runner?.getAgent() ?? null : null` | The branch already fires for **both** Codex and Claude when `liveSteering` is on (the registry sets `supportsSteering: true` on both adapters, agent-registry.ts:40, 73). It just degrades to a fresh spawn on Codex because the adapter kills the process at `turn/completed`. | Same predicate, but with this doc removing the Codex kill under `goalsEnabled`, the reuse branch actually keeps a process alive for goal-managed Codex sessions. Live-steering-only Codex (no goals) is **not** changed by this doc — the kill stays for that case. |
| (b) `agent_result` post-turn block (lines ~425–470) — runs `postTurnCommit`, `scheduleAutoPush`, PR-card emission, queue drain, token-sync, `session_agent_finished`. | Only fires for `useStreaming`. | Fires whenever `keepAliveAcrossTurns` is true. |
| (c) `done`-handler short-circuit (lines ~512–530) — skips the duplicate post-turn block because (b) already ran. | Skips when `useStreaming`. | Skips when `keepAliveAcrossTurns`. |

`useStreaming` keeps its meaning (live steering on a steering-capable
adapter); the existing live-steering surface area is unchanged.
`goalsKeepAlive` is additive and applies only to Codex sessions where
`goalsEnabled` is true. Without this remap, none of the post-turn actions
would fire after a goal-managed Codex turn (no auto-commit, no auto-push,
no PR card, no queue drain, no `session_agent_finished`).

**Listener-wiring.** `agent-listeners.ts:wireAgentListeners` is per-turn
today, gating "Agent process started" on a local `hasLoggedAgentStart`
flag. `runAgentWithMessage` calls `existingAgent.removeAllListeners()` at
agent-execution.ts:275-277 on every reuse turn — so any goal-event
listener registered on the EventEmitter (`adapter.on("event", …)`) would
be torn off at the start of the next turn, and a `thread/goal/updated`
notification that arrives between turns (the augmentation specifically
permits this — runtime continuation, autonomous status transitions like
`complete` / `budgetLimited`) would have no listener at all.

Goal-event delivery therefore does **not** flow through the per-turn
EventEmitter at all. Instead:

- `CodexAdapter` translates `thread/goal/updated` and
  `thread/goal/cleared` notifications *inside its own internal JSON-RPC
  dispatch path*, before any `emit("event", …)` fan-out. The adapter
  calls a direct method on a reference it holds for the runner (set
  once at adapter construction / `setAgent` time): `runner.applyGoalEvent(event)`.
- `runner.applyGoalEvent(event)` is a session-lifetime method on
  `ContainerSessionRunner`. It writes `SessionGoal` to session metadata
  and emits the `goal_updated` / `goal_cleared` WS notification via
  `runner.emitMessage`. It is **not** an EventEmitter listener; it is
  not registered with `adapter.on` and is unaffected by
  `removeAllListeners()`.
- The per-turn `agent-listeners.ts` listeners (`agent_init`,
  `agent_result`, etc.) continue to wire and tear down per turn the way
  they do today; `hasLoggedAgentStart` resets per turn just as for
  `StreamingClaudeProcess` reuse.

This keeps goal-event wiring on a session-lifetime surface (a direct
runner method call from the adapter), independent of the per-turn
EventEmitter lifecycle, and resolves the conflict with
`removeAllListeners()`.

**Worker-side state.** `session-worker.ts` nulls `this.agent` only on the
adapter's `done` and `error` events (lines 1228-1236, 1321). Under
augmentation, `done` fires only on process exit (kill / crash) — so
`this.agent` survives across turns when `keepAliveAcrossTurns` is true.
Two contract changes follow.

**1. `/agent/start` against an already-alive persistent process.**
`_startAgentViaProxy` today (container-session-runner.ts:648-681) does
*not* unconditionally kill on 409 — it does a 150ms retry first to absorb
the post-`agent_done` cleanup race, and only escalates to `/agent/kill`
+ re-spawn if the retry *also* 409s (docs/142 Problem B2). Under
augmentation that recovery escalates too eagerly: it would kill the
intended persistent Codex on every between-turn `/agent/start`.

`agentId` alone (`claude` | `codex`) is not sufficient to distinguish "the
persistent process this session intended" from "a stale process from a
previous session reusing the container." The contract needs a
**per-spawn token**: `/agent/start` writes a `runId` (a fresh uuid generated
by the orchestrator at spawn time, persisted on the runner) into both the
spawn request payload and the worker's `this.agentRunId`. `/agent/start`
against an existing agent returns success **iff** `this.agentRunId ===
params.runId`; mismatch falls back to the existing 409 retry → kill →
respawn path. This keeps the docs/142 race fix intact while distinguishing
intentional reuse from cross-session bleed.

**2. `/agent/goal` against a null `this.agent`.** The worker cannot
respawn the agent on its own — `/agent/start` requires the full
`AgentRunParams` payload (agentId, system prompt, MCP config, settings
path, model, autoCreatePr, useStreaming, …) built by `buildAgentRunParams`
in the orchestrator using session/credential/auth state the worker does
not have. So `/agent/goal` against a null `this.agent` returns a typed
"no agent" response. The orchestrator-side proxy method
(`ContainerSessionRunner.goalOp` or equivalent) catches that response and
respawns through the same `_startAgentViaProxy` it already uses for
`send_message` (with the same `runId` token), then retries the goal op.
The respawn is transparent to the user: the WS handler doesn't surface a
"no agent" message, it just sees a slightly slower goal op the one time
this happens after a crash.

Disposal, idle eviction (docs/127), and `verifyRunningState()` already
treat "no turn in flight" and "no process" as separate concerns under live
steering on the Claude side; the augmentation extends those existing
semantics to Codex.

**Crash recovery.** If the long-lived app-server dies, the existing
recovery contract applies: `verifyRunningState()` resets `running` when
the worker reports idle, the orchestrator's `_startAgentViaProxy` handles
the 409-on-already-running case and the kill→respawn dance, and the next
operation (turn or `/goal` op) respawns the agent transparently. No new
"no agent" surface is introduced.

These changes are gated on `keepAliveAcrossTurns`, so non-goal,
non-streaming Codex sessions are unaffected.

### Activation split: capability vs session-setting

Two orthogonal axes must be kept distinct:

- **Capability** (`AgentCapabilities.supportsGoals`). Unlike
  `supportsSteering` / `supportsReview` (both static per adapter), this
  flag must reflect a runtime fact about the pinned Codex CLI: does it
  actually accept `--enable goals` + `experimentalApi: true` and return
  sane responses on the three request methods? That is a real
  spawn-and-handshake probe, not a synchronous env-var read like the
  existing `authConfigured` refresh — so it doesn't share that
  precedent. The closer pattern is the CLI contract test introduced in
  docs/141 (`docs/141-cli-version-strategy`): the agent CLI is the
  source of truth, and a contract test verifies the surface against the
  pinned version. Concretely:
  - **Where the probe runs.** The agent CLI lives in the worker
    container, not the orchestrator host. The probe is therefore a
    one-time contract test invoked during the agent-CLI build / publish
    workflow (`docker/agent-cli/`), gated on the same CLI pin in
    `docker/agent-cli/package.json`. A passing probe ratchets a
    constant — `CODEX_GOALS_RUNTIME_VERIFIED = "0.130.0"` (or whatever
    pin is current) — committed alongside the lockfile.
  - **How the registry consumes it.** `agent-registry.ts` resolves
    `supportsGoals` at orchestrator init by comparing the current Codex
    pin against `CODEX_GOALS_RUNTIME_VERIFIED`. A match → `true`; a
    mismatch (Renovate landed a bump that the contract test hasn't
    re-verified yet) → `false`, with an explicit log line. No
    cold-start spawn cost is incurred per orchestrator boot; the
    expensive probe is amortized into the build.
  - **Invalidation.** A Codex pin bump triggers a fresh contract-test
    run as part of the CI gate that already exists for the agent CLI
    (docs/141). If the new pin passes, `CODEX_GOALS_RUNTIME_VERIFIED`
    is updated in the same PR; if it fails, the bump is held until the
    augmentation is brought back in line. `supportsGoals` flips off
    automatically in the meantime.
  - **Failure mode.** If `supportsGoals` is `false` registry-wide,
    `goalsEnabled` toggles silently degrade to substrate behavior —
    setting the session bit still works (the substrate uses it), the
    augmentation just doesn't activate. No user-facing capability
    rejection in the common case.

  `ClaudeAdapter` reports `false` statically (no probe needed).
  Resolved at call sites via the **shared `agent-registry`**, not via
  `ProxyAgentProcess.capabilities` — that field is a deliberately
  conservative hardcoded default (`proxy-agent-process.ts:60-74`) that
  returns `false` for advanced capabilities to avoid pretending the
  remote agent supports things the proxy shim can't introspect.
  docs/140 documents this exact trap for `supportsSteering`;
  `supportsGoals` is subject to the same rule.

  The "Error handling" section's "rejects `--enable goals` → fall back
  to substrate" bullet describes the runtime-failure path *despite* the
  contract test having passed (Renovate landed a Codex bump mid-
  orchestrator-lifetime that regressed the API, or a feature flag was
  removed upstream and not caught in CI): the orchestrator flips
  `goalsEnabled` off for the affected session (not the capability) and
  surfaces a `system_notice`. The next registry init will re-read
  `CODEX_GOALS_RUNTIME_VERIFIED` against the new pin and `supportsGoals`
  may flip globally then.
- **Activation setting** (`goalsEnabled`). Gates the Codex spawn args
  (`--enable goals` + `experimentalApi: true`) and the lifetime change
  above. Important framing note: live steering's
  `credentialStore.getLiveSteering()` (the obvious "parallel" reference)
  is in fact an **app-wide** boolean stored once on
  `credential-store.data.liveSteering` — not a per-session setting. So
  `goalsEnabled` is a sibling-axis decision, not a copy of an existing
  pattern. Two options for where it lives:
  1. Same shape as `liveSteering` — an app-wide
     `credentialStore.getGoalsEnabled()`. Simplest; matches the
     experimental-feature precedent. Lose the ability to enable goals on
     one session but not another.
  2. New per-session record field on `sessions.ts`. Genuinely new
     pattern; lets sessions opt in independently. Requires schema and
     migration work that doesn't exist for live steering.
  The plan picks option 2: per-session, because `/goal` is itself a
  per-session concept (one session can have an active goal while another
  doesn't) and stamping an app-wide flag on top of that creates two
  global-vs-session toggles for the same effective question. Implementer
  note: the per-session boolean *schema* already exists — `SessionInfo`
  carries `archived`, `warm`, `branchRenamed`, `agentPinned`, and
  `sessions.ts` exposes setters like `setBranchRenamed(id, renamed)` and
  `setAgentPinned(id)` against a SQLite-backed column. `goalsEnabled`
  lifts that pattern (add a `goals_enabled` column, mirror
  `setBranchRenamed`'s shape with a new `setGoalsEnabled(id, enabled)`
  method). What's new is that `goalsEnabled` is user-settable from the
  chat composer rather than implicit, but the persistence shape is
  off-the-shelf.

The `/goal pause` / `/goal resume` composer commands and the chip's
budget/time fields are surfaced *only* when both axes hold:
`agent.capabilities.supportsGoals` (from the registry) **and**
`session.goalsEnabled`. If the user has goals enabled on a Claude session,
the augmentation-only commands are unavailable and the session degrades
to the substrate; the chip drops the budget/time fields.

### `AgentProcess` interface shape

The augmentation methods are **optional** on `AgentProcess`:

```ts
interface AgentProcess {
  // …existing methods…
  getGoal?(): Promise<ThreadGoal | null>;
  setGoal?(args: { objective?: string; status?: ThreadGoalStatus; tokenBudget?: number | null }): Promise<ThreadGoal>;
  clearGoal?(): Promise<void>;
}
```

Adapter implementations:

- `CodexAdapter` — implements all three; throws an `AgentNotInitialized`
  -style error if `this.threadId` is null. Returns response shapes
  defensively un-nested (per the `thread.id ?? threadId` precedent).
- `ClaudeAdapter` — leaves the methods undefined (does **not** implement
  them). The substrate intercept never calls into the adapter for Claude
  sessions; it writes directly to session metadata.
- `ProxyAgentProcess` — implements pass-through forwards to the worker
  endpoint *only* when the resolved registry capability says
  `supportsGoals`; otherwise undefined so call-site checks see the
  capability gap.

Call sites use `typeof agent.setGoal === "function"` as the activation
check in code, but the gating decision is driven by the registry capability
+ session setting described above — the `typeof` check is the type-system
expression of that decision, not the source of truth.

### Container-boundary proxy

Production ShipIt talks to session containers over HTTP. Mirror the existing
agent proxy chain (`session-worker.ts` already exposes `/agent/start`,
`/agent/stdin`, `/agent/message`, `/agent/interrupt`, `/agent/kill`,
`/agent/status` — all operating on `this.agent`):

- `POST /agent/goal` on the worker with body
  `{ op: "get" | "set" | "clear", goal?: …, status?: … }`. Operates on
  `this.agent`, which under the lifetime change above is the long-lived
  process. If `this.agent` is null when the request lands, the worker
  returns a typed "no agent" response; the orchestrator-side proxy
  catches it, respawns via `_startAgentViaProxy` (using the session's
  current `runId`), and retries the goal op. See "Worker-side state"
  above for why the worker can't respawn on its own.
- `worker-http.ts` helper.
- `ContainerSessionRunner` method.
- `ProxyAgentProcess` method (guarded as above).

### Source-of-truth reconciliation

The session record (`sessions.ts`) is the authoritative store on both
paths. The chip on the client renders from the per-session goal slice,
which is fed exclusively by the session record (via the bootstrap
hydration path) and by WS change events the orchestrator emits *after*
writing the session record.

Under augmentation that means the `thread/goal/updated` translator does
**two** things on every notification: write `SessionGoal` to session
metadata, then emit `goal_updated` on the WS. The Codex app-server's
goal state is therefore a *cache*, not the source of truth — useful for
runtime continuation and for cheap reads via `getGoal()`, but not what
ShipIt relies on for persistence.

**Status type-space mapping.** `SessionGoal.status` is
`"active" | "cleared" | "achieved"` (substrate-flavored, matches the
user-confirmation lifecycle); `ThreadGoal.status` is
`"active" | "paused" | "budgetLimited" | "complete"` (augmentation-
flavored, matches the runtime continuation lifecycle). Translation:

| `ThreadGoal.status` → `SessionGoal.status` | Rule |
|---|---|
| `active` | `active` |
| `paused` | `active` (the goal is still set; the substrate record doesn't model "paused" because it has no continuation to pause — paused is a runtime-only concept) |
| `budgetLimited` | `active` (same rationale; budget limit is a runtime telemetry signal, surfaced on the chip but not as a metadata state change) |
| `complete` | `achieved` |

| `SessionGoal.status` → `ThreadGoalSetParams.status` (used on rehydrate) | Rule |
|---|---|
| `active` | `active` |
| `cleared` | (do not call `thread/goal/set` — no active goal to restore) |
| `achieved` | (do not call `thread/goal/set` — the user already confirmed achievement; the runtime should start fresh on the next user-set goal) |

The session record fields `paused` and `budgetLimited` are surfaced on
the chip via the in-memory `ThreadGoal` cache, not from `SessionGoal` —
they are transient runtime states, not persistent ones.

**Authority on conflict.** If the resumed thread reports an `active`
goal but `SessionGoal.status` is `cleared` or `achieved`, the session
record wins: the adapter immediately calls `thread/goal/clear` to bring
the app-server in line with ShipIt's persisted user-confirmed state. The
inverse (session record says `active`, resumed thread has no goal or a
different objective) also resolves in favor of the session record — the
adapter calls `thread/goal/set` with the persisted objective. The
session record is the source of truth; the app-server's state is a
runtime cache.

If the resumed thread already has a matching active goal (same
objective, same status), the rehydrate is an idempotent no-op against
the current state — no `thread/goal/set` issued.

Budget/time fields (`tokenBudget`, `tokensUsed`, `timeUsedSeconds`) on
the chip are populated only when an augmentation notification has just
arrived; they are **not** persisted on the session record (the substrate
has no source for them, and they are runtime telemetry that the
augmentation continually refreshes). Across an orchestrator restart they
zero out until the next `thread/goal/updated`.

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
- Context injection: `assembleAgentPrompt` prepends the goal prelude to
  the user turn for both Codex and Claude sessions, including on the
  `existingAgent` reuse path (so a goal set mid-session reaches the agent
  on the very next turn without process kill+respawn). A cleared goal
  produces no prelude. `buildAgentSystemInstructions` stays deterministic
  (its existing identity-equality test still passes).
- WS messages: `goal_updated`, `goal_cleared`, and `goal_status` each
  round-trip through the per-session WS to a fake client. `goal_status`
  with `goal: null` does not produce an inline chat message or a clear
  side-effect on the client.
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
  the app-server at `turn/completed`; `streamedAgentItems` and
  `lastTokenUsage` are reset on the next `turn/start`; `pendingRequests`
  survives across turns (it's a JSON-RPC correlation map, not turn
  state); `agent-listeners.ts` rewiring is explicit.
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
- `/goal status` with no active goal → emit `goal_status` with
  `goal: null`. The client refreshes the chip (which stays hidden) but
  does not record a clearedAt timestamp or render an inline "Goal
  cleared" message — that's what `goal_cleared` is for.

Codex augmentation:

- App-server rejects `--enable goals` (CLI moved between the registry
  probe and the session spawn — rare but possible after a Renovate bump
  mid-orchestrator-lifetime): surface a `system_notice` at `level: "warn"`,
  flip `goalsEnabled` off for the affected session (not the
  registry-wide capability), and fall back to the substrate
  transparently. A later registry refresh re-evaluates the probe and may
  drop `supportsGoals` globally if the new CLI doesn't accept the flag.
- App-server returns "goals feature is disabled": configuration bug in
  the adapter — log the raw response.
- `thread/goal/set` fails because the thread hasn't been created: surface
  the error inline; the substrate's session-stored goal is already
  persisted, so the chip still shows the goal even though continuation
  hasn't started.
- Persistent app-server crashes mid-session: existing recovery semantics
  apply — `verifyRunningState()` resets the local `running` flag, and the
  next operation (turn or `/goal` op) respawns the agent transparently via
  `_startAgentViaProxy`. No new "no agent" response shape is introduced
  for goal ops; they share the same respawn-on-next-op contract as
  `send_message`.

## Key files

Substrate (docs/132 Bucket-4 wiring):

- `src/server/orchestrator/sessions.ts` — persist `SessionGoal` on session
  metadata (new per-session schema; not modeled on `getLiveSteering()`,
  which is app-wide).
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — extend
  `assembleAgentPrompt` to take a `goalContext` strand and prepend it to
  the assembled prompt; goal is read from session metadata at the
  call-site that already builds the prompt.
- `src/server/orchestrator/agent-instructions.ts` — **not** modified.
  Stays static-within-session by contract; the identity-equality test in
  `agent-instructions.test.ts` continues to enforce that.
- `src/server/orchestrator/ws-handlers/send-message.ts` — Bucket-4
  intercept for `/goal …`, placed **before** the `runner.running` check at
  line 94 so goal ops don't get queued or steered. Must follow the WS
  lifecycle discipline (`resolveRunner`, capture sessionId/sessionDir at
  entry, `runner.emitMessage()` for events).
- `src/server/shared/types/ws-server-messages.ts` — `goal_updated`,
  `goal_cleared`, and `goal_status` server-message variants. Help /
  empty-input / capability-rejection prose uses the existing
  `system_notice` shape (level: `"info"` or `"warn"`; there is no
  `"error"` member).
- `src/client/components/MessageList.tsx` or adjacent — inline message
  rendering for set/clear/status.
- A new client store slice (e.g. `goal-store.ts`) plus chip wiring on the
  chat surface.
- `src/client/components/MessageInput.tsx`, `message-editor.tsx` — `/goal`
  entry in the composer `/`-autocomplete; the menu must be capability-aware
  per session (hides `/goal pause` / `/goal resume` unless the augmentation
  is active). The autocomplete machinery itself is owned by docs/132 /
  docs/138-skill-invocation.

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
- [docs/138-skill-invocation/plan.md](../138-skill-invocation/plan.md) —
  the composer `/`-autocomplete machinery that the substrate's `/goal`
  entry builds on.
- [docs/140-live-steering/plan.md](../140-live-steering/plan.md) —
  precedent for capability resolution via the shared registry (the
  `supportsSteering` trap that `supportsGoals` must avoid) and for
  persistent-process lifetime management (the `done` → `agent_result`
  post-turn remap that the augmentation rides on, and the kill-suppressor
  that this doc unifies with `goalsEnabled`).
- [docs/129-stop-hook-pr-enforcement/plan.md](../129-stop-hook-pr-enforcement/plan.md)
  — owns the managed auto-PR Stop hook in
  `docker/agent-hooks/managed-settings.json`. Directly relevant to the
  substrate's context-injection prompt: the goal directive must subordinate
  "make progress" to "end the turn correctly" so it composes with this
  hook. The hook self-gates on `SHIPIT_AUTO_CREATE_PR=1`, but the
  production case (`autoCreatePr: true`) is what the prompt has to handle.

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
- No Codex augmentation before the runtime probe on the pinned 0.130 CLI
  passes (or, if it fails, before a Renovate bump to the first version
  where it passes). The substrate ships first; the augmentation lands as
  a follow-up once the probe is green.
- No mimicry of either CLI's TUI footer. ShipIt renders goal state in its
  own chat/session UI.
