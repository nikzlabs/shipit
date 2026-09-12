---
issue: planning#530
title: "A command invocation reaches the harness alone"
description: "Why a pending notice breaks a slash command on every harness, what the pinned CLIs actually do with a prefix and a suffix, and the one rule that replaces three copies of the same prompt assembly."
---

# A command invocation reaches the harness alone

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md).

## Problem

`assembleAgentPrompt` (`prompt-assembly.ts`) put a slash invocation first on
purpose — its comment said the Claude CLI needs the command at the start — and
then appended file, image, dictation and role context after it. Every caller
then prepended `agentPrefix`: a pending-agent notice, a bug-outcome notice, a
branch-reset notice or a dependency-gap notice. So the one thing the branch was
built to guarantee was defeated one line later, whenever any notice was pending.

[docs/297](../297-goal-on-claude/plan.md) and
[docs/298](../298-goal-on-grok/plan.md) fixed this for `/goal` alone, by
delivering that one command verbatim. Every other command invocation — a skill,
`/context`, `/compact`, `/usage` — still carried the defect.

## Measured

### Grok, from the goal work

`@xai-official/grok` 1.0.18, ShipIt's own spawn flags, 2026-09-12 (docs/298's
table, and the correction on planning#530):

| Prompt | Result |
|---|---|
| `/goal status` | native command, 1 turn, $0, 4 ms |
| `The branch was reset.\n\n/goal status` | **no command at all** — 8 turns, $0.035, no goal written |
| `/goal status\n\nAttached files:\n- src/foo.ts` | the command **ran**, with a goal whose objective is literally `status\n\nAttached files:\n- src/foo.ts` |

### Claude Code, measured for this doc

`@anthropic-ai/claude-code` 2.1.260 on 2026-09-12, spawned the way
`claude/process.ts` spawns it (`--print --input-format stream-json
--output-format stream-json --verbose --allowedTools "…,Skill"`, `--model
haiku`), in a probe workspace holding two probe skills. `--replay-user-messages`
is what makes the CLI's **own** expansion visible, and it is the only
trustworthy signal here — see the trap below.

| Invocation | Prompt shape | What the CLI did |
|---|---|---|
| skill `/probeargs make it fast` | the command alone | expanded it: `<command-name>/probeargs</command-name><command-args>make it fast</command-args>`, 2 turns |
| skill | notice **before** the command | **no expansion.** The raw text was replayed as an ordinary user message; the model then called the `Skill` tool itself, +2 turns |
| skill | context **after** the command | expanded, and the appended block landed **inside** `<command-args>` |
| local `/context` | the command alone | `num_turns: 0`, `$0`, 641 ms, answered from `local-command-stdout` |
| local `/context` | notice **before** the command | **not a command.** 4 turns, $0.020, and the model improvised an answer about the notice |

Four prefix probes of four ran the skill through the model's own `Skill` call,
including with the real branch-reset and dependency-gap notices as the prefix. So
on Claude Code a **skill** survives a prefix by model judgement rather than by
CLI expansion; the harness's **own** commands have nothing to fall back to and
are lost outright. That splits the issue's claim and is recorded as
[requirements.md](requirements.md) req 6 resolved.

**The trap.** The probe skill wrote a marker file, and the marker was written in
all three prompt shapes. A guard asserting "the skill ran" — or "a goal was
set" — passes while the CLI never saw a command, or saw one with a corrupted
argument. Assert what the CLI received, not what the model went on to do.

## Design

One rule, in one predicate:

> When the user's message begins with the active harness's own invocation prefix
> followed by a command name, the turn carries that message and nothing else.

