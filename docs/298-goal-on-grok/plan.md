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
| Rich goal events | `updates.jsonl` carries a `goal_updated` ACP update (69 in one run) with `goal_id, objective, status, phase, tokens_used, elapsed_ms, total_deliverables, completed_deliverables, total_worker_rounds, total_verify_rounds, last_event, last_event_detail`. It reaches stdout only under `--output-format streaming-json` |

### Two measured negatives worth keeping

**Grok has no resume-continuation hazard.** docs/154 needed a "resume hold"
because resuming a Codex thread with an active goal makes Codex start its own
continuation turn and fold the user's message into it. Grok does the opposite: it
pauses the goal and answers the user. A future reader should not port the hold.

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
- **Learning a goal a turn created.** `set` and `resume` ride a turn, so ShipIt
  has to find out what the turn left behind. When a turn's prompt was a `/goal`
  command, the adapter runs one `/goal status` read as the process closes and
  emits `agent_goal_updated` before `done`. That is one extra 5 ms, zero-token
  spawn on goal turns only; ordinary turns spawn nothing. `agent_goal_updated`
  already exists and is handled agent-agnostically.

### Orchestrator and client

- `goalStatusLabel` and the chip learn Grok's `user_paused`. Because every
  `grok -r` process leaves an active goal paused, a Grok goal reads as paused
  between turns — which is honest, since nothing is driving it.
- The chip's hint becomes action-aware: a paused goal offers `/goal resume to
  continue` beside `/goal clear to remove`. That is where the user meets the
  paused state, and there is no post-`set` notice to carry it, because `set`
  rides the turn.
- `reconcileAgentGoal` (docs/154's read-on-open) needs no change: it calls the
  same `goalCommand`.

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
- `src/server/orchestrator/services/agent-goal.ts` — `user_paused`'s label.
- `src/client/components/GoalChip.tsx`, `MessageInput/MessageInput.tsx`, `utils/send-handler.ts`.
