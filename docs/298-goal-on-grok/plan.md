---
title: "`/goal` on Grok Build"
description: "Grok's native goal loop behind ShipIt's `/goal` command: reads and stops answered out of band at zero cost, while setting and resuming ride an ordinary turn."
issue: planning#529
---

# `/goal` on Grok Build

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md).

## Problem

[docs/154](../154-native-goal-command/plan.md) built an agent-agnostic `/goal`
pipeline — parser, interception, persistence, chip — and only Codex declared the
capability. Grok Build ships its own goal loop with the same vocabulary, so the
work here is a Grok adapter and one capability declaration, not a second
pipeline.

Grok's loop differs from Codex's in one way that decides the whole design: Codex
answers goal requests over JSON-RPC without touching the model, so ShipIt can
answer every action out of band. Grok answers `status`, `pause` and `clear` the
same way, but `set` and `resume` **run the agent** — a planner, implementer
subagents and a verifier, spending tokens and editing files. Work like that
outside a ShipIt turn would have no transcript, no auto-commit and no interrupt
button, so it must ride a turn instead.

## Measured on `@xai-official/grok` 1.0.18

Probed on 2026-09-12 against the pinned binary with ShipIt's own spawn flags
(`--output-format streaming-messages-json --no-auto-update --trust --cwd <dir>
-s|-r <sessionId> --always-approve --prompt-file <file>`) and an `XAI_API_KEY` in
the environment.

| Question | Answer |
|---|---|
| Slash commands in `init` | `compact, always-approve, context, session-info, feedback, deep-research, workflow, goal, loop` |
| Does a goal command need credentials? | Yes — a sign-in check runs before the command. It makes no network call, so a signed-in session answers offline |
| `/goal status`, no goal | `No goal is currently set. Use /goal <objective> to start one.` — `num_turns: 1`, 0 tokens, `total_cost_usd: 0`, 4–6 ms |
| `/goal status`, with a goal | Four lines: `Goal: <objective>` / `Status: <Status> \| Phase: <Phase>` / `Goal tokens used: <n>` / `Elapsed: 4m39s`. Same zero cost |
| `/goal pause` | `No goal is currently set.` or `Goal is already paused.` or `Goal paused.` — zero cost, ~5 ms |
| `/goal clear` | `Goal cleared.`, and `<session>/goal/state.json` is deleted. Zero cost, ~11 ms. Answers `Goal cleared.` even with no goal |
| `/goal resume` | **Not a read.** Re-enters the goal loop and keeps working until the goal finishes or the process is killed. Real tokens |
| `/goal <objective>` | Runs planner → implementer subagents → verifier rounds. One probe ran for minutes and 250k goal tokens |
| Does the control spawn enter the model's context? | No. The command and its answer land in `updates.jsonl` and `prompt_history.jsonl`, never in `chat_history.jsonl` |
| Where does goal state live? | `<GROK_HOME>/sessions/<url-encoded cwd>/<sessionId>/goal/{state.json,plan.md,plan.baseline.md}` — so a control spawn must use the same cwd and `GROK_HOME` the turn used |
| `state.json` fields | `goal_id, objective, status, phase, token_budget, elapsed_ms, created_at, tokens_used_high_water, history[]` |
| Status words seen | `active`, `user_paused`, `cleared`; phases `executing`, `idle` |
| Resuming a session with an **active** goal | Grok answers the user's prompt normally in one turn and does **not** continue the goal |
| …and the goal afterwards | `user_paused`. Any `grok -r` process leaves an active goal paused |
| A control spawn during a running turn | Answers correctly, but two processes then write one session directory: a read taken mid-run wrote `user_paused` into `state.json` while the running loop still drove the goal, and the loop later overwrote it |
| `/goal stop` (an unsupported keyword) | Sets a goal literally named `stop` and starts the loop |
| `/goal status` with text **before** it (`The branch was reset.\n\n/goal status`) | **Not a command.** 8 turns, $0.035, no goal written — an ordinary model turn |
| `/goal status` with text **after** it (`/goal status\n\nAttached files:\n- src/foo.ts`) | **Worse than not a command.** 4 turns, $0.031, and it **set a goal** whose objective is literally `status\n\nAttached files:\n- src/foo.ts`. Even the keyword `status` became an objective |
| `--permission-mode plan` on a prompt asking for a file write | The model called `run_terminal_command`, the run ended `error_during_execution` after 1 turn, and **no file was created** |
| `-r` with a session id the CLI does not know | The process **hangs**, so the control spawn's timeout is load-bearing |
| `-r` with a known id but a different `--cwd` | Resolves the session anyway ("found locally (originally in …)") and reports the right goal, creating no second session directory |
| Rich goal events | `updates.jsonl` carries a `goal_updated` ACP update (69 in one run) with `goal_id, objective, status, phase, tokens_used, elapsed_ms, total_deliverables, completed_deliverables, total_worker_rounds, total_verify_rounds, last_event, last_event_detail`. It reaches stdout only under `--output-format streaming-json` |

