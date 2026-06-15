---
issue: https://linear.app/shipit-ai/issue/SHI-153
title: Action checklist cards
description: A transient, agent-authored card proposing one or more independent optional follow-up actions the user resolves with a single batched click.
---

# Action checklist cards

## What this is

A new transcript card that lets the agent propose **one or more independent
optional actions** and have the user pick the subset they want with a **single
submit**, instead of typing out the instruction in prose.

This is **not** a question (exclusive pick-one), and **not** a permission gate
(allow/deny on one specific pending call). It is a *menu of optional
follow-ups*, batch-resolved:

- **One proposed action** → the card is a single button ("Do it") plus dismiss.
- **Two or more** → the card is a **checklist** (independent checkboxes) plus a
  single "Proceed" button. The user ticks the subset they want and submits once.

The motivating moment: the agent finishes a turn and ends with *"I could also do
X, Y, or Z — want any of those?"* Today the user has to **type** which ones.
With this card they **tick and click**. (This very conversation is the example:
"want me to draft the doc?" should have been a button, not a sentence the user
had to answer in prose.)

## Why a new primitive (and not `AskUserQuestion`)

ShipIt already renders several button-cards, and at first glance this looks like
one of them. It is not — the existing cards solve adjacent but different
problems:

| Existing card | Shape | Why it doesn't fit |
|---|---|---|
| `AskUserQuestion` (`ask.ts`) | 1–4 questions, **exclusive** radio options per question, **blocking** (interrupts the turn) | Actions here are **independent** (any subset, including all or none), not mutually exclusive. And they're not urgent enough to interrupt a turn. |
| `permissionPrompt` / `egressPrompt` | allow/deny gate on **one specific pending** tool call | These gate a call the agent is *already trying to make*; the checklist proposes calls the agent has **not** made and may never make. |
| Release / `bugReport` / `issueWrite` cards | confirm/undo on **one** bespoke domain action | Each is hard-wired to one feature's lifecycle. This is a **generic** menu the agent authors ad hoc. |

The distinguishing shape: **N independent yes/no actions, resolved in one batch.**
That's a primitive ShipIt doesn't have.

## The load-bearing design insight: one submit, not N buttons

The naive version — render each action as its own button that fires when clicked
— is **wrong**, and the reason is the [WebSocket-lifecycle / steering
model](../../CLAUDE.md): each independent click injects a **separate steering
message** into the (possibly still-running) agent. The agent might already be
acting on action 1 when action 3's message arrives, interleaving instructions
unpredictably.

Instead, the card **collects** the ticked actions and submits them as **one
message → one turn**. The selection is a local UI state until the user hits
"Proceed"; only then does a single, coherent instruction reach the agent. This
is the core behavioral contract of the feature.

## Principle check (CLAUDE.md §5) — this is one inch from a forbidden pattern

CLAUDE.md §5 explicitly forbids *"quick-action button rows, command palettes that
execute shell, hotkey-bound task runners, click-to-run buttons."* A "checklist of
actions with a Go button" superficially looks **exactly** like that. The feature
is only legitimate because it preserves two properties, and the implementation
must protect both:

1. **Transient and agent-authored per context.** The card exists because the
   agent *just proposed it* in this turn, anchored to this point in the
   transcript. It is **not** a standing palette of recommended-action buttons. If
   it ever drifts toward a persistent "things you can click to run" toolbar, it
   becomes a §5 violation. There is no global/recurring action menu — only
   in-line, agent-emitted, one-shot cards.
2. **Resolves through the agent.** Ticking boxes **declares intent**; the agent
   is still the actor that does the work. No checkbox executes a shell command
   directly. The submit produces a normal user turn; the agent reads it and acts.

If a reviewer can't tell this card apart from "a row of buttons that run
commands," the design has failed. The two properties above are the entire
justification.

## Behavior

### Tool surface (session-side MCP tool)

A new MCP tool, working name `propose_actions`, exposed alongside the existing
`ask` tool in `src/server/session/mcp-tools/`:

```
propose_actions({
  title?: string,            // optional heading, e.g. "Optional follow-ups"
  actions: [
    {
      id: string,            // stable id for this action within the card
      label: string,         // short button/checkbox text
      description?: string,  // one-line explanation
      defaultChecked?: bool, // agent's recommendation; user still decides
      payload: string,       // the instruction the agent receives if selected
    },
    ...                      // 1..N
  ],
})
```

Key points:

- The agent does **not** declare single-vs-multi; the card derives it from
  `actions.length` (1 → button, 2+ → checklist).
