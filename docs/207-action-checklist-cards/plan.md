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

- **One proposed action** → the card is a single button ("Do it").
- **Two or more** → the card is a **checklist** (independent checkboxes) plus a
  single "Submit" button. The user ticks the subset they want and submits once.

The motivating moment: the agent finishes a turn and ends with *"I could also do
X, Y, or Z — want any of those?"* Today the user has to **type** which ones.
With this card they **tick and click**. (This very conversation is the example:
"want me to draft the doc?" should have been a button, not a sentence the user
had to answer in prose.)

Crucially, the card is **just a helper to send a user message** — it has no
connection to the agent or session state. It persists in the conversation
history like any other card and is **reusable forever**: the user can return to
it a week later, tick a (possibly different) subset, and submit again. Think of
it as a saved, pre-filled message the user can fire any number of times — not a
one-shot prompt that resolves and dies.

**Visual reference:** [`mockup.html`](./mockup.html) — a static prototype of every
state (single-action, multi fresh / recommended / partial, after-submit receipt).

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

1. **Agent-authored and anchored in the transcript** — not a standing palette.
   The card persists forever in chat history (like any message does) and is
   re-clickable later, but that is **not** the same as a global "things you can
   click to run" toolbar. The distinction that keeps it legal: every card is
   *emitted by the agent, in line, at a specific point in the conversation,
   because the agent proposed those specific actions in that context.* There is
   no persistent, always-present, context-free action menu. If the feature ever
   grew a global recommended-actions toolbar, *that* would be the §5 violation —
   the in-line historical card is not.
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
  should act on if the action is selected. This is what lets a click work no
  matter how much time has passed (the card outlives the turn, the agent, even a
  destroyed-and-re-cloned container): the submitted message is reconstructed from
  the ticked `payload`s, not from warm conversation context.
- The tool is **non-blocking**: unlike `AskUserQuestion`, it does **not**
  interrupt the turn. The agent emits the card and the turn ends.

### Resolution — the card is a reusable message composer, not a one-shot gate

This is the defining property of the feature, and it's what separates it from
every other card in ShipIt: **the card has no terminal state and no connection to
the agent or session state at click-time.** It is a persistent helper for
composing and sending a user message. Concretely:

- User ticks 0..N boxes (or, for a single action, the one item is the implicit
  selection).
- The card **does not lock**. After a submit it stays fully interactive. The user
  can come back a minute — or a week — later, tick a different subset, and submit
  again. Submitting twice with different subsets is a normal, supported flow.
- There is **no "dismiss" / "resolved" / "stale" state.** A card the user never
  touches just sits in the transcript, inert and reusable, forever. Ignoring it
  is not a state transition; it's the absence of a click.

The card's persisted content (its action list) is **immutable**; the checkbox
selection is **ephemeral client state** recomputed each time the user opens the
card. There is nothing to patch server-side on submit — the submit is just a
normal user message.

### Two ways to resolve — and why there is no card-local input

A card-local free-text box was rejected: ShipIt's **voice input lives in the main
composer**, so a second input on the card would either orphan voice or force us to
re-wire it. Instead, the card has **two buttons**, and the "say something of my
own" path **routes through the existing composer** (which already has voice):

1. **Submit / Do it** *(primary — the zero-typing path)*. The selected actions'
   `payload`s are concatenated into **one** user message and sent exactly as if
   the user had typed it: starts a turn if the agent is idle, queues via the
   existing message queue if it's mid-turn. No composer involved.
2. **Add comment…** *(secondary — the "I agree, but…" path)*. Instead of sending,
   this drops the selected actions into the **main input box as a quote** and
   focuses it. The user then appends their own words (typed **or dictated** — the
   composer's voice button is right there) and sends normally. The sent message is
   the quoted action text **plus** the user's addition, so it stays self-contained.

For **multi-select**, both buttons operate on the **checked** subset and are
disabled when nothing is checked — the selection itself carries the user's
agreement, and "Add comment…" pre-fills the composer with exactly the items they
agreed to.

For a **single action**, there's nothing to *select*, so the two buttons split the
intent the selection would otherwise carry: **Do it** is unqualified agreement;
**Add comment…** quotes the one action so the user can qualify it ("yes, but name
the PR …") or redirect ("hold off — do X first"). The agent reads the natural
language to tell agreement from redirection. Keeping **Add comment…** on the
single-action card (rather than dropping it) is what gives the user a way to
*disagree or amend* without retyping the suggestion — the one expressive gap a
lone button would otherwise leave. *(Open: whether the secondary button earns its
place on single-action cards, or if "just type in the composer, the suggestion is
right above" is enough. Leaning keep-it for consistency.)*

## Persistence & lifecycle (mandatory — this is a transcript card)

This card renders inline in the transcript, so it is bound by CLAUDE.md's
[chat-transcript persistence contract](../../CLAUDE.md). It must use the
established side-channel-card pattern, **not** bare `emitMessage`:

1. Emit via `emitChatCard` (`chat-card-persistence.ts`) so it is persisted
   in-band with the turn the instant it fires.
2. Add a typed field (working name `actionChecklist`) to `PersistedMessage`,
   plus the column + `toRow`/`fromRow` and a `database.ts` migration. The field
   holds the **immutable** action list — there is no mutable resolution state, so
   the record is written once on emit and never patched.
3. Rehydrate on the client in `loadSessionHistory`; make the live append + any
   store upsert **idempotent by card id** so reconnect-replay and reload-replay
   never double-render. (No terminal state to clobber — the card is always
   interactive.)
4. Register `actionChecklist` in `CARD_MESSAGE_FIELDS`
   (`client/components/visual-elements.ts`) — it renders on an empty-text
   message.
5. Add the history round-trip test + no-duplicate-on-replay test, and add the
   field's payload to `EVERY_OPTIONAL_FIELD_MESSAGE` in `chat-history.test.ts`.

Because the card carries no lifecycle, the persistence story is markedly simpler
than `bugReport` / `issueWrite` (no `update*Card` patch path). It persists like a
piece of static content that happens to have buttons.

## Resolved design decisions

These were open questions; the following are the settled answers.

- **No staleness concept.** A pending card is never marked stale, expired, or
  disabled, and never auto-locks — not even if the branch it references has since
  merged. Merged sessions can be resumed, and continuing on the same branch (e.g.
  to open follow-up PRs) is a legitimate, common flow. The card never asserts an
  action is still *valid*; it only offers to *send a message*. Validity is the
  agent's concern at click-time, in fresh context — not the card's.
- **Reusable forever, no re-proposal needed.** A partial submit leaves every
  action tickable. The agent does not need to "re-propose" un-ticked actions
  because they never went away — the card is a permanent fixture of the
  transcript the user can return to indefinitely.
- **Frequency is governed by *existing* prompts, not by this tool.** The agent
  already decides when to suggest a next action (system prompt, repo prompt,
  etc.). This card does **not** introduce a new bar for *whether* to suggest —
  it changes the **form** of an existing suggestion from "type your answer" to
  "click a button." So the tool's own instructions cover *form* only: *when you
  would suggest one or more concrete, optional actions the user can accept or
  decline, render them as this card instead of asking in prose.* When a choice
  needs real discussion, that's still a question (or plain prose), not a card.
  The aggressiveness of suggesting at all stays exactly where it is today.

## Still open

- **Codex parity.** Like `ask` (docs/147), the tool should be shaped identically
  for Codex so both backends emit the same card. (Direction is clear; flagged as
  a build item, not a design question.)

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
