---
title: "`/goal` on Claude Code"
description: "Claude Code's own `/goal` store behind ShipIt's goal pipeline: `/goal` and `/goal clear` answered out of band, `/goal <condition>` riding the turn, and the chip kept honest by a zero-cost read after each goal-bearing turn."
issue: planning#528
---

# `/goal` on Claude Code

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md).

## Problem

[docs/154](../154-native-goal-command/plan.md) built an agent-agnostic `/goal`
pipeline — parser, interception, persistence, chip, worker route — and wired
exactly one harness to it. Its backend table recorded Claude Code as having "no
programmatic surface (TUI-only)". That is wrong on the pinned CLI: `/goal` is a
real command there, it is handled **locally by the CLI**, and it works inside
ShipIt's own transport. So a Claude session can already carry a goal that steers
every turn while ShipIt shows nothing and offers no way to remove it — the
production gap docs/154 was written to close, still open on the default backend.

## Measured on `@anthropic-ai/claude-code` 2.1.260

Probed on 2026-09-12 against the pinned binary, spawned exactly as
`claude/process.ts` spawns it (`--print --input-format stream-json
--output-format stream-json --verbose`), with and without ShipIt's
`--settings /etc/shipit/managed-settings.json`.

| Question | Answer |
|---|---|
| Is `/goal` available headless? | Yes — the `init` event lists `goal` in `slash_commands` |
| Vocabulary | `/goal` (status), `/goal <condition>` (set), and one of `clear stop off reset none cancel` (clear). **No pause, no resume** |
| Answer shape | An assistant message with `is_meta: true` and `local_command_source: "<local-command-stdout>…</local-command-stdout>"`, and the same text as the `result` event's `result` |
| Read, no goal | `No goal set. Usage: `/goal <condition>`` — `num_turns: 0`, 0 tokens, `total_cost_usd: 0`, 24–59 ms |
| Read, goal set | `Goal active: <condition> (not yet evaluated)`, or `(N turns)` once evaluated, plus an optional `\nLast check: <reason>` line |
| Clear, no goal | `No goal set` |
| Clear, goal set | `Goal cleared: <condition>` — also free and turnless |
| Set | `Goal set: <condition>`, and **the CLI starts working toward the condition in that same process at once** |
| Condition limit | 4000 characters; over it the CLI answers `Goal condition is limited to 4000 characters (got N)` and sets nothing |
| Set can be refused | Yes — hooks disabled or an untrusted directory answer with a message instead of `Goal set:` |
| Does it survive the process? | Yes. Set in one run, killed 200 ms after the acknowledgement, a second run with `--resume` read `Goal active: … (not yet evaluated)` |
| Session id across `--resume` | Preserved; every event carries the original `session_id` |
| Mechanism | A session `Stop` hook plus an evaluator that checks the condition before the agent may stop. Achieving it clears the goal |
| Where the goal lives | **In the running process**, not on disk: a second CLI on the same session restores it from the transcript, and a change either side makes is invisible to the other (measured both ways) |
| `--tools ""` | Empties the built-in tool set (`init.tools` is `[]`) and the command still answers. `--allowedTools ""` does NOT: it is a permission allowlist |
| Set under ShipIt's `--settings` | Works — ShipIt's own `Stop` hook does not gate it |
| The model cannot set one | `ProposeGoal` is interactive-only: "Goal proposals are only available in interactive local sessions" |

**The stream reports a goal only when it is set.** Three separate probes:
resuming a session with an active goal emits nothing about the goal, although
the goal does steer that turn; a goal that is evaluated and achieved emits
nothing when it auto-clears (set → met inside the same turn → the next read said
`No goal set`, with no goal event anywhere between); and there is no clear
notification. This is the one place docs/154's Codex design does not carry over,
and it is why the chip needs a read rather than an observation (below).

**The CLI reads `/goal` as its own command only when the prompt is exactly the
command**, and both halves of ShipIt's ordinary prompt assembly break it — in
different ways, so both were measured:

| Prompt | Outcome |
|---|---|
| `A previous PR was merged…\n\n/goal the file q.txt exists` | **No goal at all.** No acknowledgement; the model read it as prose and improvised — 4 turns, $0.12 |
| `/goal the file r.txt exists\n\nAttached files:\n- src/foo.ts …` | **Goal set, wrong objective**: `Goal set: the file r.txt exists\n\nAttached files:\n- src/foo.ts (contents omitted)` |