### Two measured negatives worth keeping

**Grok has no resume-continuation hazard.** docs/154 needed a "resume hold"
because resuming a Codex thread with an active goal makes Codex start its own
continuation turn and fold the user's message into it. Grok does the opposite: it
pauses the goal and answers the user. A future reader should not port the hold.

**Grok holds no goal in process memory, so a control spawn is never reading a
copy.** Grok runs one process per turn (`isStreaming: false`; it refuses
steering), and the goal is a file — `<session>/goal/state.json`. A control read
taken while a `grok -r` turn drove the goal reported that turn's live values, not
a stale snapshot. A harness that kept the goal in a resident process would instead
let a control spawn clear a copy while the real goal kept steering the next turn,
which is the failure this design would otherwise have to defend against.

What a control spawn cannot do during a live turn is **change** the goal: a read
taken mid-run wrote `user_paused` into `state.json`, and the running loop
overwrote it back to `active`. That is why goal commands are refused while a turn
is running, and why a turn is refused while a control spawn is in flight. The
`clear` case specifically was not measured mid-run — with the refusal on both
sides it is unreachable — but it is the same class of write.

**The stream ShipIt reads cannot report the goal.** `streaming-messages-json`
carries only `system`, `assistant`, `user` and `result` lines; the whole
`goal_updated` update is dropped. Watching the existing stream, which would have
been the cheaper mechanism, is not available without re-plumbing the adapter's
parser onto `streaming-json` — see [Follow-up](#follow-up).

## Design

### Which actions ShipIt answers, and which ride a turn

`AgentCapabilities.goalActions` (added for this feature and the parallel Claude
Code work) says, per action, how ShipIt handles it: `"control"` is answered out
of band, `"turn"` means the user's text rides the turn, and an absent action is
refused. An absent field means every action is `"control"`, so Codex is unchanged
(req 8).

```ts
goalActions: { get: "control", pause: "control", clear: "control", set: "turn", resume: "turn" }
```

`set` and `resume` are `"turn"` because they were measured doing real agent work
(req 7). Riding the turn also means the user gets Grok's own answer in the
transcript, and needs no ShipIt notice for those two.

`send-message.ts` consults the map before the auth gate, exactly as before;
`handleGoalCommand` refuses an absent action. The client mirrors it in the `/`
menu and in `send-handler.ts`, where a `"turn"` action must keep its message
bubble and spinner because a turn really does follow.

### A `"turn"` action is only native when the prompt is exactly the command

Measured: text **before** `/goal …` stops Grok treating it as a command at all,
and text **after** it is worse — the command still runs, with the trailing context
folded into the objective, so the session ends up with a goal nobody asked for.
A test that only asserts "a goal was set" would pass on that. ShipIt assembles a
turn's prompt as
`agentPrefix + assembleAgentPrompt(...)` (`agent-execution.ts`,
`prompt-assembly.ts`), which places a slash invocation first but appends file,
image, dictation and role context after it, and prepends any pending notice.

So a `"turn"` goal action runs as a **verbatim** turn, which
[docs/297](../297-goal-on-claude/plan.md) built for the same measurement on Claude
Code and this feature shares: `ridesTurnGoalCommand(text, capabilities)` decides it
from the message and the harness's own map, and the prompt becomes the user's text
and nothing else. Derived rather than threaded, the way compaction derives
`compact`, so a `/goal` queued while another turn ran is still verbatim when it
drains. The adapter needs no change — it already writes `params.prompt` byte for
byte to its prompt file.

Skipping the context must not lose it, so two things go with it:

- **Nothing that would have ridden the prompt is consumed.** The role's standing
  instructions (`takeRoleStandingInstructions` is a *take*), the pending-agent
  notice, the bug-outcome notice and the pre-turn reset are all skipped on a
  verbatim turn, so they are still pending for the next ordinary one rather than
  eaten by a message that could not carry them.
- **A `/goal` message carrying images, files or uploads is refused** with a
  persisted notice telling the user to send them separately. Those the user can act
  on, so saying so beats a silent drop. Uploads count: they become validated files,
  so they append context like the rest.

The same prefix would stop a `/skill` invocation being recognised on any harness.
That is a wider pre-existing defect, filed separately; `assembleAgentPrompt`'s
existing branches are deliberately untouched here.

### Adapter (session side)

- `grok/grok-goal.ts`
  - `parseGrokGoalAnswer(text)` turns Grok's answer into a result. It recognises
    the "no goal" wordings, the four-line report, and the clear/pause
    acknowledgements; anything else is `unknown`, which the adapter reports as a
    failure rather than as "no goal" — a clear can fail while still printing
    text, so a wrong "no goal" would hide a goal that is still loaded.
  - `parseElapsedSeconds` reads `4m39s`, `2h3m4s`, `45s` into `timeUsedSeconds`.
  - `runGrokGoalControl` spawns one short-lived `grok` with the same flags,
    `cwd`, `HOME` and `GROK_HOME` a turn uses, reads the `result` line, and ends
    the process tree (15 s limit).
- `GrokAdapter.goalCommand(threadId, command)` refuses while a turn is running
  (`this.proc`), since two processes then share one session directory, and
  otherwise runs the control spawn. It refuses `set` and `resume` defensively:
  they are `"turn"` actions and should never reach it.
- **`run()` refuses the mirror case**, while a control spawn is in flight for that
  session. WS frames are not serialised, so `/goal clear` immediately followed by
  `/goal <objective>` would otherwise put the clear's confirming read and the new
  goal's loop on one session directory — and the clear could land after the new
  goal was set. Whichever starts first, the other waits; the refusal names the
  reason, and the window is about a second.
- **Learning a goal a turn created.** `set` and `resume` ride a turn, so ShipIt
  has to find out what the turn left behind. When a turn's prompt carried a
  `/goal` command, the adapter runs one `/goal status` read as the process closes
  and emits `agent_goal_updated`. That is one extra 5 ms, zero-token spawn on goal
  turns only; ordinary turns spawn nothing. `agent_goal_updated` already exists
  and is handled agent-agnostically.
- **The goal turn holds its `agent_result` until that read finishes.** The
  orchestrator drains its queue on `agent_result`, not on `done`
  (`turn-executor.ts`), so emitting the result first would let a queued message
  spawn a second `grok -r` on the same session while the read ran — the concurrent
  writer the measurements warn about. Holding one event is the whole mechanism;
  an ordinary turn's result is never held. Because that event gates the commit, the
  queue drain and every viewer's "finished", the hold is bounded twice — the control
  spawn's own budget, and a hard grace past it — and the result is released in a
  `finally`, so a read that throws, times out or never settles still ends the turn.
  A read that lands after its deadline is dropped rather than reported late.
- The control spawn carries the turn's `COMPAT_TOGGLES`, so it cannot run a
  compatibility hook (`GROK_CLAUDE_HOOKS_ENABLED` and friends) that an ordinary
  Grok turn disables — otherwise a `/goal status` read could execute a repository
  hook outside a turn.

### Orchestrator and client

- `goalStatusLabel` and the chip learn Grok's `user_paused`. Because every
  `grok -r` process leaves an active goal paused, a Grok goal reads as paused
  between turns — which is honest, since nothing is driving it.
- The chip's hint becomes action-aware: a paused goal offers `/goal resume to
  continue` beside `/goal clear to remove`. That is where the user meets the
  paused state, and there is no post-`set` notice to carry it, because `set`
  rides the turn.
- `reconcileAgentGoal` (docs/154's read-on-open) calls the same `goalCommand`, now
  through docs/297's `goalAgentFor`: `createAgent` supersedes whatever holds the
  agent slot and settles a live turn a second time, so the read uses an installed
  agent as it is, fills only an empty slot, and returns null while a foreign agent
  holds it. Returning null records nothing, so the next activation tries again.

### What ShipIt does not do

`/goal stop` reaches Grok as a `set` with the objective `stop`, because ShipIt's
parser maps only `clear`, `pause`, `resume` and `status` to actions. Grok then
sets a goal named "stop" — which is what Grok's own CLI does with that text, and
`set` is passed through rather than interpreted. Claude Code needs the opposite
(the sibling work refuses `pause` and `resume` there so an unsupported keyword
cannot become an objective), which is why `goalActions` is a record and not a
list.

## Follow-up

A richer chip — phase, deliverables completed, worker and verify rounds — is
available in Grok's `goal_updated` update, but only under `--output-format
streaming-json`, the agent's native ACP format. Switching would re-plumb every
event the Grok adapter parses (`stream.ts`, `grok-tool-normalizer.ts`, the
`assistant`/`user`/`result` mapping) and is deliberately out of scope here. The
fields it would unlock are in the measurement table above.

## Key files

- `src/server/session/agents/grok/grok-goal.ts` — answer parser and control spawn.
- `src/server/session/agents/grok/adapter.ts` — `goalCommand`, the post-goal-turn read, `supportsGoals`.
- `src/server/shared/catalogue/harnesses.ts` — the `grok` block's `goalActions`.
- `src/server/shared/types/agent-types.ts` — `goalActions`.
- `src/server/orchestrator/ws-handlers/send-message.ts`, `goal-command.ts` — the gate and the refusal.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — `ridesTurnGoalCommand`, shared with docs/297.
- `src/server/orchestrator/services/agent-goal.ts` — `user_paused`'s label.
- `src/client/components/GoalChip.tsx`, `MessageInput/MessageInput.tsx`, `utils/send-handler.ts`.
