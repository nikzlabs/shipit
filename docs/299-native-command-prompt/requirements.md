---
issue: planning#530
title: "A command invocation reaches the harness alone"
description: "What ShipIt must do when the user's message is one of the agent CLI's own commands — deliver it byte for byte, keep every notice that could not ride it, and refuse attachments rather than fold them into the command's argument."
---

# A command invocation reaches the harness alone

Tracked by [planning#530](https://github.com/nikzlabs/shipit-planning/issues/530).
Design: [plan.md](plan.md). Remaining work: [checklist.md](checklist.md).

1. When the user's message is an invocation of the agent harness's own command
   syntax, the harness receives **exactly that message** — nothing added before
   it and nothing added after it.
2. Nothing ShipIt would have added to such a turn is destroyed. A one-shot
   notice or brief — the pending-agent notice, the bug-outcome notice, a role's
   standing instructions — is still pending after the command turn, and is
   delivered with the next ordinary message.
3. A command invocation that carries attachments (files, images, uploads) is
   refused, and the conversation says so, telling the user to send the
   attachments in a separate message. The message is not delivered with the
   attachment list folded into the command's argument, and the composer does not
   sit waiting for a turn that never starts.
4. Requirement 1 holds on **every** path that delivers a user's message to the
   harness: a fresh turn, a message queued while another turn runs, and a
   message steered into a running turn.
5. `/goal` keeps behaving as [docs/297-goal-on-claude](../297-goal-on-claude/plan.md)
   and [docs/298-goal-on-grok](../298-goal-on-grok/plan.md) specify.
6. What each prompt shape does to each kind of invocation — a harness-local
   command and a skill — is recorded from measurement on the pinned binaries,
   not inferred from the code.

## Open questions

- None. The brief on planning#530 settled the shape; every decision the agent
  made itself is listed under provenance below and argued in
  [plan.md](plan.md).

## Resolved questions

- 2026-09-12 — *Are skill invocations affected, as the issue infers from the
  code?* Measured (plan.md): **partly, and not silently on Claude Code.** A
  prefix stops the CLI expanding the command, but the model then calls the
  `Skill` tool itself (4 probes of 4), so the skill runs by model judgement
  instead of by CLI expansion, at 2 extra turns. A suffix does expand the
  command and folds the appended text into `<command-args>`. The silent total
  loss is confined to the harness's **own** commands (`/goal`, `/context`,
  `/compact`, …), which have no tool to fall back to. Recorded here because it
  changes the size of the claim, not the fix.

- 2026-09-12 — *Which surface carries the refusal?* Requirement 3 first said "a
  notice in the transcript", copied from docs/298's goal refusal. That is wrong
  for this feature and was wrong there: the browser adds an optimistic bubble and
  a spinner for an ordinary send, and only the WS `error` handler settles them, so
  a notice alone left the session "Thinking…" for ever. The requirement now states
  the observable outcome and leaves the channel to [plan.md](plan.md).

## Requirement provenance

- **1, 2, 3, 5, 6** — stated in planning#530 and in the brief that opened this
  session, including its constraint that nothing may be silently dropped and
  that moving the notices behind the command is not the cheap fix it looks like.
- **4** — supplied by the agent. The issue names one assembly site
  (`agent-execution.ts`); the same construction is duplicated in
  `dispatched-turn.ts` and in the steering branch of `send-message.ts`, and a
  user's typed command reaches all three (a message queued behind a running turn
  drains through the dispatched path). Fixing one site leaves the defect
  reachable from the composer, so the requirement is stated at the level of the
  user's message rather than of one function.