**A control read during a running turn is not clean.** Reading on the live
session id while a turn ran did answer correctly, but the second process
replayed the live session's pending background-task notification and emitted an
extra `init` and an empty `result` first, while both processes appended to the
same session file. Per requirement 7's "simplest mechanism wins", a `/goal`
command that arrives during a running turn is refused with a notice rather than
raced.

## Design

Everything below rides docs/154's pipeline. No change to `AgentGoal`,
`AgentGoalCommand`, `AgentGoalCommandResult`, the worker route, or Codex.

### Three classes of `/goal` action, not two

| Action | Claude Code | ShipIt |
|---|---|---|
| `get` (`/goal`, `/goal status`) | free, turnless | intercepted, answered from a control process |
| `clear` | free, turnless | intercepted, answered from a control process |
| `set` (`/goal <condition>`) | starts work at once | **not intercepted** — it rides the turn path (req 7) |
| `pause`, `resume` | do not exist | intercepted and **refused** with a notice |

Refusing `pause`/`resume` is load-bearing rather than tidy, and measured: the
CLI's clear keywords are `clear stop off reset none cancel`, so `/goal pause`
reaching the CLI is read as a *condition*, and the CLI answered
`Goal set: pause`. A refusal must therefore still be **intercepted** — passing
it through is the bug, not the fallback.

One optional capability field carries all three states, absent on Codex, which
keeps the full vocabulary (req 8):

```ts
goalActions?: Readonly<Partial<Record<AgentGoalCommand["action"], "control" | "turn">>>;
```

`{ get: "control", clear: "control", set: "turn" }` on `claude`. An absent
action is refused; an absent field means every action is "control". It drives
the interception gate, the `/` menu (req 5) and the refusal notice (req 4).
Handling is looked up **per action**, never derived from which action it is:
Grok's `/goal resume` runs real work too, so it is `"turn"` there while `set` is
`"turn"` here.

**`/goal stop` is not special-cased, and works.** ShipIt's parser maps only
`clear` to a clear, so `/goal stop` parses as a `set`, rides the turn, and the
CLI — for which `stop` *is* a clear keyword — answers `Goal cleared: <condition>`
in 0 turns at 0 cost (measured). The chip is then stale for the length of that
turn and the post-turn read removes it. Teaching ShipIt's parser the CLI's
keyword list would be a second, harness-specific vocabulary to keep in sync for
no gain.

### Adapter (session side)

- `claude/claude-goal.ts`
  - `parseGoalAnswer(text)` — the CLI's own output shapes, listed above, mapped
    to `AgentGoal | null`, or a thrown error for a refusal. It keys on the
    templates read out of the pinned binary, and only ever runs on a
    `local_command_source` / `result` string, never on model prose.
  - `runClaudeGoalControl({ threadId, command, cwd, env })` — a short-lived
    `claude --print … --resume <threadId>` whose whole prompt is the `/goal`
    text. It reads the `result` event and ends the process tree. 15 s limit, the
    same as Codex's control process.
- `ClaudeAdapter.goalCommand(threadId, command)` picks one of three paths:
  - **A turn is running** → refused, for the concurrency reason above. The
    orchestrator turns that into the "wait for the turn to finish" notice.
  - **A resident CLI is alive** → the command goes down its stdin. Live steering
    is on by default and keeps one CLI across turns, and the goal lives in *that
    process's* memory: a control process would clear a copy and leave the real
    Stop hook in force, so ShipIt would say "Goal cleared", hide the chip, and
    the next turn would still follow the goal — the docs/154 incident, rebuilt.
    The adapter consumes the answer and the zero-turn `result` that follows it,
    so neither reaches the transcript or the turn machinery, where a `result`
    reads as a CLI-started turn.
  - **Otherwise** → `runClaudeGoalControl`.
  - `set` is refused on every path. Nothing routes one here (`goalActions` marks
    it `"turn"`), and refusing rather than running it is what keeps requirement 7
    true if something ever does.