- Each action's **`payload` is self-contained** — the full instruction the agent
  should act on if the action is selected. This is what makes resolution survive
  a cold container (idle destroy → re-clone): the submitted message is
  reconstructed from the ticked `payload`s, not from warm conversation context.
- The tool is **non-blocking**: unlike `AskUserQuestion`, it does **not**
  interrupt the turn. The agent emits the card and the turn ends; the card waits
  in the transcript until the user resolves it (or never does).

### Resolution

- User ticks 0..N boxes (or, for a single action, clicks the one button).
- On **Proceed**, the selected actions' `payload`s are concatenated into **one**
  user message and sent as a normal turn (queued if the agent is mid-turn, via
  the existing message queue).
- **Dismiss** / submitting with nothing checked → no actions taken; card records
  a "dismissed" terminal state.
- The card **locks** on resolution: chosen boxes shown checked, all controls
  disabled, a compact "you chose: …" receipt. One-shot.

### Free-text escape

Consistent with `AskUserQuestion` and the "chat is the input surface" principle,
the card includes an "or tell me something else" affordance that just focuses the
normal composer — the user is never trapped in the offered actions.

## Persistence & lifecycle (mandatory — this is a transcript card)

This card renders inline in the transcript, so it is bound by CLAUDE.md's
[chat-transcript persistence contract](../../CLAUDE.md). It must use the
established side-channel-card pattern, **not** bare `emitMessage`:

1. Emit via `emitChatCard` (`chat-card-persistence.ts`) so it is persisted
   in-band with the turn the instant it fires.
2. Add a typed field (working name `actionChecklist`) to `PersistedMessage`,
   plus the column + `toRow`/`fromRow` and a `database.ts` migration. The
   resolution (which `id`s were chosen, terminal state) patches the record in
   place.
3. Rehydrate on the client in `loadSessionHistory`; make the live append + any
   store upsert **idempotent by card id** so reconnect-replay and reload-replay
   never double-render or clobber the locked state.
4. Register `actionChecklist` in `CARD_MESSAGE_FIELDS`
   (`client/components/visual-elements.ts`) — it renders on an empty-text
   message.
5. Add the history round-trip test + no-duplicate-on-replay test, and add the
   field's payload to `EVERY_OPTIONAL_FIELD_MESSAGE` in `chat-history.test.ts`.

States: `pending → resolved(selectedIds) | dismissed`. (A possible later
addition: `stale` — see open questions.)

## Open questions

- **Staleness.** A `pending` card whose `payload`s reference a branch that has
  since merged is misleading. Options: leave it clickable and trust the
  self-contained payload; or soft-mark it `stale` after some signal (turn count,
  branch change) with a visual cue but still clickable. Leaning
  stale-but-clickable.
- **Re-proposal.** After a partial submit, are the un-ticked actions gone, or can
  the agent re-surface them? Simplest: one-shot; the agent re-proposes if still
  relevant.
- **Overuse / nagging.** The product default is *be action-oriented — act, don't
  ask.* A cheap "here are 5 things I could do" checklist risks inverting that.
  The prompt guidance must hold the bar where `AskUserQuestion`'s is: only for
  genuinely **optional, user-owned** follow-ups, never as a substitute for doing
  the obvious work. This is a prompt-tuning problem as much as a UI one.
- **Codex parity.** Like `ask` (docs/147), the tool should be shaped identically
  for Codex so both backends emit the same card.

## Key files (anticipated)

- `src/server/session/mcp-tools/propose-actions.ts` — new MCP tool (mirror
  `ask.ts`).
- `src/server/session/mcp-shipit-bridge.ts` — register the tool.
- `src/server/orchestrator/chat-card-persistence.ts` — emit/persist via
  `emitChatCard`.
- `src/server/orchestrator/chat-history.ts` + `database.ts` — `actionChecklist`
  field, column, migration.
- `src/client/components/ActionChecklistCard.tsx` — new card component.
- `src/client/components/visual-elements.ts` — add to `CARD_MESSAGE_FIELDS`.
- `src/client/utils/send-user-message.ts` — batch-submit the selected payloads.
- `src/server/shared/types/ws-client-messages.ts` — resolution message type.

## Relationship to prior art

- `docs/147` — the `ask` tool (Codex-normalized `AskUserQuestion`); closest
  plumbing analog (card render + free-text escape + Codex parity).
- `docs/163`, `docs/164`, `docs/188`, `docs/191` — the transcript-card
  persistence contract this must follow.
