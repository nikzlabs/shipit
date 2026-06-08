# Goal command — implementation checklist

Tracks the precondition and implementation work for `plan.md`.

## Preconditions (land before / alongside the substrate)

- [ ] Amend `docs/132-slash-commands/plan.md` §"`/goal` as a native
      feature" and its Key files list: the injection point is
      `assembleAgentPrompt` in `agent-execution.ts`, not
      `agent-instructions.ts`. The plan in this doc explains why
      (cache-stability contract + persistent-process reuse).
- [ ] Design the `SessionGoal` SQLite schema (JSON column vs four
      columns) and add the DatabaseManager migration. Extend
      `SessionInfo` in `domain-types.ts` with optional `goal`.
- [ ] Run both Claude probes (legacy PTY-shape, streaming-input)
      against the pinned CLI directly, and record results in plan.md
      as a "Probe results" subsection. **These probes do NOT block
      the substrate** (the substrate intercepts `/goal …` before it
      reaches `claude` on either spawn shape; the probe outcome only
      informs a future Claude-augmentation revisit). Run before any
      future Claude-augmentation work; defer if not blocking the
      substrate PR.

## Preconditions for the Codex augmentation only

- [ ] docs/141 Axis-3 contract-test scaffolding lands (CI job, contract
      test, required merge gate on Renovate bumps).
- [ ] Extend the Axis-3 CI job with a goal-flow contract test
      (`--enable goals` + `experimentalApi: true` + the three
      `thread/goal/*` request methods + the two notifications). Add as
      an explicit checklist item on the CLI contract-test work stream.
- [ ] Land the `CODEX_GOALS_RUNTIME_VERIFIED` constant once both pieces
      pass on the current pin.
- [ ] Probe `thread/resume`'s response shape on a thread that
      previously had a goal set: does it embed the goal, or must
      `thread/goal/get` be called separately on rehydrate? Run as part
      of the same harness as the runtime-acceptance probe; the
      rehydrate-mechanism section in plan.md picks the design based
      on the result.
- [ ] Run the mid-turn-pause probe: send
      `thread/goal/set { status: "paused" }` concurrent with an
      in-flight `turn/start`'s response stream and record whether
      (a) the pause takes effect, (b) it's queued to turn boundary, or
      (c) the response stream / `pendingRequests` correlation map
      interleaves safely. Test both acceptance and JSON-RPC
      interleaving safety.

## Substrate work

- [ ] `SessionGoal` type, setters on `SessionManager`, DB column(s) +
      migration.
- [ ] Bucket-4 intercept in `send-message.ts` (before `runner.running`
      check; routes `/goal`, `/goal status`, `/goal clear`,
      `/goal pause`, `/goal resume`, bare `/goal`).
- [ ] Shared `applyGoalPrelude(text, goal)` helper.
- [ ] Thread the prelude through all four turn-start paths:
      `runAgentWithMessage` (via extended `assembleAgentPrompt`),
      `handleAnswerQuestion` (all branches), live-steering injection in
      `handleSendMessage`, and `runDispatchedTurn`.
- [ ] Three new WS server messages: `goal_updated`, `goal_cleared`,
      `goal_status`. Help / empty / rejection prose reuses
      `system_notice`.
- [ ] Composer `/`-autocomplete entry for `/goal`, capability-aware (no
      `/goal pause` / `/goal resume` outside augmentation).
- [ ] Client goal-store slice + chip rendering on the chat surface.

## Codex augmentation work

- [ ] `CodexAdapter` spawn args under augmentation:
      `["app-server", "--enable", "goals"]` and
      `initialize.capabilities.experimentalApi: true`.
- [ ] `getGoal()` / `setGoal({ objective?, status?, tokenBudget? })` /
      `clearGoal()` on `CodexAdapter`. Defensive response un-nesting.
- [ ] `agent_goal_updated` / `agent_goal_cleared` `AgentEvent` variants;
      `agent-listeners.ts` short-circuit (mirroring `agent_rate_limits`).
- [ ] Plumb `SessionManager` (or a narrow
      `setSessionGoal(sessionId, goal)` callback) into
      `ContainerSessionRunner` via `SessionRunnerRegistry`,
      `app-di.ts`, and the warm-session pool. Required so the
      augmentation's `applyGoalEvent` has a home for the metadata
      write; the substrate's intercept in `send-message.ts` does not
      need this.
- [ ] `handleSSEEvent` goal-event branch in `ContainerSessionRunner` —
      `applyGoalEvent` runner method writes session metadata + emits
      WS message.
- [ ] Kill-suppressor: gate `handleTurnCompleted`'s kill on
      `keepAliveAcrossTurns`.
- [ ] `CodexAdapter.sendUserMessage` between-turn branch: when
      `currentTurnId === null`, issue `turn/start` with the same
      load-bearing fields as the initial `turn/start`
      (`approvalPolicy`, `sandboxPolicy`, `cwd`, `model`) plus
      `threadId` and the message as `input`. Cache `model` on the
      adapter at `run()` time (`cwd` is already cached).
- [ ] Add a `soft_error` event (or equivalent structured `log`-event
      shape) to `AgentProcess` that `agent-listeners.ts` translates
      into a `system_notice` without invoking the agent-disposal path.
      Wire `turn/start` between-turn failures through this signal so
      they reach chat without nulling `this.agent`.
- [ ] Post-turn flow remap onto `agent_result` for `keepAliveAcrossTurns`
      sessions (mirroring docs/140's pattern, widening from
      `useStreaming`).
- [ ] `/agent/goal` worker endpoint with three-response contract
      (success / `no-agent` / `unsupported`).
- [ ] `worker-http.ts`, `ContainerSessionRunner`, `ProxyAgentProcess`
      proxy methods.
- [ ] `runId` per-spawn token on `/agent/start` as a sibling
      top-level field on the body schema (not inside `AgentRunParams`,
      per the plan's pin). Orchestrator + worker sides + mixed-version
      compat.
- [ ] Rehydrate: `thread/goal/get` after `thread/resume`; gate on
      `session.goal != null` so cold-start sessions don't pay the
      round-trip; reconcile per the authority-on-conflict rules in
      the plan. Persisted `cleared` / `achieved` records (rather than
      deleted ones) make this predicate work without a separate
      sticky bit.
- [ ] AgentRunParams gains a single `goalsKeepAlive` boolean,
      refreshed on every turn-start delivery via the existing
      send-message envelope. Distinct from the orchestrator-side
      derived `keepAliveAcrossTurns` predicate (which is a per-agent
      multiplexer over `goalsKeepAlive` and `useStreaming`); only
      `goalsKeepAlive` crosses the container boundary.

## After ship

- [ ] If the streaming-input Claude probe shows `/goal` dispatches over
      stream-json `user` messages, revisit docs/132 then this doc to
      decide whether a Claude-augmentation path is worth adding.
- [ ] If pause behavior reveals additional needs in production (e.g.
      explicit "auto-resume after N hours" semantics), revisit the
      pause lifecycle — the v1 `pausedAt` timestamp is the foundation
      such a feature would build on.