`isCommandInvocation(text, prefix)` (`shared/command-invocation.ts`) is the whole
classifier. The prefix is the harness's existing `skillInvocationPrefix`
capability — `/` for Claude Code, Grok and OpenCode, `$` for Codex — so the
answer is harness-correct without a new capability field, and a `/foo` message on
Codex (whose own commands are not `/`-prefixed in ShipIt's headless path) is
left alone. Only Claude Code and Grok were measured; for Codex and OpenCode the
declared prefix is taken at its word, and the cost of it being wrong there is a
notice deferred by one turn, never a lost command.

A command name is `[a-z0-9][a-z0-9._:-]*` up to the first whitespace, and must
contain a letter. That excludes the realistic false positives: a path-first
message (`/tmp/foo.ts is broken`) keeps a `/` inside the token, a shell-variable
mention (`$HOME is unset`) is uppercase, and an amount (`$100 is the budget`) has
no letter. Every command in Claude Code's own `slash_commands` list, and every
skill name in this repo, is lowercase.

ShipIt deliberately does **not** keep a list of real command names: the CLI
reports its list in the `init` event, which arrives after the prompt has been
assembled, and skills change per workspace.

**What a remaining false positive costs.** A message like `/tmp is missing` is
still classified as a command. Nothing is destroyed — the notices and the brief
stay pending and ride the next message, and the reset is re-evaluated then — but
the cost is silent for that turn, not a visible refusal (only a message that
*also* carries attachments is refused out loud). Under-matching, by contrast, is
the silent bug being fixed. The asymmetry is why the classifier stays syntactic.

**Whitespace.** All three sites deliver `text.trim()`, not the raw bytes: leading
whitespace is exactly what stops a CLI recognising the command, so trimming is
what makes requirement 1 true rather than a departure from it.

### What happens to everything that cannot ride

Nothing is consumed, so nothing is destroyed:

| Source | On a command turn | Why that is safe |
|---|---|---|
| pending-agent notice | not consumed | it is a take; it stays in the session row and rides the next ordinary turn |
| bug-outcome notice | not consumed | same |
| role standing instructions | not taken | `takeRoleStandingInstructions` is a take; taking it here would destroy the brief |
| dependency-gap notice | skipped | a pure function of `runner.dependencyGap`, re-derived every turn |
| pre-turn branch reset | **not attempted** | re-evaluated at the start of every turn, and gated so a later attempt cannot discard this turn's work — see below |
| file / image / upload context | the message is refused | req 3 — the user can resend, so saying so beats folding it into the argument |
| `/compact` | **not** an exclusion | the Claude adapter never reads the `compact` run-param, so the CLI compacts only when the prompt is the command alone — and that covers ShipIt's own `POST_MERGE_COMPACT_PROMPT`, which is itself `/compact <instructions>`. Before this change a role brief pending on a compaction turn was taken and appended *into* those instructions |
| dictation hint | dropped | a per-message hint, not stored state; a message that is exactly a command has no prose for the model to read for intent |

The reset is the one that trades something real: a command turn runs on the
un-reset branch, and if that turn edits files the post-turn auto-commit puts them
on it. Nothing is discarded even then — the later reset is gated on
`computeResetBlocker`, whose ancestry and merged-head checks refuse a branch
carrying unshipped commits (`head-moved`) exactly as they refuse a dirty tree.
Deferring is docs/297's shipped choice and it is kept deliberately.
The alternative — reset, then park the agent-facing prefix with
`appendPendingAgentNotice` — would rewrite the working tree under a possibly
resident CLI while telling it nothing this turn, which is the hazard
`buildManualResetAgentNotice` exists for. Deferring instead leaves the branch
where the agent last saw it, and the skip is loud one turn later: the next
ordinary turn either resets or emits the `dirty-tree` / `head-moved` notice.

### The three delivery paths (req 4)

The same assembly was written out three times. All three now take the same
decision, before any take is consumed:

- **`agent-execution.ts`** — a fresh or WS-queued interactive turn. The existing
  `!ridesTurnAsCommand` guards stay; only the predicate behind them widens, so
  `ridesTurnGoalCommand` and the unused `opts.verbatim` option are gone rather
  than joined by a second name.
- **`dispatched-turn.ts`** — the runner's own queue drain, chained turns, cron
  and session-to-session messages. A dispatched message that carries an origin
  wrapper (`formatSessionMessagePrompt`, `formatAgentInterfacePrompt`) is **never**
  a command invocation: that wrapper is the message's provenance and dropping it
  would be the silent loss this doc is about, while a sibling agent's `/goal` is
  not the user typing in the composer. Requirement 1 is about the user's message.
- **`send-message.ts` steering** — a message steered into a running turn goes to
  the resident CLI's stdin as a user message, so the same rule applies to it.

`assembleAgentPrompt`'s slash branch is **deleted**. It was a harness-blind
attempt at this same guarantee, and ordering can never provide it: the measured
shapes are "no command" (prefix) and "corrupted argument" (suffix). With the
command delivered alone, the branch had no reachable job left.

### Refusing attachments once, at the entry point

The refusal lives in `handleSendMessage`, before the goal interception and
before anything is queued — so a queued or steered command can never carry
attachments either, and the check exists once. It replaces docs/298's
goal-specific refusal.

It is delivered as a WS **`error`**, the same channel as the auth and vision
refusals beside it, and not as a persisted notice. The reason is client state,
not taste: the browser has already added an optimistic user bubble and set
`isLoading` for this send (`send-user-message.ts`), and only `handleError` clears
them. docs/298's persisted notice was correct for a goal command the *client*
intercepts — that path creates no bubble — but a `"turn"` goal action and every
skill take the ordinary send path, where a notice alone leaves the session
"Thinking…" for ever. That was a live defect in the shipped goal refusal, fixed
here.

A control-mode `/goal` still cannot be refused this way, because the client
intercepts it and sends no attachments with it (`send-handler.ts`). Nothing is
lost there: the early return also skips `clearPendingFiles`, so the attachments
stay in the composer for the user's next message.

## Rejected

- **Move the notices behind the command.** Measured worse on both harnesses: the
  command runs and its argument is corrupted (planning#530's correction comment).
- **Carry the notices in the appended system prompt.** It breaks the
  prompt-cache byte-stability contract in `CLAUDE.md` (every variant renders once
  at module load), and the system prompt is per spawn — with live steering a
  resident CLI keeps the one it started with, so a mid-session notice could not
  be delivered at all.
- **Send the notices as a separate stream-json user message ahead of the
  command.** Each user message is its own turn for the CLI, so the notice would
  spend a turn and could set the agent working with no task in hand.
- **Match against the harness's real command list.** Not available before the
  spawn that reports it.

## Key files

- `src/server/shared/command-invocation.ts` — `isCommandInvocation`, the one predicate.
- `src/server/orchestrator/prompt-assembly.ts` — the slash branch, deleted.
- `src/server/orchestrator/ws-handlers/agent-execution.ts` — the interactive turn's decision.
- `src/server/orchestrator/dispatched-turn.ts` — the dispatched turn's decision.
- `src/server/orchestrator/ws-handlers/send-message.ts` — the attachment refusal and the steered prompt.
