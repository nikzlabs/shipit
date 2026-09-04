---
issue: planning#155
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
state (single-action, multi fresh / recommended / partial, the "Add comment…"
composer hand-off, the transient post-Submit "cleared" ack, and the same card
reset to original after reload).

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
   existing message queue if it's mid-turn. No composer involved. Submit acts on
   the **selected** set, so it's **disabled when nothing is checked** — there's
   nothing to send.
2. **Add comment…** *(secondary — the "I agree, but…" / "actually…" path)*.
   Instead of sending, this seeds the **main input box** with a snapshot of the
   **selected actions only** — each ticked action on its own line as a `- ` bullet,
   with **unselected actions omitted entirely** (they are *not* filled into the
   composer at all) — then focuses the composer. Each seeded line is the action's
   **`payload`** (the self-contained instruction), **not** just its short display
   label, so the "Add comment…" path is cold-context-safe in exactly the same way
   Submit is. *(Codex design review: seeding labels would have left only the
   Submit path self-contained.)* No `[x]`/`[ ]` checkbox marker is used: every
   seeded line is selected by definition, so the ticked/unticked distinction is
   gone — the lines are a plain bullet list that reads clearly for a human, parses
   cleanly for the agent, and the user can freely edit before sending. The user then appends their
   own words (typed **or dictated** — the composer's voice button is right there)
   and sends normally. The sent message is the snapshot **plus** the user's
   addition, so the agent sees what the user leaned toward and the freeform note —
   all self-contained. *(How that quote is visually **rendered** inside the
   composer — plain text vs. a styled quote block — is a separate, composer-wide
   question; being investigated in its own session, see planning#155 thread.)*

   **Add comment… is never disabled.** Unlike Submit, it doesn't require a
   selection: commenting is valid with any subset, including none (e.g. *"none of
   these — do X instead"*). With no selection the composer is seeded with just the
   `Re:` provenance header and no action lines, leaving the user a clean slate for
   their note. This also makes the two buttons behave **identically across single-
   and multi-action cards** — which was the goal.

The two-button split is what resolves the single-action expressiveness gap. For a
lone action there's nothing to *select*, so: **Do it** = unqualified agreement;
**Add comment…** = seed the composer with that one action so the user can qualify
("yes, but name the PR …") or redirect ("hold off — do X first"). The agent reads
the natural language to tell agreement from redirection. The single action is
listed the same way in the snapshot, so single and multi differ only in count, not
in behavior.

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

Because the card carries no *persisted* lifecycle, the persistence story is
markedly simpler than `bugReport` / `issueWrite` (no `update*Card` patch path). It
persists like a piece of static content that happens to have buttons. The only
post-submit visual change (the transient "cleared + Submitted" ack) lives purely
in client component state and is **discarded on rehydrate** — it never reaches the
persisted record, so there is nothing to patch.

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

  **Scope guardrails on the tool instructions** *(Codex design review — keeps the
  card on the right side of §5).* The card is for **contextual follow-ups the
  agent just identified in this turn**, not for routine recurring commands or a
  standing workflow menu. Concretely the instructions must say: don't surface
  "run the tests / lint / typecheck" as a card by itself (that's the click-to-run
  command shortcut §5 forbids); don't emit a card every turn; don't emit a card
  *and* repeat the same suggestion in prose; prefer plain text when the action is
  vague; cap a card at ~3–5 actions and emit at most one card per turn. Good
  example actions are this-moment-specific: "open a PR for this change", "file a
  follow-up issue for the rate-limit edge case", "update the API docs for the new
  route" — not "run lint".

- **Anchoring is where the tool fired, so the agent must fire it LAST**
  *(reported from use)*. The card is recorded in-band at the point the tool ran
  rather than floated to the bottom of the turn — the property that keeps it an
  in-line historical card instead of a standing palette (see the §5 check above),
  and the same reason `emitChatCard` anchors by `afterGroupIndex`. The cost is
  that an agent which proposes *before* writing its closing prose buries the
  card above the whole answer: the user reads to the end, sees nothing, and finds
  the card only by scrolling back. That is a prompt rule, not a render rule —
  moving the card to the end of the turn would undo the anchoring the §5 argument
  rests on. So the placement is stated where the agent reads it: the tool
  description (`mcp-tools/propose-actions.ts`), the session prompt
  (`prompts/skeleton.md`), and this repo's own `CLAUDE.md` all say to post the
  card after the reply, as the final act of the turn.

- **Provenance travels in the submitted message, not in card state** *(Codex
  design review)*. "No staleness" does **not** mean pretending nothing changed
  since the card was emitted. The card stays a pure message-sender, but the
  message it sends is **stamped with provenance** — when the actions were
  proposed, and the branch/HEAD they were proposed against — and framed so the
  agent **inspects current state and adapts or declines if the action is now
  obsolete** (branch merged, PR already exists, files moved). This keeps the
  honest-at-click-time guarantee without reintroducing a stale *state*, a lock, or
  a patch path. A subtle "proposed <date>" line may appear on older cards; that is
  static emit-time data, still immutable.

- **Card-injected provenance marker on the Submit message** *(mirrors the release
  card)*. The Submit message is templated by the button, not hand-typed, so it
  leads with an explicit `[Action card → Submit]` marker and frames the body as
  *intent* ("I approved these actions … this is intent, not a literal command;
  re-check current state before acting"), exactly like
  `release-confirm-message.ts`'s `[Release card → Confirm & publish]` marker. The
  marker lets the agent tell a templated card submission from a typed instruction
  and apply judgment instead of obeying the string verbatim — the same provenance
  pattern, kept consistent across both confirmation cards. The **Add comment…**
  snapshot is seeded into the user's *composer* to edit and send (not auto-injected
  as an agent directive), so it keeps only the lighter `Re: <title>` provenance
  header and carries **no** card marker — a marker would imply a directive the user
  hasn't actually sent yet.

- **A transient post-submit acknowledgment — client-only, never persisted.**
  Leaving the card visually unchanged after a Submit looked broken ("did my click
  do anything?"). So directly after a **Submit** (the direct path only), the card
  shows an **ephemeral "cleared" state**: the ticked boxes reset and a brief
  "Submitted · N sent" confirmation appears. This is **client-only transient UI** —
  the spinner / `preview_status` category in CLAUDE.md's transient-vs-transcript
  split — and is **never written to the card record**. On reload or session-switch
  the card **rehydrates from its immutable definition** back to its original state
  (fresh, or `defaultChecked` if it had recommendations); the transient ack is
  gone. So the immutable-card / no-patch-path model is fully intact — nothing about
  a submit is persisted *on the card*; the durable record is the **user message in
  the transcript** below it. Deliberately **not** a "Sent … 2 days ago" receipt:
  that earlier mockup showed *persisted, timestamped* lifecycle state, which
  contradicted the model (Codex review caught it). The transient ack carries **no
  relative timestamp** and dies on reload, which is exactly what keeps it on the
  transient side of the line.
  **Add comment…** does **not** trigger this — it moves the action into the
  composer, so the card is correctly left untouched.

- **The ack is conditional on delivery (fix, 2026-08-04).** As first shipped the
  ack was *unconditional*: `handleSubmit` called `onSubmit` (whose return was
  `void`) and then cleared the selection and rendered "Submitted · N sent"
  regardless. `useWebSocket.send` is a silent no-op when the socket isn't OPEN,
  so a dropped frame produced a confident ack for a message the agent never
  received — and, because the clear wiped the ticked boxes including the
  `RECOMMENDED` defaults, the user couldn't even retry without re-ticking. An
  operator hit exactly this. `onSubmit` now returns whether the message reached
  the wire; only `true` clears + acks, and `false` **keeps the selection
  untouched** and shows a transient "Couldn't send — not connected. Your
  selection is kept; press Submit to retry." line. That failure line is in the
  same client-only, never-persisted category as the ack: it is **not** a lock and
  **not** a terminal state — the buttons stay live and a second press retries the
  same subset — so the no-lifecycle contract above is unchanged. Caveat: the
  boolean proves the bytes went to an OPEN socket, not that the server got them
  (a backgrounded mobile socket can read OPEN after the OS killed it); closing
  that needs a server-side ack keyed on `requestId` — see *Still open*.

- **The caps must be stated where the model reads them (fix, 2026-09-04).**
  Reported from use: `propose_actions failed: actions[0].payload exceeds 4000
  chars.` The `MAX_PAYLOAD_LEN` cap existed **only** in the orchestrator route —
  it appeared in no tool description, no JSON schema, and no prompt, while both
  the schema and `skeleton.md` pushed the other way ("the **full**,
  self-contained instruction … must stand alone without relying on conversation
  context"). A model told to write everything down and never told the ceiling
  will hit it, so the failure was designed in. Two supporting defects made it
  land badly: the tool's "fail-fast pre-check" checked only *is `actions` a
  non-empty array*, so every length violation cost a full round trip through the
  worker and the orchestrator; and the card is fired **LAST** by design, so the
  rejection arrives with the closing prose already written and the card lost
  unless the agent re-authors it. The fix keeps the cap and closes the
  information gap: `validateProposeActions` and its bounds moved to
  `shared/propose-actions-validation.ts` and now run **on both sides** (one
  source, identical rejection, no round trip); the tool's JSON schema carries
  `maxLength`/`minItems`/`maxItems` plus the cap in every field description; the
  tool description and `skeleton.md` say the payload is capped and that standing
  alone means *naming* files, docs and issues rather than pasting them; and each
  length error now names the **measured** size, the cap and the repair
  ("Rewrite it as a compact standalone instruction … and call propose_actions
  again") instead of a bare "exceeds". Raising the cap was rejected — 4000 chars
  is ~600 words for *one* optional follow-up, so a payload past it is context
  that belongs in the repo, and every payload is concatenated into a single user
  message the user has to read.

- **Audit of the sibling MCP tools for the same defect class (2026-09-04).**
  Every tool in `src/server/session/mcp-tools/` was traced through its
  `/agent-ops` relay to its orchestrator route, asking one question: *is there a
  bound the server enforces that the model cannot read before it calls?* The
  relays enforce nothing — they are pure pass-throughs — so every bound is at
  the route. Result:

  | Tool | Enforced bound | Was it readable? |
  |---|---|---|
  | `propose_actions` | 5 actions; id 64, label 120, description 280, payload 4000, title 120 | No → fixed here |
  | `AskUserQuestion` (`ask`) | non-empty `questions`; each question needs ≥1 option **whose `label` is a non-empty string** — `normalizeAskQuestions` drops the rest and the worker 400s on what is left | No. `options` was `required`, but an **empty array** satisfied that, and so did `[{ label: "" }]`. The pre-check re-implemented a weaker rule (array length only), so a blank label crossed the wire and came back a 400 — the very round trip this audit exists to remove. It now defers to `normalizeAskQuestions`, and the schema declares `minItems: 1` on both arrays plus `minLength: 1` on `label`. The "2–4 options" and "~12 char header" stay prose: nothing enforces them, and the schema must not claim otherwise. |
  | `report_shipit_bug` | `title` and `body` non-empty **after trimming** | No — `required` admits `""`. Now `minLength: 1` on both. (The 200-char slice in `services/bug-report.ts` shapes the *outcome notice* read back to the agent; it does not cap the submitted title.) |
  | `voice_note` | `summary` non-empty after trimming | No, same reason → `minLength: 1` |
  | `present` | `file` non-empty (no size cap of any kind) | No for `file` → `minLength: 1`; and inverted for size — see below |
  | `permission_prompt` | n/a | Out of scope: the CLI invokes it, the model never authors the call. |

  **`required` is not `minLength`.** Four of the six tools declared a string as
  `required` while their route rejected it for being blank — an empty string
  satisfies `required`, so each of those was a real (if small) instance of the
  same defect, found only by reading the routes rather than trusting the first
  pass of this table.

  `present` is the same defect pointing the other way, and it is worth naming
  because a search for "enforced but unstated" would never have found it: the
  tool description promised *"The file is capped at ~1 MB; larger artifacts will
  be rejected."* No such cap exists. It belonged to the old `PresentBuffer` and
  was deliberately deleted (docs/093-agent-present plan §6 — the registry keeps
  metadata only and reads bytes from disk on demand, so there is nothing to
  cap), and `src/server/shipit-docs/present.md` already told the agent the
  opposite: *"Nothing is rejected for being big."* A stated limit that does not
  exist costs the same as an unstated limit that does — the model splits or
  withholds an artifact for no reason — so the sentence is gone and the real
  guidance (keep an **inline** artifact small, because the card is bounded in
  height) replaces it.

  The general rule this audit is worth keeping for: **a tool's schema and
  description must state exactly the bounds its route enforces — no fewer, and
  no more.**

## Still open

- **Server-side delivery ack** (tracked in planning#314). The delivery signal today is client-local
  (`useWebSocket.send`'s boolean). It catches every `readyState !== OPEN` drop
  but not the zombie-socket case, where a backgrounded mobile socket still reads
  OPEN after the OS killed the connection and `ws.send()` "succeeds" locally
  while the bytes never arrive. The fix is an ack from the orchestrator keyed on
  the `requestId` that `sendUserMessage` already mints (today `requestId` is
  consumed only on the *error* path, `hooks/message-handlers/error.ts`), with the
  card's ack and the composer's spinner resolving on it and timing out into a
  visible failure. That pays off for every `sendUserMessage` callsite, not just
  this card.

- **Codex parity — done.** Like `ask` (docs/147), `propose_actions` is registered
  for both backends (it's in both `SHIPIT_MCP_TOOLS` lists), so Claude and Codex
  emit the same card through the same orchestrator route.
- **Composer quote rendering.** How the "Add comment…" snapshot *renders* inside
  the composer (plain text vs. a styled quote block) is a separate, composer-wide
  question tracked outside this doc; today it seeds as plain text via
  `setPrefillText`, which is self-contained regardless of how it's later styled.

## Key files (implemented — planning#155)

Server (tool → relay → orchestrator → persist):
- `src/server/session/mcp-tools/propose-actions.ts` — the `propose_actions` MCP
  tool (mirror of `ask.ts`); non-blocking, fail-fast pre-check, form-only
  `instructions`.
- `src/server/session/mcp-shipit-bridge.ts` — registers the tool; it ships to
  **both** `SHIPIT_MCP_TOOLS` lists (Claude `…,permission,propose_actions`; Codex
  `…,bug,propose_actions`) in `agents/claude/adapter.ts` + `agents/codex/adapter.ts`.
- `src/server/session/agent-ops-routes.ts` — worker relay `POST
  /agent-ops/propose-actions` → orchestrator `/propose-actions`.
- `src/server/shared/propose-actions-validation.ts` — the bounds
  (`MAX_PAYLOAD_LEN` &c.) and `validateProposeActions`, in `shared/` so the
  session-side tool and the orchestrator route reject **identically**; the error
  strings are written to be model-readable (measured size + cap + repair).
- `src/server/orchestrator/api-routes-propose-actions.ts` — authoritative
  validation (it *imports* the shared validator; it exports only the route
  registrar), emit-time provenance (branch/HEAD via `createGitManager`), and the
  single `emitChatCard` call. No `update*Card` path — the card is immutable.
  Driven end-to-end by `integration_tests/propose-actions-route.test.ts`, because
  the session-side pre-check is a convenience and this route is the gate: the
  endpoint is container-accessible, so the tool is not the only way in.
- `src/server/orchestrator/chat-history.ts` + `shared/database.ts` —
  `actionChecklist` field + `action_checklist` column + `toRow`/`fromRow` +
  migration (written once on emit, never patched).
- `src/server/shared/types/domain-types.ts` — `ActionChecklistCard` /
  `ActionChecklistItem` (shared by WS payload, persisted row, client card).
- `src/server/shared/types/ws-server-messages.ts` — `WsActionChecklistCard`
  (`action_checklist_card`). There is **no** client → server resolution message:
  a submit is a normal `send_message` user turn, so nothing new was needed on the
  client-message side.

Client (render + the two resolve paths):
- `src/client/components/ActionChecklistCard.tsx` — the card (button vs checklist,
  transient ack, the two buttons).
- `src/client/utils/action-checklist-message.ts` — pure builders:
  `formatProposalMessage` (Submit) and `formatCommentSnapshot` (Add comment…),
  both from `payload`s + provenance.
- `src/client/hooks/message-handlers/action-checklist-card.ts` — live append,
  idempotent by `cardId`; registered in `message-handlers/index.ts`.
- `src/client/components/visual-elements.ts` — `actionChecklist` in
  `CARD_MESSAGE_FIELDS`.
- `src/client/components/MessageList.tsx` — renders the card; **Submit reuses the
  existing `onSendFollowUp`** (queue-aware, one message → one turn), **Add
  comment… seeds the composer** via `setPrefillText` — so no new App-level wiring.

The card carries no client store (the full payload lives on the chat message, like
`issueRef`), so `loadSessionHistory` rehydrates it for free.

## Relationship to prior art

- `docs/147` — the `ask` tool (Codex-normalized `AskUserQuestion`); closest
  plumbing analog (card render + free-text escape + Codex parity).
- `docs/163`, `docs/164`, `docs/188`, `docs/191` — the transcript-card
  persistence contract this must follow.
