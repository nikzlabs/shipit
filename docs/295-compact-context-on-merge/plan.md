---
issue: planning#522
title: Compact the context when a merged session continues
description: A second composer checkbox that runs the shipped /compact turn before the user's message, so a merged session starts the next slice with a clean context as well as a clean tree.
---

# 295 — Compact the context when a merged session continues

Implements [requirements.md](./requirements.md). Extends
[docs/218 — Auto-update a merged session's branch to latest base](../218-auto-reset-merged-branch-on-continue/plan.md)
and reuses the compaction primitive from
[docs/178 — Context Compaction](../178-context-compaction/plan.md), which
[docs/276](../276-headless-compaction-triggers/plan.md) extended to all four
harnesses.

> **Blocked.** `requirements.md` carries one open question — whether a
> continuation the user did not type also compacts. This design covers the
> composer path only, which is the part the requirements settle. Implementation
> waits for that answer.

## Shape

The design is deliberately small, because the two halves already ship. A
merged-continue send that carries the new intent runs **two sequential turns in
the send handler**:

1. the compaction turn — exactly what a typed `/compact` does today when the
   session is idle;
2. the user's turn — exactly what a normal send does today, including the
   docs/218 reset.

No new turn machinery, no queue marking, no system-turn hold. The whole feature
is an intent flag, a composer control, and one `await` in front of an existing
call.

## Why two turns, and in that order (req 4, req 7)

`runAgentWithMessage` already **skips the docs/218 reset when `opts.compact` is
set** (`ws-handlers/agent-execution.ts:442`), with the reason written at the call
site: a compaction must not trigger a destructive branch move, and the
`[System] …PR was merged…` prefix would derail the compaction — the agent reacts
to the merge notice instead of compacting.

That existing branch gives req 7 for free. The compaction turn takes the skip
path and never sees the prefix. The user's turn that follows takes the normal
path, runs `applyPreTurnReset`, and carries `buildAgentPrefix`
(`services/pre-turn-reset.ts:1027`) into a **freshly compacted** context, where
it is the newest thing the agent has been told. The notice cannot be absorbed
into the summary, because the summary was produced before the notice existed.

Ordering against the reset itself is free — the reset does not speak to the
agent except through that prefix, so compacting before it and compacting after
it produce the same context. Running the compaction first is chosen because it
is the long step: if the container dies during it, the destructive git move has
not happened yet and nothing needs unwinding.

**The turn resumes the right agent session.** A compaction can leave the backend
on a new agent session id, and a stale id would resume the pre-compaction
conversation and discard the whole compaction. This is safe here, verified at
`ws-handlers/agent-execution.ts:594`: `buildRunParams` reads `agentSessionId`
**fresh from the database** at spawn time rather than using the id captured when
the handler started. The second turn therefore picks up whatever the compaction
turn persisted.

### Rejected: a system turn with the message queued behind it

The alternative was to mark the compaction as a system turn (the rebase
driver's pattern), queue the user's message, and let the drain start it. It
needs more moving parts and has a live gap: a queued dispatch entry does **not**
carry `resetMergedBranch` (`prepareDispatch` has no such field), so a user who
unticked the reset and left the compaction ticked would have the untick dropped
and get the reset anyway. Two sequential awaits in the handler need none of
that.

## Custom compaction instructions — Claude only

A default summary ends with the shipped work's next steps, which is the wrong
emphasis for a session whose work just merged. Claude accepts custom
instructions (`session/agents/claude/adapter.ts:595` passes them through to
`/compact <instructions>`), so the compaction turn's prompt carries a short
post-merge instruction: keep durable context — user preferences, repo
conventions, unresolved questions — and drop the completed implementation
detail.

The other three harnesses do not honour it. Codex's `thread/compact/start` has
no slot for it (`agents/codex/adapter.ts:525`), and OpenCode's `summarize` route
has none either (`agents/opencode/adapter.ts:853`). Grok's trigger is in-band so
the text reaches the CLI, but whether it honours arguments is **unverified** and
must not be assumed.

So on three of four harnesses the docs/218 prefix is the **only** thing stopping
the agent continuing the shipped work. That is why req 7 is a requirement rather
than a nicety, and why the prefix must never be moved ahead of the compaction as
an optimisation.

## The per-send intent (req 5, req 6)

The wire path mirrors `resetMergedBranch` exactly, field for field:

- `WsSendMessage.compactContext?: boolean` (`shared/types/ws-client-messages.ts`)
  — set only when the control was shown; non-sticky and never persisted.
- Carried into `runAgentWithMessage`'s options
  (`ws-handlers/send-message.ts` → `ws-handlers/agent-execution.ts`), beside the
  existing `resetMergedBranch`.

The two flags are read independently (req 6). Unticking the reset does not
suppress the compaction and unticking the compaction does not suppress the
reset.

Unlike the reset, the compaction is **not** re-validated server-side. The reset
earns its server-side gate because it destroys committed work; a compaction
destroys no repository state, and the client sends the flag only when it showed
the control. Adding a second gate would give two answers that could disagree.

## The composer control (req 1, req 2, req 3, req 10)

`client/components/MessageInput/MessageInput.tsx` already computes
`showResetControl = resetEligible && autoResetMergedBranch` and holds
`resetChecked` in non-sticky state that re-checks whenever the control
reappears. The compaction control is the same pattern:

```
showCompactControl = showResetControl && supportsCompaction
```

`supportsCompaction` for the active agent is already on the client
(`MessageInput.tsx:854`, where it gates the `/compact` autocomplete entry), so
req 10 needs no new plumbing.

**Nothing gates on context size.** Requirement 3 forbids a token or percentage
threshold, so `showCompactControl` reads no usage state at all.

**Placement: a second line inside the existing control block**, subordinate to
"Start from the latest base" rather than an equal-weight second row. The block
already lives inside the composer border as its top row (docs/218 placement B),
so the input's corners still never change. Two equal rows would double the
weight of a block that appears at the exact moment the user wants to type.

## The shared setting (req 11)

No new setting. `autoResetMergedBranch` governs both actions, so when it is off
neither control is offered — which falls out of `showCompactControl` being
derived from `showResetControl`. The Settings → Advanced row
(`client/components/Settings/tabs/AdvancedTab.tsx:166`) keeps its toggle and its
title, and its description grows to name both actions.

## A typed `/compact` is still one compaction (req 12)

The intent flag and the `/compact` command can arrive on the same send: the
control is on screen, the user types `/compact`. Without a guard that send would
compact twice — once as the pre-step, once as the command itself.

So the pre-step is suppressed when the send is already a compaction request.
`send-message.ts` computes `isCompactRequest` before anything else runs, and the
pre-step reads it. The branch reset is already suppressed for the same send by
the shipped `opts.compact` skip, so both halves of req 12 come from one
condition.

## Visibility and failure (req 8, req 9)

Visibility comes from the compaction being an ordinary turn. The `/compact` path
already emits `agent_compaction_started` and the persisted compaction card
(docs/178), so the user sees the compaction start and sees the before/after
result in the transcript, with no new card type and no new persistence work.

Failure is contained the same way: the compaction turn is awaited, and its
outcome does not gate the second call. A compaction that errors still leaves the
user's message running on a reset branch. The turn is never lost.

But req 9 asks for more than survival — a failure must be **visible**, or the
user who ticked the box cannot tell a compaction that worked from one that did
nothing. The compaction turn therefore reports its outcome rather than its
completion. Two shapes have to be distinguished, and neither is an exception the
caller can skip:

- the turn **errored** — say so;
- the turn ended with **no compaction event at all** — a backend that accepted
  the trigger and did nothing. docs/276 req 2 is the precedent: a command that
  exits successfully while doing nothing does not count as a compaction, and it
  must not be reported as one.

The notice reuses the docs/218 skip-notice path (`emitNoticeInTurn` /
`emitNoticePostTurn` in `chat-card-persistence.ts`), which already puts a
one-line explanation at its true transcript anchor.

## The synthetic turn must not fake a user message

The compaction turn is started by ShipIt, not typed by the user, so it must not
persist a user row or echo a `/compact` bubble to other viewers — the transcript
would then show a command the user never sent. The compaction card is the
record; the bubble is not.

## Key files

| File | Change |
|---|---|
| `shared/types/ws-client-messages.ts` | `compactContext?: boolean` on `WsSendMessage`. |
| `orchestrator/ws-handlers/send-message.ts` | Idle path: run the compaction turn first when the intent is set and the backend supports it, then the user's turn. |
| `orchestrator/ws-handlers/agent-execution.ts` | No behaviour change — the `opts.compact` reset skip and the fresh `agentSessionId` read are what the design leans on. |
| `client/components/MessageInput/MessageInput.tsx` | `showCompactControl`, its non-sticky checked state, the subordinate control line, and the flag on the send payload. |
| `client/components/Settings/tabs/AdvancedTab.tsx` | Description of the existing toggle names both actions. |

## Risks

- **The wait is visible.** Compaction measured 27.7 s on a 22k-token context
  (docs/178) and grows with the context, and the user pays it before their turn
  starts. It is spent under the compaction card rather than in silence, and the
  checkbox is there to untick. Requirement 3 rules out shortening it with a
  size gate.
- **Grok's instruction handling is unverified.** Treat it as not honoured until
  someone probes it, exactly as docs/276 req 4 requires.
