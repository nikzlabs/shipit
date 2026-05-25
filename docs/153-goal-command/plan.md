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

**One amendment to docs/132 is required as part of landing this doc.**
docs/132 §"`/goal` as a native feature" says the goal is "Injected into
the agent's context each turn via `agent-instructions.ts`". That
injection point is wrong: `buildAgentSystemInstructions` is contractually
static within a session (its docstring and the identity-equality test in
`agent-instructions.test.ts` enforce determinism for prompt-cache
stability), and under the persistent-process model (live steering today;
goal-managed Codex under this doc) the system-prompt path doesn't re-run
on reused agents at all. The correct injection point is
`assembleAgentPrompt` in `agent-execution.ts`, as a user-turn prelude —
see "Context injection" below. Updating docs/132 to reflect this is a
small, contained edit and is a precondition for this doc's "Substrate"
section being fully consistent with the governing classification.

## Why not pass-through

The instinctive design ("the user types `/goal X`, ShipIt forwards it to the
agent, the CLI handles it") fails on both backends, for different reasons.

### Claude: `-p` and stream-json do not dispatch `/goal`

The pinned `@anthropic-ai/claude-code@2.1.140` advertises a slash-command set
in the stream-json `init` event that includes `goal`. Despite that
advertisement, slash-command **dispatch** appears to be gated on the
interactive TUI input path. An initial ad-hoc probe — piping
`/goal Make all tests pass` into `claude -p --output-format stream-json`
— shows the CLI treating the text as a model prompt rather than a slash
command: the model echoes back something like "Goal acknowledged: make
all tests pass …" and no session-scoped Stop hook is installed.

Caveat on probe shape: ShipIt's legacy `ClaudeProcess` doesn't actually
pipe the prompt on stdin — it passes the prompt as a positional argument
(`claude.ts:132-137`) into a `pty.spawn`-allocated session. The ad-hoc
probe above (stdin pipe, no PTY) is therefore a stand-in, not a faithful
reproduction. Two probes are needed before this conclusion is fully
substantiated:

1. **Legacy path probe.** `claude -p "/goal Make all tests pass"
   --output-format stream-json --verbose` over a PTY, mirroring
   `ClaudeProcess.run`. Expected: same behavior as the ad-hoc probe
   (model treats text as a prompt). Confirms the legacy path.
2. **Streaming-input path probe.** `claude --print --input-format
   stream-json --output-format stream-json` with a stream-json `user`
   message whose content begins with `/goal …`, mirroring
   `StreamingClaudeProcess`. This is the path live-steering sessions
   use today (docs/140, in-progress). Whether the CLI's slash-command
   dispatcher fires on stream-json `user` messages is the load-bearing
   open question for any future Claude augmentation.

The CLI does emit the announcements (`Goal set: …`, `A session-scoped
Stop hook is now active …`, `Goal achieved`, `Goal cleared: …`) when
run interactively, and the binary contains the expected machinery
(`tengu_goal_achieved`, `restoreGoalFromTranscript`, hook preconditions)
— none of which fires through the ad-hoc probe. Until both spawn-shape
probes above run, the doc's "Claude has no augmentation path" stance
is the **conservative default** rather than a fully proven conclusion.
If probe 2 shows stream-json dispatches `/goal`, this doc's Claude
section gets revisited — and docs/132's Bucket-4 classification gets
revisited first.

**Both probes are gating for any future Claude-augmentation work**,
not for the substrate. The substrate's correctness doesn't depend on
either probe outcome — `/goal …` is intercepted in `send-message.ts`
and never reaches `claude` under the substrate alone. The probes
matter when ShipIt later revisits whether a Claude augmentation path
exists. Run them against the pinned CLI directly (outside ShipIt's
spawn paths) so the substrate intercept doesn't have to be temporarily
disabled. Recording the result here as a "Probe results" subsection
before any Claude-augmentation revisit is the right gate; the
substrate itself ships independently.

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

1. **API surface and runtime acceptance are both present on the pinned
   CLI.** Against `@openai/codex@0.130.0` (the version
   `docker/agent-cli/package.json` currently pins):
   - **Schema dump**: `app-server --help` lists `--enable <FEATURE>`,
     and `codex app-server generate-json-schema --out DIR --experimental`
     emits all six `ThreadGoalGet/Set/Clear{Params,Response}` schemas
     plus the two notification schemas. Without `--experimental` the
     dump contains only the two notification schemas.
   - **Runtime probe (confirmed against the pinned binary)**:
     - `codex app-server --enable goals` accepts the flag and the
       process initializes normally.
     - With `initialize.capabilities.experimentalApi: true`,
       `thread/goal/get` returns `{ "goal": null }` on a fresh thread.
     - Without `--enable goals`, `thread/goal/get` rejects with
       `"goals feature is disabled"` — the exact string the
       Error-handling section names.
     - Without `experimentalApi`, it rejects with
       `"thread/goal/get requires experimentalApi capability"`.

   So the augmentation's runtime path works on the pinned CLI today.
   What the doc still calls out as a precondition is the **contract
   test** (docs/141 Axis-3 + a goal-flow extension) that ratchets a
   committed `CODEX_GOALS_RUNTIME_VERIFIED` constant and gates Renovate
   bumps — not a question of whether the API works on 0.130 (it does),
   but a question of whether ShipIt's CI prevents a future bump from
   regressing it silently.
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
  setAt: number;           // ms epoch — when the current goal record was created
  updatedAt: number;       // ms epoch — last write to this record (rename, pause, resume, ...)
  setBy: "user";           // reserved for future system-set goals
  status: "active" | "paused" | "cleared" | "achieved";
  pausedAt?: number;       // ms epoch — set when status transitions to "paused", cleared on resume
  achievedAt?: number;     // ms epoch — set when status transitions to "achieved"
  clearedAt?: number;      // ms epoch — set when status transitions to "cleared"
};
```

`updatedAt` lets `Source-of-truth reconciliation` distinguish "renamed
since the app-server's cached copy" from "unchanged" without relying
on `text` string comparison alone. `achievedAt` is what the chip's
"achieved 30 seconds ago" relative-time UI reads. `pausedAt` is set
on every `paused` transition and cleared on resume; it's what makes
"pause survives orchestrator restart" actually work (the rehydrate
handler reads `status === "paused"` and re-arms the runtime with
`thread/goal/set { status: "paused" }`, with `pausedAt` available
for chip relative-time display).

`paused` is on `SessionGoal.status` for an augmentation-driven reason
even though it lives in the substrate's persistence type. `/goal
pause` itself is only available on Codex augmentation sessions (the
substrate has no continuation to pause), but **if** such a session
pauses its goal and the orchestrator restarts before resume,
`paused` must survive the restart — otherwise the activation
predicate would see `status === "active"` after rehydrate, flip
keep-alive on, re-issue `thread/goal/set { status: "active" }` per
the rehydrate rules, and silently resume runtime continuation
(consuming tokens) against a goal the user explicitly paused.

**Substrate-only sessions (Claude today, plus any future adapter
without `supportsGoals`) only ever traverse `active → cleared`** —
they never produce `paused` (no pause UX) and never produce
`achieved` (the substrate's achievement model is "model declares,
user confirms with `/goal clear`," which lands the record at
`cleared`). So `paused`, `pausedAt`, `achieved`, and `achievedAt`
are augmentation-only transitions and writes. The substrate's
contribution to these fields is persistence-of-shape only — it
defines the column and the type union but doesn't write the values.
The activation predicate is `status === "active" && supportsGoals &&
agentId === "codex"`; `paused` is treated identically to `active`
for purposes of "the goal exists; the prelude is injected; the chip
is visible," but it does *not* activate keep-alive.

Persisted alongside other session metadata in `sessions.ts` as a
single `goal_json` TEXT column (`JSON.stringify`/`JSON.parse` on the
boundary). This matches the existing `pr_status` precedent at
`sessions.ts:338` (`setPrStatus` does `JSON.stringify(status)` into
`pr_status`) and `sessions.ts:354` (`getAllPrStatuses` does
`JSON.parse(row.pr_status)`), so the JSON-column shape is already
established in this file. Splitting `SessionGoal` into four columns
(`goal_text`, `goal_set_at`, `goal_status`, `goal_cleared_at`) is
cheap follow-up if a future feature wants to query active goals
across sessions; the v1 chip's hot path is `goal_json IS NOT NULL`,
which is identical against either shape.

The `SessionInfo` type in `src/server/shared/types/domain-types.ts`
(the shape the orchestrator emits on session activation and SSE
catch-up) gains an optional `goal?: SessionGoal | null` field. This
is the load-bearing hydration channel — see "Persistence and
hydration" below.

`SessionGoal` survives session switches, reconnects, and `--resume`
because it is not tied to the agent process.

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

The substrate handles every command. **Session-metadata writes
happen on both paths** — the intercept always writes `SessionGoal`
to session metadata first; under Codex augmentation the handler
*additionally* calls the adapter's goal methods to drive runtime
continuation. The metadata write is unconditional (it closes the
persistence-window race between RPC-ack and notification-arrival);
the augmentation adapter call is the optional second step.

| Composer input | Substrate behavior | With Codex augmentation active |
|---|---|---|
| `/goal <text>` when runner is **idle** | Write `SessionGoal` to session metadata; emit `goal_updated`. **Do not** kick off a turn — `/goal …` is a control command, not a turn-starter. If the user wants to immediately work on the goal, they type their first prompt as a separate message; the prelude carries the goal context. (Symmetric with `/goal clear` / `/goal pause` / `/goal resume`, none of which start turns.) | **Write `SessionGoal` to session metadata first** (so the orchestrator-restart-between-ack-and-notification window doesn't lose the goal); then call `setGoal({ objective: text, status: "active" })`. The `thread/goal/updated` notification handler re-applies state via `runner.applyGoalEvent` — idempotent against the metadata that's already there, but also the path that surfaces budget/time telemetry. |
| `/goal <text>` when runner is **running** (mid-turn) | Write metadata + emit `goal_updated` exactly as the idle case. Do **not** enqueue a turn carrying the text. The prelude rides on the *next* turn the user starts (or the next queued one drains). | Same intercept; the augmentation's `setGoal` call goes through the JSON-RPC channel synchronously — see "Mid-turn pause probe" for whether `thread/goal/set` is JSON-RPC-safe concurrent with an in-flight turn. Until that probe passes, the augmentation's `setGoal` call is **deferred** until the current turn completes (the substrate's metadata write still happens immediately). |
| `/goal status` | Read session metadata; emit `goal_status` carrying the full record for `active`/`paused`/`achieved`, or `goal: null` if `SessionGoal` is absent or `status` is `cleared`. | Call `getGoal()`; reconcile result with session metadata per "Source-of-truth reconciliation"; emit `goal_status` using the same mapping. |
| `/goal clear` | Update session metadata to `status: "cleared"`; emit `goal_cleared`. | **Update session metadata first** (same persistence-window rationale); then call `clearGoal()`. The notification handler is idempotent. |
| `/goal pause` | Not exposed — autocomplete hides it. | Update `SessionGoal.status` to `paused` on session metadata first; then call `setGoal({ status: "paused" })`, pending the mid-turn probe below. Persisting `paused` is what prevents an orchestrator restart from silently resuming continuation (see §Storage). |
| `/goal resume` | Not exposed — autocomplete hides it. | Update `SessionGoal.status` from `paused` to `active` on session metadata first; then call `setGoal({ status: "active" })`. This transition flips `hasActiveGoal()` back on so keep-alive re-activates. |
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

- **Skill-invocation turn** (`userText` starts with `/skill-name` and
  the slash command resolves to a Bucket-3 skill per
  `docs/138-skill-invocation`): order stays
  `[userText, fileContext, imageContext]` so the `/` token remains at
  position 0 — the existing contract from docs/138 that
  `assembleAgentPrompt` was specifically written to protect. The
  `goalContext` strand is **omitted** on skill-invocation turns:
  skills are short, scoped, one-off invocations, and bracketing them
  with goal framing would re-purpose the skill's prompt. Skipping the
  prelude for the single skill-invocation turn does not lose the
  goal — the session record still has it, and the next non-skill
  turn re-injects.

  Note: today's `assembleAgentPrompt` slash check
  (`/^\/[a-zA-Z0-9._-]+/`, agent-execution.ts:83) matches *any*
  leading slash token, not only Bucket-3 skills. That's fine for
  Bucket-1 (`/diff`, `/review`, etc.) and Bucket-2 (`/model`, `/plan`,
  etc.) commands because docs/132 routes them at the
  `send-message.ts` intercept layer **before** `assembleAgentPrompt`
  runs — by the time prompt assembly happens, the only leading-slash
  text reaching `assembleAgentPrompt` is a skill invocation that
  needs the `/` at position 0. The substrate's own `/goal` intercept
  is in the same position: a `/goal …` typed in the composer is
  consumed by the substrate handler and never reaches
  `assembleAgentPrompt` at all. So in practice the slash check here
  fires only for Bucket-3 skills, which is the intent.

- **Augmentation-active Codex turn** (Codex session with an active goal
  and `supportsGoals` resolved true on the registry): the prelude is
  **still sent**. The doc's "Verified upstream behavior" section limits
  its claims to API shape; whether `--enable goals` actually injects
  any goal framing into the model's context on the pinned CLI is
  **not** verified. Omitting the prelude on that assumption risks the
  failure mode "augmentation active, chip updates correctly, but the
  model has no idea a goal exists" — which is silent and worse than
  the merely-stylistic concern of two voices framing the same goal.

  **Open tension this defers.** The prelude says "Treat each turn as
  one step toward this goal: do the per-turn work the user asks for,
  including the normal turn-end actions ShipIt requires." On Codex
  under `keepAliveAcrossTurns`, the runtime continuation lifecycle is
  what's supposed to keep working autonomously across turns — and the
  prelude's framing nudges in the opposite direction (stop at the turn
  boundary, do per-turn work). These two compose fine on Claude (the
  Stop hook is the interlock) but on Codex there is no Stop hook, and
  the prelude becomes a deliberate brake on Codex's own autonomous
  continuation. Two possible futures:

  - **The prelude wins.** Codex's runtime continuation only fires
    when the model decides not to end the turn — and the prelude is
    explicit that it should end the turn correctly. In that case the
    augmentation reduces to "structured chip state + auto-detected
    achievement," with the autonomous continuation surface
    effectively dormant.
  - **Codex's continuation wins.** The model leans toward continuing
    because that's what `--enable goals` orients it toward, despite
    the prelude. In that case the prelude is a partial brake and
    augmentation v1 ships with some autonomous turns.

  Augmentation v1 ships the prelude as-is and observes which way the
  model leans. The mid-turn-pause probe and the broader augmentation
  rollout will surface which behavior dominates; a Codex-specific
  prelude rewording (or full suppression) is a v2 decision based on
  observed behavior, not a v1 design choice.

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
`--append-system-prompt` is fixed at spawn (claude.ts:370-374,
inside the `if (systemPrompt)` block at line 369); on Codex
`developerInstructions` is sent only once at `thread/start`/`thread/resume`
(codex-adapter.ts:979-998). The user-turn prelude is the only injection
point that works on both fresh and reused agents.

**All four turn-start paths must thread the prelude**, not just
`assembleAgentPrompt`. Today these paths feed text to the agent
independently:

1. **`runAgentWithMessage` (the primary path).** Already calls
   `assembleAgentPrompt`. Extending the function signature to accept a
   `goalContext` strand is mechanical.
2. **`handleAnswerQuestion` (AskUserQuestion answer turns).** Three
   sub-paths today, all bypassing `assembleAgentPrompt`: the
   non-streaming fresh-spawn path passes `answerText` directly to
   `agent.run({ prompt: answerText, ... })` (send-message.ts:583-588);
   the streaming path uses `existingAgent.sendUserMessage(answerText)`
   (line 403); the non-streaming reuse path
   (`existingAgent.writeStdin(`${answerText}\n`)`, line 421) feeds a
   paused `claude -p --resume` process. The first two sites need the
   helper. The third (writeStdin into a resumed process) does **not**
   need re-injection because the prior turn that triggered the
   AskUserQuestion already carried the prelude into the resumed
   context; re-injecting would duplicate the directive each AskUser
   answer. Call this asymmetry out at the helper's call site so a
   future contributor doesn't add the helper to all three.
3. **Live-steering injection in `handleSendMessage`.** When a runner is
   already running and live steering is on, the message is sent via
   `steeringAgent.sendUserMessage(msg.text)` (line 116) — also bypassing
   `assembleAgentPrompt`. **This path does *not* get the prelude.** A
   steered message is by design a mid-turn nudge (a single line the
   user is sliding into a turn that already received the prelude via
   path 1), so re-injecting `[Active goal …]` would (a) duplicate the
   prelude inside one turn for every steer call, (b) reframe the
   steer as standing context rather than the immediate instruction
   the user intended, and (c) inflate token usage on a path designed
   to be a thin pass-through. The narrower contract — "prelude rides
   on turn-start, not on mid-turn injections" — is the explicit rule.
4. **`runDispatchedTurn` (`src/server/orchestrator/dispatched-turn.ts`).**
   Calls `agent.run(runParams)` with `prompt` from `buildRunParams`
   (dispatched-turn.ts:136-137), never through `assembleAgentPrompt`.
   This path is for **system-dispatched turns** — CI-fix, rebase
   driver, child-session spawns, `/agent/dispatch` — and for its own
   internal queue-drain recursion (dispatched-turn.ts:115-129). The
   WS-typed user-message queue drain (`drainNextQueuedMessage` in
   agent-execution.ts:118-194) routes back through
   `runAgentWithMessage`, which is already covered by path 1; do not
   plumb the helper into `drainNextQueuedMessage` itself.

A new shared helper, e.g. `applyGoalPrelude(text, goal)`, is the right
shape: each of the four call sites wraps the outgoing text in the
prelude before sending. The substrate's intercept handler installs the
helper at the appropriate site depending on which path the turn is
taking. Without this, the goal would silently fail to ride along on
AskUserQuestion answers, every live-steered message, and every drained
queue message — exactly the "reach a live agent" failure mode this
section is meant to close.

System-turn paths route through helper (4) with per-site decisions on
whether to inject the prelude:

- **CI-fix system turn** — inject. The agent benefits from knowing
  the overall objective even when fixing a CI failure.
- **Rebase driver** (`services/rebase-driver.ts`) — **suppress**
  (`{ suppressPrelude: true }`). Rebase is mechanical conflict
  resolution; the agent is supposed to resolve merge conflicts, not
  "make progress toward the goal." Wrapping a rebase turn in
  `[Active goal for this session: … treat each turn as one step
  toward this goal …]` confuses the rebase framing and risks the
  agent doing extra goal-related work mid-rebase. Suppress.
- **Child-session spawn** — inject if the spawn inherits the parent's
  goal; suppress if it's an unrelated child task. The call site
  decides.

The helper takes an explicit `suppressPrelude` flag; the default is
"inject if there's an active goal." Each new system-turn call site
must make the inject/suppress choice deliberately.

Trade-offs of the prelude shape:

- **Goal updates take effect on the very next turn**, including on
  persistent processes. `/goal set` and `/goal clear` are immediate, with
  no kill+respawn dance.
- The bracketed framing does two things. (1) Visually distinct from the
  user's actual request, so the model treats it as standing context
  rather than the latest instruction. (2) **Structural** — it defends
  against goal text whose first character is `/` (e.g. a user sets
  their goal to `/init the project`). If the Claude stream-json probe
  ever shows the CLI dispatches slash commands on `user`-content text
  whose first token is `/`, an unbracketed prelude that *starts* with
  the user-supplied goal text would risk re-dispatching as a slash
  command. The `[Active goal …]` framing keeps the `/` away from
  position 0 even on the streaming path.
- The prelude is sent every turn (not just the first); cleared goals omit
  the strand entirely. Goal text is not duplicated as a separate user
  message — it lives inside the prompt the user already sent.

The "do not skip turn-end actions" clause is **load-bearing on Claude**
specifically. `docker/agent-hooks/managed-settings.json`'s Stop hook
(docs/129) is wired into Claude via `--settings`
(`session-agent-run-params.ts:106` only sets `settingsPath` for
`agentId === "claude"`), and when `autoCreatePr: true` it refuses to
let a turn end without an open PR for the branch. A goal directive that
read "keep working until the goal is met" would interleave with that
hook — either by nudging the agent past the hook's expectations, or
(with the hook active) by trapping the agent in a no-exit state where
it can't end the turn and can't open a PR either. The prompt above
explicitly subordinates "make progress" to "end the turn correctly,"
so the two systems compose on Claude.

On **Codex** sessions the managed-settings.json hook does not apply —
Codex never receives `--settings` — so the clause is a generic nudge,
not a load-bearing Stop-hook interlock. **This is a real
augmentation-only risk worth naming**: with the goal-managed Codex
process kept alive and runtime-continuing across turns, the prelude
is the *entire* interlock between "make progress" and "end the turn
correctly." If the model interprets the prelude liberally and chains
another turn instead of ending one (especially likely if Codex's own
goal scaffolding emphasizes autonomous continuation), there is no
Stop-hook backstop to enforce the boundary the way docs/129 does on
Claude.

Mitigations baked into v1: (1) the prelude's explicit "do not skip
or defer the normal turn-end actions" clause; (2) the
runtime-acceptance probe captured a "completes" baseline against the
pinned CLI, which is how autonomous achievement is supposed to wind
the goal down; (3) auto-PR on Codex sessions is not a feature in
production today, so the missing Stop-hook backstop is not a missed
PR — it is a "the model kept working past where the user wanted it
to" failure mode, surfaced inline as continuation turns the user
would see and could `/goal pause` or `/goal clear`. Continued
monitoring through the mid-turn-pause probe results will inform
whether a stronger interlock is needed before augmentation v2.

When `autoCreatePr` is false on Claude (the hook is registered but
inert because it self-gates on `SHIPIT_AUTO_CREATE_PR=1`), the same
prompt still produces correct behavior — the PR clause is a no-op.

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
  populates from `SessionInfo.goal` immediately. **`SessionInfo.goal`
  is the load-bearing hydration channel** — clients should never depend
  on `goal_status` to bootstrap initial chip state. `goal_status` is
  reserved for the `/goal status` user-command response (and the
  augmentation's reconcile-on-rehydrate flow that surfaces it to
  attached viewers).
- Change path: `runner.emitMessage()` carries `goal_updated` /
  `goal_cleared` to clients currently attached during the change.
  That replays correctly inside a turn but is **not** the hydration
  mechanism for late attachers — bootstrap is.

### Rendering

- A compact inline assistant/system message when the goal is set or
  cleared (change events only — `goal_status` does not emit a chat
  message), rendered in chat history.
- A session-level status chip on the chat surface while a goal is active
  or paused, fed by a small Zustand slice (e.g. `session-store` or a
  new `goal-store`) keyed by session id. The chip is initially populated
  from `SessionInfo.goal` on session activation and updated by
  subsequent `goal_updated` / `goal_cleared` / `goal_status` messages.
- **Achievement rendering** (augmentation only): when
  `thread/goal/updated { status: "complete" }` arrives, the substrate
  maps it to `SessionGoal.status = "achieved"` and emits a
  `goal_updated` message. The client renders one inline "Goal
  achieved: <text>" system message in chat history (analogous to the
  "Goal set" / "Goal cleared" inline messages, but as a one-shot
  congratulation), and the chip transitions to an "achieved" visual
  state with an explicit "/goal clear" affordance shown in the chip's
  hover/menu. The chip **does not** auto-dismiss — the user confirms
  achievement by clearing, mirroring the substrate's user-confirmation
  model on Claude. This keeps the UX symmetric across backends: under
  augmentation Codex auto-detects achievement; under substrate the
  model declares achievement in its reply; either way the user
  performs the clear.
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
update the chip and emit an inline "Goal set: …" / "Goal cleared"
message into chat history. `goal_status` is the response to
`/goal status`: the chip refreshes from `goal`, but no inline chat
message is emitted and no `clearedAt` timestamp is recorded for the
`null` case. This prevents `/goal status` on an empty (or
cleared/achieved) session from firing the clear-side-effects of
`goal_cleared`.

**`goal` mapping rule.** `goal_status.goal` (and `SessionInfo.goal`,
which uses the same rule) is `null` whenever the session has no
goal record at all, **or** when the record's `status` is `"cleared"`.
For `"active"`, `"paused"`, and `"achieved"`, the full `SessionGoal`
is surfaced — the chip needs the `achieved` state to render its
one-shot congratulation and "awaiting `/goal clear`" affordance per
the Rendering section. So the surface is: `active`, `paused`,
`achieved` → non-null; `cleared` or absent → `null`. The persisted
historical `cleared` record stays on the session row (the substrate's
"sessions that ever had a goal" predicate, used for the rehydrate
gate, depends on it) but is not surfaced as goal state to the client.

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
- `/goal pause` is gated on `supportsGoals` true on the registry **and**
  `SessionGoal.status === "active"` (there's an active goal to pause)
  **and** the mid-turn-pause probe has passed (see "Mid-turn pause
  probe" below). Until that probe lands — which it must, before this
  row of the augmentation ships — the autocomplete entry stays hidden
  so we don't surface a command the doc itself says hasn't been
  validated as mid-turn-safe.
- `/goal resume` is gated on `supportsGoals` true on the registry
  **and** `SessionGoal.status === "paused"` (there's something to
  resume). Symmetric with `/goal pause`: each only appears when its
  precondition is met.

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

Verified against `@openai/codex@0.130.0` (the pinned CLI). The API shape
is fully observable via `generate-json-schema --experimental`, and a
runtime probe of the request methods against the live app-server with
`--enable goals` + `experimentalApi: true` succeeds (see "Why not
pass-through → Codex" above for the probe results).

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
| `thread/goal/clear` | `ThreadGoalClearParams { threadId }` → `ThreadGoalClearResponse { cleared: boolean }` | Clears; emits `thread/goal/cleared`. `cleared` is `true` when an active goal was actually cleared, `false` if there was nothing to clear. |

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

**Substrate-write rule.** A goal must have user-supplied text; an empty
composer input under `/goal <text>` is rejected with a `system_notice`
(see "WS message shape" above) and **does not** write session metadata
or call `thread/goal/set`. This is a user-facing UX rule, not a schema
constraint — `ThreadGoalSetParams.objective` is a nullable optional, so
the wire protocol accepts `objective: null`, but the substrate's
intercept never constructs such a call for the "create or rename" path.
A `thread/goal/set` issued with `objective` omitted is reserved for
status-only updates (pause/resume/tokenBudget changes) on the
augmentation path and is never used to create or rename a goal — the
chip's display text must always reflect a real user-supplied objective,
not a server-side null.

**Defensive read advice.** Even though the response envelope is pinned in
the schema, the existing adapter has burned-in evidence that Codex's
app-server quietly nests/un-nests identifiers across CLI minor bumps —
see the explicit `thread.id ?? threadId` and `turn.id ?? turnId`
double-reads in `codex-adapter.ts`, added specifically to absorb 0.130 →
0.132 protocol drift. The goal-method implementations should follow the
same pattern (e.g. `response.goal ?? response`) so the adapter survives
the same class of mid-CLI re-shaping.

**Mid-turn pause probe.** docs/140 documents that the app-server
rejects `turn/steer` during review and manual-compaction turns with
`ActiveTurnNotSteerable`. `/goal pause` is specifically a mid-turn
affordance (the user types it while a goal-managed turn is running).
The probe must answer two distinct questions, **both** before the
augmentation exposes `/goal pause`:

1. **Acceptance.** Is `thread/goal/set { status: "paused" }` accepted
   concurrent with an in-flight turn on the same JSON-RPC channel —
   and if so, does it interrupt the running work or take effect at
   the next turn boundary?
2. **JSON-RPC interleaving safety.** The pause arrives as a
   `sendRequest` that needs an `id` correlation, while the adapter is
   mid-turn holding the stream open and emitting notifications. Does
   the existing `pendingRequests` correlation map handle interleaved
   request/response while a turn is still pumping notifications, or
   does it strand either the goal-set response or the in-flight turn
   notifications? An "acceptance" probe against an idle thread passes
   while the real mid-turn case still hangs.

Both probes use the same harness; both results must be green for
`/goal pause` to surface in the composer autocomplete.

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
deferred.** docs/140's Codex live-steering section observes that
Codex's steering happens *within* a live turn (`turn/steer` mid-turn),
so the same persistent-process work it does on the Claude side is not
required for Codex live-steering to function — and the codex adapter's
unconditional `this.kill()` at codex-adapter.ts:895 today reflects that.
So this doc is *the* lifecycle change for Codex; it isn't ratifying an
existing flag. The implementation:

- `CodexAdapter` decides whether to keep alive on each
  `handleTurnCompleted` by reading a single `goalsKeepAlive` boolean
  **delivered with every turn-start payload** from the orchestrator.
  The orchestrator computes the boolean from
  `hasActiveGoal(session) && registry.supportsGoals && agentId === "codex"`
  and writes it into `AgentRunParams` for fresh-spawn turns and into
  the `/agent/message` envelope for between-turn message delivery.
  One wire name, one meaning — distinct from the orchestrator-side
  derived gate `keepAliveAcrossTurns` defined above (which is a
  per-agent multiplexer over `goalsKeepAlive` and `useStreaming`).

  - `AgentRunParams.goalsKeepAlive?: boolean` — set on the first
    spawn of a session.
  - `POST /agent/message` body gains an optional
    `goalsKeepAlive?: boolean` field, written by the orchestrator at
    every turn-start so a mid-session `/goal clear` flips the boolean
    to `false` on the very next message.
  - `AgentProcess.sendUserMessage(text)` signature gains an optional
    `opts.goalsKeepAlive?: boolean` argument; existing call sites
    pass `undefined` (Claude path is unaffected).

  Compat: omitting the field preserves today's behavior on every
  non-augmentation path.
- `handleTurnCompleted` skips `this.kill()` when the locally derived
  predicate matches what the orchestrator independently computed; the
  two stay aligned because they consult the same session-record snapshot
  on the same turn.
- **Codex live steering does not trigger keep-alive.** Live steering on
  Codex today works without keep-alive because steering is mid-turn
  only, and widening `liveSteering` to flip Codex into keep-alive would
  change the live-steering surface area (cross-turn steering of an
  already-completed turn, idle process accounting on every
  steering-enabled Codex session) without explicit product sign-off.
  The only signal that activates Codex keep-alive in this doc is the
  presence of an active goal on a session whose adapter reports
  `supportsGoals`.
- Per-turn bookkeeping (`streamedAgentItems`, `lastTokenUsage`) is reset
  on the next `turn/started` notification (the boundary the adapter
  already dispatches on at codex-adapter.ts:624) instead of by process
  death.
  **`pendingRequests` is per-process, not per-turn**, and must survive
  the boundary: it's the JSON-RPC client's `id → {resolve, reject}`
  correlation map in `codex-adapter.ts` (declaration at line 300, `set`
  at line 480, resolve/reject sites at lines 553-557) that tracks every
  in-flight RPC, including the between-turn `getGoal()` / `setGoal()` /
  `clearGoal()` calls this augmentation specifically introduces. Today
  the only path that clears `pendingRequests` is `kill()`; that contract
  is preserved.

On the Claude side, `StreamingClaudeProcess` already keeps the process
alive across turns under `useStreaming` (docs/140), and that path is
unchanged by this doc. The two backends now have analogous keep-alive
behavior but are gated by separate per-feature signals; the orchestrator
treats both uniformly via `keepAliveAcrossTurns` — defined below in
"Post-turn flow rides `agent_result`" purely from the session record,
the registry, and `agentId`, **not** from a method on the orchestrator-
side `agent` (which is a `ProxyAgentProcess` and would fall into the
`supportsSteering` capability trap).

**Post-turn flow rides `agent_result`, not `done`.** docs/140 already
solved this for streaming agents by gating three call sites in
`src/server/orchestrator/ws-handlers/agent-execution.ts` on a single
`useStreaming` boolean. This doc widens those gates so they accept either
signal:

```ts
// Existing live-steering predicate, unchanged in meaning:
const useStreaming = liveSteering && capabilities.supportsSteering;
// Goal-driven keep-alive predicate. Derived from session state +
// registry capability + agent id, NOT from a method on `agent` — the
// orchestrator-side `agent` is a `ProxyAgentProcess` whose
// `capabilities` field is the deliberately conservative hardcoded
// default (proxy-agent-process.ts:60-74). Asking the proxy "are you
// keeping alive?" falls into the same trap as `supportsSteering` (see
// "Activation split → Capability"). The orchestrator already has all
// three inputs synchronously: the session record, the agent registry,
// and the agent id.
const goalsKeepAlive =
  agentId === "codex" &&
  agentInfo?.capabilities.supportsGoals === true &&
  hasActiveGoal(session);