- `ClaudeAdapter` watches its own stream for the set acknowledgement: an
  assistant event with `is_meta: true` whose `local_command_source` contains
  `Goal set: <condition>` becomes an `agent_goal_updated` event. The gate is the
  structured CLI-only field, not the assistant text — the model cannot produce a
  `local_command_source`, so this cannot be spoofed by anything the model says.

`AgentGoal` from Claude Code carries `tokenBudget: null`, `tokensUsed: 0`,
`timeUsedSeconds: 0`, `updatedAt` = now in Unix seconds, and `status` = the
CLI's own word (`active`).

### Orchestrator

- `send-message.ts` — an action the harness marks `"turn"` is left alone and
  becomes an ordinary turn. Everything else is intercepted, refusals included.
- `agent-execution.ts` — a `"turn"` goal command is delivered **verbatim**, for the measured reason
  above. The notices that would otherwise have ridden it are left *unconsumed*
  for the next ordinary turn rather than eaten, since they are read with
  `consume…` calls that cannot be undone.
- A `/goal` that carries images or files is refused with a notice asking for
  them in a separate message: verbatim delivery leaves attachments nowhere to
  go, and folding them in is exactly the measured "wrong objective" failure.
- `goal-command.ts` — an action outside `goalActions` is refused before the
  adapter is reached, with one notice naming the alternative ("Claude Code has
  no goal pause — use `/goal clear` to remove the goal."). A command that
  arrives while a turn is running is refused with its own notice.
- **Post-turn read (req 2).** `refreshAgentGoalAfterTurn` in
  `services/agent-goal.ts` runs on the runner's `idle` event — last of all,
  after commit and PR work, with the agent process already gone. It reads the
  goal only when the session currently *shows* one, so a session without a goal
  costs nothing and the common case is unaffected. It is best effort: a
  container that goes away leaves the correction to the next activation read,
  which docs/154 already does.

  This is a per-turn extra process, allowed only where the stream genuinely
  cannot answer. It cannot: the measured behaviour is that a goal set and
  achieved inside one turn leaves the chip pointing at a goal that lasted
  seconds, with nothing on the stream to correct it. The same gate applies to
  Codex, where the read is a redundant confirmation rather than a behaviour
  change; one mechanism for every harness was preferred to a capability bit
  whose only job is to say "this harness reports goal changes".

- **Resolving the agent to ask, without disturbing the session**
  (`goalAgentFor`). Both reads run outside a turn, where the agent slot may hold
  the finished turn's proxy or nothing at all. Building a proxy while the slot is
  occupied *displaces* the installed one and settles its turn a second time
  (`supersedeDisplacedAgent`), so an occupied slot is used as it is or left
  alone; an empty one — which is what a one-shot turn leaves behind, before idle
  fires — is filled, where nothing can be superseded.

### Client

- `AgentOption.goalActions` rides `agent_list`; the `/` menu drops
  `goal pause` / `goal resume` for a harness that does not list them (req 5).
- `GoalChip` and the rest of docs/154's client surface are unchanged.

## Continuation

Claude Code's goal loop lives inside a turn: the `Stop` hook blocks the stop
until the evaluator agrees, so a goal keeps *one* turn going rather than
starting new ones. ShipIt's one-process-per-turn lifecycle therefore needs no
hold of the kind Codex needed — resuming a session with an active goal starts no
turn by itself (measured). The goal persists in the CLI's store and steers every
turn the user starts, which is what docs/154 settled on for Codex as well.

## Key files

- `src/server/session/agents/claude/claude-goal.ts` — answer parsing and the control process.
- `src/server/session/agents/claude/adapter.ts` — `goalCommand`, the set acknowledgement, `supportsGoals`.
- `src/server/shared/catalogue/harnesses.ts` — the `claude` capability block.
- `src/server/shared/types/agent-types.ts` — `goalActions`.
- `src/server/orchestrator/ws-handlers/send-message.ts`, `goal-command.ts` — interception and refusals.
- `src/server/orchestrator/services/agent-goal.ts` — `refreshAgentGoalAfterTurn`.
- `src/server/orchestrator/runner-registry-factory.ts` — the idle hook.
- `src/client/components/MessageInput/MessageInput.tsx` — the `/` menu filter.