// Per-agent gate, NOT a union. This is what fixes the live-steering-
// Codex regression: under live-steering-only Codex (no active goal),
// `useStreaming` is true but `goalsKeepAlive` is false, and the
// adapter side still kills at turn/completed. If the orchestrator
// here took the union, it would reuse a worker agent that was just
// killed. Per-agent split keeps both sides aligned:
//   - Claude takes the reuse branch under live steering only.
//   - Codex takes the reuse branch under goalsKeepAlive only.
const keepAliveAcrossTurns =
  (agentId === "claude" && useStreaming) ||
  (agentId === "codex" && goalsKeepAlive);
```

The wire signal to the worker carries **`goalsKeepAlive`** only —
under a name distinct from the orchestrator's three-site gate to
avoid the overloaded-name pitfall. Claude's keep-alive is already
gated independently inside `claude-adapter.ts` via the
`useStreaming` path (docs/140); the orchestrator and the Claude
adapter both consult `liveSteering` directly, so no extra wire field
is needed for Claude.

The adapter's own `handleTurnCompleted` decision is logically the same
boolean but **reads the inputs locally inside the worker**, not from the
proxy. The worker passes `goalsKeepAlive` from the orchestrator into
`AgentRunParams` (a new field), and `CodexAdapter` reads it from
`params` at `run()` time (and re-reads on each `turn/completed`
decision via the per-turn refresh on `/agent/message` — see "Process
lifetime" below). Same name, same value, same source of truth on the
adapter side; the orchestrator's `keepAliveAcrossTurns` is a derived
gate that consults `goalsKeepAlive` for Codex and `useStreaming` for
Claude.

The three sites in `agent-execution.ts` then key off
`keepAliveAcrossTurns` instead of `useStreaming`:

| Site | Today | Under this doc |
|---|---|---|
| (a) `existingAgent` reuse path (line 261) — `useStreaming ? runner?.getAgent() ?? null : null` | The branch already fires for **both** Codex and Claude when `liveSteering` is on (the registry sets `supportsSteering: true` on both adapters, agent-registry.ts:40, 73). It just degrades to a fresh spawn on Codex because the adapter kills the process at `turn/completed`. | Same predicate, but with this doc removing the Codex kill when an active goal is present, the reuse branch actually keeps a process alive for goal-managed Codex sessions. Live-steering-only Codex (no active goal) is **not** changed by this doc — the kill stays for that case. |
| (b) `agent_result` post-turn block (lines ~425–470) — runs `postTurnCommit`, `scheduleAutoPush`, PR-card emission, queue drain, token-sync, `session_agent_finished`. | Only fires for `useStreaming`. | Fires whenever `keepAliveAcrossTurns` is true. |
| (c) `done`-handler short-circuit (lines ~512–530) — skips the duplicate post-turn block because (b) already ran. | Skips when `useStreaming`. | Skips when `keepAliveAcrossTurns`. The `runner.setAgent(null)` call near `done` is **identity-gated** today (`if (runner?.getAgent() === currentAgent) runner.setAgent(null)`, agent-execution.ts:502), not `useStreaming`-gated, so no boolean widening is needed there — under keep-alive, `done` only fires on process exit anyway, and on exit it's correct to null the ref. |

`useStreaming` keeps its meaning (live steering on a steering-capable
adapter); the existing live-steering surface area is unchanged. The
`goalsKeepAlive` clause is additive and only true on Codex sessions
with an active goal. Without this remap, none of the post-turn actions
would fire after a goal-managed Codex turn (no auto-commit, no
auto-push, no PR card, no queue drain, no `session_agent_finished`).

**Goal-event delivery across the container boundary.** Goal events are
`AgentEvent` variants and must ride the same path every other
adapter-emitted event takes:

1. `CodexAdapter` (running inside the worker container) emits
   `agent_goal_updated` / `agent_goal_cleared` as `AgentEvent`s from its
   JSON-RPC notification dispatcher, alongside `agent_assistant` /
   `agent_result`.
2. The worker forwards them through its existing SSE relay (the
   `agent_event` channel that `session-worker.ts` already pumps).
3. The orchestrator's `ContainerSessionRunner.handleSSEEvent`
   (container-session-runner.ts:1101-1143) is the runner-side SSE
   consumer that today calls `this._agent.emit("event", data)` for
   `agent_event` messages. **This is where the goal-event branch
   lives**, *before* the `_agent.emit` fan-out:

   ```ts
   case "agent_event":
     if (data.type === "agent_goal_updated" || data.type === "agent_goal_cleared") {
       this.applyGoalEvent(data);   // session-lifetime, runner-owned
       // fall through to also fan out to attached viewers if needed
     }
     if (this._agent) this._agent.emit("event", data);
     break;
   ```

4. `applyGoalEvent` is a `ContainerSessionRunner` method that writes
   `SessionGoal` to session metadata (per the persistence rules below)
   and emits `goal_updated` / `goal_cleared` via `runner.emitMessage`.

   **DI prerequisite** (substrate-level work): `ContainerSessionRunner`
   does not currently hold a `SessionManager` reference (grep
   `sessionManager` in `container-session-runner.ts` and
   `session-runner.ts` returns nothing). The substrate must plumb either
   `SessionManager` or a narrow `setSessionGoal(sessionId, goal)`
   callback into the runner constructor, threaded through
   `SessionRunnerRegistry`, `app-di.ts`, and the warm-session pool. This
   is mechanical DI work but it touches enough sites to be worth
   calling out — without it, `applyGoalEvent` has no obvious home for
   the metadata write.

This puts the goal-event branch at the runner level, *upstream of the
per-turn EventEmitter*, so `existingAgent.removeAllListeners()` at
agent-execution.ts:275-277 (which clears `_agent`'s listeners between
turns) never affects goal delivery in container mode.

**Local / dogfood mode** is a smaller wiring problem and is scoped
separately: `buildLocalAgentFactory` in `app-di.ts` is a bare
`switch` that returns a `ClaudeAdapter` / `CodexAdapter` instance,
and there is no runner-level SSE consumer (no container boundary to
demux). The local-mode factory is therefore extended to wrap the
local adapter in a small `LocalRunnerAdapter` that intercepts
`agent_goal_updated` / `agent_goal_cleared` events from the adapter's
event stream and forwards them to the runner via the same
`applyGoalEvent` method used in container mode.

This is structurally required, not optional: under the
augmentation's persistence contract, `thread/goal/updated` is *also*
a session-metadata write. If local mode dropped between-turn goal
events (the "no listener attached between turns" case under the
per-turn listener tear-down), an autonomous `complete` transition
during local dogfooding would mutate the live `ThreadGoal` cache but
never reach session metadata, leaving `SessionInfo.goal` stuck at
`"active"`, and the rehydrate reconciliation rules would then
*override* the runtime ("session record wins") on the next resume —
reverting the achievement. The wrapper is what keeps local mode
honest with the persistence contract; the listener-tear-down problem
that motivated `applyGoalEvent` in container mode applies in local
mode too, and the fix is the same shape.

The Tests section's "`agent-listeners.ts` short-circuits goal events out
of the chat-message accumulator (mirroring `agent_rate_limits`)" reads
correctly under this model — the SSE branch in the runner is the
primary path, and `agent-listeners.ts` still short-circuits if the
per-turn handler happens to also see the event during the brief
inside-turn window when listeners are attached. Both paths exist; the
runner is the load-bearing one.

**Cross-turn user-message delivery.** This is the inbound counterpart
to the kill suppression. `CodexAdapter.sendUserMessage` today
(codex-adapter.ts:452-455) delegates to `writeStdin`, which emits
`turn/steer` (codex-adapter.ts:436-449). `turn/steer` requires an
active `currentTurnId`, but `handleTurnCompleted` clears
`this.currentTurnId = null` right before returning (line 891). So
between turns on a kept-alive process the next `sendUserMessage` would
be a silent no-op — the agent stays alive but never gets the next
message, and the keep-alive path is structurally inert.

`CodexAdapter.sendUserMessage` therefore gains a second branch: when
`this.currentTurnId === null` (between turns on a goal-managed thread),
issue `turn/start` with the same load-bearing fields the initial
`turn/start` in `initializeAndRun` (codex-adapter.ts:1039-1056)
supplies: `threadId: this.threadId`, `input: <user message>`,
`approvalPolicy: "never"`, `sandboxPolicy: { type: "dangerFullAccess" }`,
`cwd: this.cwd`, `model: this.model`. The first two are non-optional —
without `approvalPolicy: "never"` every shell command stalls on
`item/commandExecution/requestApproval`; without
`sandboxPolicy: { type: "dangerFullAccess" }` Codex's bubblewrap
sandbox fails in-container ("No permissions to create a new
namespace"). The adapter's own comments at `initializeAndRun` call
these load-bearing.

`cwd` is already cached on the adapter (line 311); **`model` is not**
cached today, so the augmentation adds it: `CodexAdapter` stashes
`params.model` at `run()` time and reuses it for between-turn
`turn/start` calls. The reuse path in `agent-execution.ts:637`
(`existingAgent.sendUserMessage(prompt)`) keeps its existing call
site; the adapter picks the right RPC based on whether a turn is in
flight. Mid-turn steering (the existing `turn/steer` path) is
unchanged.

**Error surface.** `sendUserMessage` is `(text, _opts?) => void` —
the call doesn't await. `writeStdin` swallows failures today because
`turn/steer` failure modes are narrow. `turn/start` between turns has
broader failure modes (stale `threadId`, thread-not-yet-initialized
race on fresh respawn, post-resume re-establishment failure) that
must reach the runner, otherwise a between-turn message can be
silently dropped.

`this.emit("error", …)` is **not** the right signal for this case:
the existing `agent_error` cascade nulls `this.agent` on the worker
side (session-worker.ts:1233-1238) and broadcasts a hard error chat
message, which would tear down the kept-alive process the
augmentation is built around — exactly the lifetime regression to
avoid. The adapter needs a soft-error signal that surfaces as a
`system_notice` in chat without nulling the agent. The cleanest fit
is a new `AgentProcess` event `soft_error` (or reuse the existing
`log` event with a structured payload the runner translates), wired
in `agent-listeners.ts` to emit a `system_notice` at `level: "warn"`
and **not** propagate to the agent-disposal path. The new branch
wraps the `turn/start` call in
`.catch(err => this.emit("soft_error", err))`; existing call sites
that emit `error` for hard failures (process death, auth, etc.)
keep that signal.

**Worker-side state.** `session-worker.ts` nulls `this.agent` only on the
adapter's `done` and `error` events (lines 1228-1236, 1321). Under
augmentation, `done` fires only on process exit (kill / crash) — so
`this.agent` survives across turns when `keepAliveAcrossTurns` is true.
Two contract changes follow.

**1. `/agent/start` against an already-alive persistent process — only
on the respawn-after-crash path.** The steady-state reuse case
(persistent agent is alive between turns) does **not** issue a fresh
`/agent/start`: `runAgentWithMessage` takes the `existingAgent` branch
at agent-execution.ts:261 and routes the next turn via `sendUserMessage`
on the live `_agent`. So between-turn `/agent/start` against an alive
persistent process should not happen during normal operation. It only
happens on the recovery path described in point 2 below: the worker's
`this.agent` is null (process actually died), the goal-op handler
respawns via `_startAgentViaProxy`, and the worker is in a state where a
*stale* agent from a previous session may still be lingering in
`this.agent` even though the runner believed it was gone.

`_startAgentViaProxy` today (container-session-runner.ts:648-681) does
*not* unconditionally kill on 409 — it does a 150ms retry first to absorb
the post-`agent_done` cleanup race, and only escalates to `/agent/kill`
+ re-spawn if the retry *also* 409s (docs/142 Problem B2). That tuning
was for the `agent_done`-cleanup race, not for cross-session bleed. The
augmentation introduces a longer-lived process, which widens the window
where a stale agent from a previous session can outlive the runner that
spawned it (orchestrator restart while the worker container survived,
session-switch within a recycled container).

The contract therefore adds a **per-spawn token** `runId` (a fresh uuid
generated by the orchestrator at every `_startAgentViaProxy` call,
persisted on the runner for that spawn's lifetime). `/agent/start`'s
body schema becomes
`{ agentId: AgentId, params: AgentRunParams, runId: string }` — `runId`
sits as a **sibling top-level field**, not inside `AgentRunParams`.
Reason: `AgentRunParams` is the shared shape passed to every adapter,
including local-mode `ClaudeAdapter`/`CodexAdapter` instances that
have no container boundary; threading a container-mode identity token
through the local-mode type drags worker-coordination concerns into
adapter code. Keeping `runId` at the body-envelope level lets
`session-worker.ts` strip it before calling
`this.agentFactory(agentId, params)` and lets local-mode tests
construct `AgentRunParams` without a fake uuid.

The worker's existing 409 + 150ms retry path is unchanged — that race
fix is preserved. On the post-retry escalation, the worker compares
`this.agentRunId` against `body.runId`: a match means "persistent
agent from this same runner; reuse it" and the worker returns success
without killing; a mismatch means "stale agent from a previous runner"
and falls through to the existing kill+respawn path. This is the
addition, not a replacement of the docs/142 race fix.

**Event-history bound on `runId` reuse.** When `_startAgentViaProxy`
is called with a matching `runId` against an already-alive worker
agent, the orchestrator has just constructed a fresh
`ProxyAgentProcess` with no knowledge of events the live worker agent
may have emitted in the gap (between the previous orchestrator-side
teardown and this new spawn). To avoid chat-history group accumulation
starting mid-stream, `runId` reuse is **gated on the worker reporting
no in-flight turn** — assertable via the same `verifyRunningState()`
machinery already used elsewhere. If the worker has a turn in flight
when the runId reuse arrives, the orchestrator falls back to
kill+respawn (clean turn boundary) rather than attaching to mid-stream
state.

**`runId` must survive orchestrator restart.** A bare in-memory
`runId` would be regenerated on every orchestrator boot, so after an
orchestrator restart against a still-alive worker agent every
`/agent/start` would mismatch and trigger kill+respawn — defeating
the augmentation's keep-alive contract for exactly the recovery case
it's supposed to handle. The `runId` is therefore persisted on the
session record as part of session metadata (a separate column on
`sessions.ts`, not part of `SessionGoal`). On orchestrator startup,
the runner restores its `runId` from the session record before any
`/agent/start` call so the comparison against the worker's
`this.agentRunId` survives the restart. New sessions get a fresh
`runId` on first spawn and write it to the record at that point.

**Mixed-version compatibility.** This is a wire-shape change to
`/agent/start`'s body schema and a new instance field on the worker.
Container-mode deployments can have a newer orchestrator talking to
an older worker image (build cadence drift across the orchestrator
binary and the agent-CLI image). The compat rule: when `params.runId`
is omitted (older orchestrator), the worker preserves today's
unconditional-409-on-existing-agent behavior; when `this.agentRunId`
is null (older worker that doesn't know about the field), the
orchestrator falls back to the existing 150ms-retry → kill+respawn
path. Both directions degrade to the pre-change behavior, so neither
side regresses if the other lags a rollout.

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
  precedent. The runtime path itself is already verified working on
  0.130.0 (see the live-probe results in "Why not pass-through →
  Codex"). What's missing is the **regression-prevention machinery**
  for future Renovate bumps: without a CI gate, a future bump that
  drops the API would land silently and break sessions with active
  goals.

  That machinery is docs/141 Axis-3 plus a goal-flow extension. At
  the time of this writing, every
  [Axis-3 task](../141-cli-version-strategy/checklist.md) is
  unchecked, and the Axis-3 scope as written covers only the `claude`
  stream-json handshake and the base `codex app-server` handshake +
  flag acceptance — **not** `--enable goals` + `experimentalApi: true`
  + the three `thread/goal/*` request methods + the two notifications.
  Axis-3 itself is a multi-PR effort that cannot land in the same PR
  as this doc; the realistic ordering is:

  1. Axis-3 ships (CI job, contract-test scaffold, required merge
     gate on Renovate bumps) — a separate work stream this doc
     depends on but does not drive.
  2. A goal-flow extension to that CI job is added when Axis-3 lands,
     captured as a checklist task on
     `docs/141-cli-version-strategy/checklist.md` to make the
     dependency build-orderable.
  3. The ratcheting constant `CODEX_GOALS_RUNTIME_VERIFIED` becomes
     real once both (1) and (2) pass on the current pin.

  Concretely once both ship:
  - **Where the probe runs.** The agent CLI lives in the worker
    container, not the orchestrator host. The probe is therefore a
    one-time contract test invoked during the agent-CLI build / publish
    workflow (`docker/agent-cli/`), gated on the same CLI pin in
    `docker/agent-cli/package.json`. A passing probe ratchets a
    constant — `CODEX_GOALS_RUNTIME_VERIFIED = "0.130.0"` (or whatever
    pin is current) — committed alongside the lockfile.
  - **How the registry consumes it.** `agent-registry.ts` resolves
    `supportsGoals` at orchestrator init by comparing the current Codex
    pin against `CODEX_GOALS_RUNTIME_VERIFIED`. The "current Codex pin"
    is read at orchestrator startup from a generated constant that the
    build emits by parsing `docker/agent-cli/package.json` at build
    time — analogous to how the Codex CLI version is already surfaced
    elsewhere in the project — so the orchestrator has a synchronous,
    in-process value to compare against
    `CODEX_GOALS_RUNTIME_VERIFIED`. A match → `true`; a mismatch
    (Renovate landed a bump that the contract test hasn't re-verified
    yet) → `false`, with an explicit log line. No cold-start spawn
    cost is incurred per orchestrator boot; the expensive probe is
    amortized into the build, and both the verified constant and the
    pin constant ratchet through the same agent-CLI build pipeline.
  - **Invalidation.** A Codex pin bump triggers a fresh contract-test
    run as part of the CI gate that already exists for the agent CLI
    (docs/141). If the new pin passes, `CODEX_GOALS_RUNTIME_VERIFIED`
    is updated in the same PR; if it fails, the bump is held until the
    augmentation is brought back in line. `supportsGoals` flips off
    automatically in the meantime.
  - **Failure mode.** If `supportsGoals` is `false` registry-wide,
    every Codex session silently degrades to substrate behavior —
    setting a goal still works (the substrate uses session metadata
    and the prelude), the augmentation just doesn't activate. No
    user-facing capability rejection in the common case.

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
  removed upstream and not caught in CI): the orchestrator stops issuing
  augmentation calls for the affected session (treats it as if
  `supportsGoals` were false locally) and surfaces a `system_notice`.
  The next registry init will re-read `CODEX_GOALS_RUNTIME_VERIFIED`
  against the new pin and `supportsGoals` may flip globally then.
- **No separate activation setting.** The augmentation activates
  automatically when `hasActiveGoal(session)` **and**
  `agent-registry.get(session.agentId).capabilities.supportsGoals`. There
  is no `goalsEnabled` per-session toggle, no `/goal enable` command,
  no settings-panel switch. The lifecycle follows the goal:
  - `/goal <text>` on a Codex session with `supportsGoals` true: the
    substrate writes session metadata; the adapter's next spawn (or the
    currently-alive process, if there is one) keeps alive across turns.
  - `/goal clear`: session metadata clears; the kill-suppressor turns
    off; the next `turn/completed` kills the app-server as before.
  - Codex session with no active goal: identical to today's behavior
    (kill at every `turn/completed`).
  This removes a redundant axis (`/goal` is itself per-session;
  toggling a separate "goals enabled" boolean on top of that just
  produces two questions for the same answer) and dodges the "first
  user-settable per-session boolean" schema work. The keep-alive
  predicate is computed on each `handleTurnCompleted` from the session
  record + registry capability + agentId — see §"Post-turn flow rides
  `agent_result`" for the orchestrator-side definition and §"Process
  lifetime" for how the worker delivers the snapshot.

The `/goal pause` / `/goal resume` composer commands and the chip's
budget/time fields surface *only* when `supportsGoals` is true on the
registry. On Claude sessions (`supportsGoals: false` statically), the
augmentation-only commands are unavailable and the chip drops the
budget/time fields.

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
- `ProxyAgentProcess` — implements all three methods unconditionally
  as HTTP forwards to `POST /agent/goal`. The methods are always defined
  on the prototype; activation is gated entirely by the registry
  capability + active-goal check at the call site (`send-message.ts`'s
  intercept handler resolves both before invoking the proxy). The
  proxy's `capabilities` field stays `supportsGoals: false` per the
  docs/140 precedent — call sites read capability from the registry, not
  from the proxy.

Call sites gate on the **registry capability + active-goal check**, not
on `typeof agent.setGoal`. On `ClaudeAdapter` the methods are not
defined and the `typeof` check would fail anyway; on `ProxyAgentProcess`
the methods are always defined; on `CodexAdapter` the methods are
defined when constructed via the factory. The capability gate at the
call site is the single source of truth.

### Container-boundary proxy

Production ShipIt talks to session containers over HTTP. Mirror the existing
agent proxy chain (`session-worker.ts` already exposes `/agent/start`,
`/agent/stdin`, `/agent/message`, `/agent/interrupt`, `/agent/kill`,
`/agent/status` — all operating on `this.agent`):

- `POST /agent/goal` on the worker with body
  `{ op: "get" | "set" | "clear", goal?: …, status?: … }`. Operates on
  `this.agent`, which under the lifetime change above is the long-lived
  process. The worker has three responses:

  1. **Null agent** — `this.agent` is null. Worker returns a typed
     `{ status: "no-agent" }` response. The orchestrator-side proxy
     catches it, respawns via `_startAgentViaProxy` (using the session's
     current `runId`), and retries the goal op. See "Worker-side state"
     above.
  2. **Agent without goal support** — `this.agent` exists but is a
     Claude adapter (no `setGoal`/`getGoal`/`clearGoal` methods). Worker
     returns a typed `{ status: "unsupported", agentId }` response. The
     orchestrator surfaces a `system_notice` ("`/goal pause` is only
     available on Codex sessions with goal management enabled") and
     does not throw. This case should not happen during normal
     operation — the WS-handler capability gate catches it earlier —
     but the worker treats it as an in-band response rather than a
     throw, because a stray `/agent/goal` reaching the worker is
     diagnostic, not catastrophic.
  3. **Success** — worker invokes the adapter's goal method and returns
     the JSON-RPC response.
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
`"active" | "paused" | "cleared" | "achieved"` (substrate-flavored,
extended with `paused` so an explicit user pause survives orchestrator
restart — see §Storage above); `ThreadGoal.status` is
`"active" | "paused" | "budgetLimited" | "complete"` (augmentation-
flavored, matches the runtime continuation lifecycle). Translation:

| `ThreadGoal.status` → `SessionGoal.status` | Rule |
|---|---|
| `active` | `active` |
| `paused` | `paused` (persisted; pause survives orchestrator restart so continuation doesn't silently resume) |
| `budgetLimited` | `active` (budget limit is runtime telemetry surfaced on the chip; the persisted state stays `active` so the user can keep extending the goal or clear it) |
| `complete` | `achieved` |

| `SessionGoal.status` → `ThreadGoalSetParams.status` (used on rehydrate) | Rule |
|---|---|
| `active` | `active` |
| `paused` | `paused` (rehydrate restores the pause so the user's explicit pause survives) |
| `cleared` | (do not call `thread/goal/set` — no active goal to restore) |
| `achieved` | (do not call `thread/goal/set` — the user already confirmed achievement; the runtime should start fresh on the next user-set goal) |

`budgetLimited` is the only runtime status that isn't persisted on the
substrate. The chip surfaces it from the in-memory `ThreadGoal` cache;
across an orchestrator restart it zeroes out until the next
`thread/goal/updated` arrives.

**Rehydrate mechanism.** `thread/resume`'s response does **not**
include a goal field. So on rehydrate the adapter issues an
out-of-band `thread/goal/get` after the initialize / `thread/resume`
handshake completes, reads the returned `goal: ThreadGoal | null`, and
reconciles it against `SessionGoal` per the authority rules below.

This is **gated**: the adapter issues `thread/goal/get` only when
the session has *ever* had a goal — derivable from the existing
`SessionGoal` shape without a separate sticky bit. The predicate is
`session.goal != null` (any goal record present, regardless of
status: `active`, `paused`, `cleared`, or `achieved`). Once `/goal
clear` runs, the record stays on the session with
`status: "cleared"` rather than being deleted, so this predicate is
true for any session that has ever set a goal and false for
cold-start sessions that never have. No new column or sticky bit
required.

Cold-start sessions that never had a goal don't pay the round-trip
— which is the common case until `/goal` adoption is wide.

The rehydrate call **blocks the first turn after resume**: the
`Source-of-truth reconciliation` rules below may issue
`thread/goal/clear` or `thread/goal/set` based on the result, and a
user message arriving on a thread whose goal state hasn't been
reconciled yet races those calls. Blocking adds one round-trip of
latency per resume on sessions that ever had a goal — measured in
single-digit ms against the local app-server, acceptable for a
once-per-resume cost.

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
  `lastTokenUsage` are reset on the next `turn/started` notification;
  `pendingRequests` survives across turns (it's a JSON-RPC correlation
  map, not turn state); `agent-listeners.ts` rewiring is explicit.
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
- `/goal status` with no record (or a cleared record) → emit
  `goal_status` with `goal: null`. The client refreshes the chip
  (which stays hidden) but does not record a clearedAt timestamp or
  render an inline "Goal cleared" message — that's what
  `goal_cleared` is for. (An achieved record returns a populated
  `goal_status.goal` so the chip can render the achieved state.)

Codex augmentation:

- App-server rejects `--enable goals` (CLI moved between the registry
  probe and the session spawn — rare but possible after a Renovate bump
  mid-orchestrator-lifetime): surface a `system_notice` at `level: "warn"`,
  treat the session as if `supportsGoals` were false (the adapter falls
  back to substrate behavior — no `--enable goals` retry, no augmentation
  spawn args), and let the substrate carry the goal. A later registry
  refresh re-evaluates the probe constant and may drop `supportsGoals`
  globally if the new CLI doesn't accept the flag.
- App-server returns "goals feature is disabled": configuration bug in
  the adapter — log the raw response.
- `thread/goal/set` fails because the thread hasn't been created: surface
  the error inline; the substrate's session-stored goal is already
  persisted, so the chip still shows the goal even though continuation
  hasn't started.
- Persistent app-server crashes mid-session: `verifyRunningState()`
  resets the local `running` flag, and the next operation transparently
  respawns via `_startAgentViaProxy`. For send-message, the existing
  contract applies as-is. For `/goal` ops, the worker returns the typed
  `{ status: "no-agent" }` response described in "Container-boundary
  proxy → 1. Null agent"; the orchestrator-side proxy catches it,
  respawns via `_startAgentViaProxy`, and retries the goal op. From the
  user's perspective the behavior is identical to send-message respawn
  (a slightly slower op one time, no surfaced error); the typed
  response is the wire-level mechanism the proxy uses to drive the
  respawn rather than parsing 5xx errors out of `/agent/goal`.

## Key files

Substrate (docs/132 Bucket-4 wiring):

- `src/server/orchestrator/sessions.ts` — persist `SessionGoal` on
  session metadata (new `goal_json` SQLite column + DatabaseManager
  migration + setters mirroring `setBranchRenamed` / `setAgentPinned`).
  Not modeled on `getLiveSteering()`, which is app-wide.
- `src/server/shared/types/domain-types.ts` — `SessionInfo` gains
  optional `goal?: SessionGoal | null`.
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
- `src/server/session/session-worker.ts` — `POST /agent/goal`
  endpoint; new `runId` field on `POST /agent/start`'s request body and
  the worker's per-agent state (`this.agentRunId`); extended
  already-running comparison logic.
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
  this doc extends to Codex via the `goalsKeepAlive` predicate
  computed in the orchestrator from session-record + registry +
  agentId — gated on the presence of an active goal, *not* on live
  steering).
- [docs/141-cli-version-strategy/plan.md](../141-cli-version-strategy/plan.md)
  and its checklist — the contract-test scaffolding (Axis 3) that
  `supportsGoals` resolution depends on. The Codex augmentation cannot
  ship before Axis 3 lands; this doc consumes the
  `CODEX_GOALS_RUNTIME_VERIFIED` constant Axis 3 will ratchet.
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
