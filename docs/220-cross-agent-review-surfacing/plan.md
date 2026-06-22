---
issue: https://linear.app/shipit-ai/issue/SHI-195
title: Cross-agent review surfacing — ShipIt renders what it brokers
description: Render cross-agent reviewer output deterministically in the consult card instead of routing it back through the parent agent's submit_review call.
---

# Cross-agent review surfacing — ShipIt renders what it brokers

> **Status: design — Option B decided, not yet implemented.** The open A/B
> question below is resolved in favor of **Option B**: every ShipIt-brokered
> spawn produces a content-carrying consult card, and a review is just such a
> card rendered richly. This revises a mechanism that is currently *shipped*
> (`docs/203`, the parent calling `submit_review`) and the surfacing design in
> `docs/144` §6–§7; the shipped behavior stands until the work in `checklist.md`
> lands. Split out of `docs/144` so the proposal isn't buried mid-doc.
>
> **Why B (transparency):** everything ShipIt brokers should be visible in the
> UI — not just the *fact* of the call (the metadata card already shows that) but
> the *content* the consultant produced. Gating content to review-shaped spawns
> (Option A) would leave generic delegations as metadata-only, hiding output the
> user brokered. So all brokered spawns carry content; "review" is presentation,
> not a separate path.

## Summary

When a review is produced by **another agent** (a `shipit agent run` cross-agent
spawn, `docs/144`), the reviewer's findings should be rendered in chat
**deterministically by ShipIt**, attributed and verbatim, from the result ShipIt
already brokered — not routed back out to the primary agent and re-emitted via
the parent's `submit_review` MCP call (`docs/203`).

The organizing principle: **ShipIt renders what it brokers; the agent renders
what is internal to it.**

## Why

A session is pinned to one agent (`docs/138`). `docs/144` lets the primary spawn
*another* agent for a one-shot sub-task — review being the first consumer — and
get its text back. `docs/203` then made the **parent** record the review card by
calling `submit_review { file_path, markdown }`, using the *same* path whether
the reviewer was an in-process `Task` subagent or a cross-agent spawn ("one
uniform card path").

That uniformity is the problem. The two cases are not the same, and the boundary
that distinguishes them is exactly the brokering boundary:

- **Within one agent** there is no model boundary for the user to be told about.
  Showcasing the review is the agent's own job — prose, a markdown findings
  list, inline. ShipIt needs no first-class artifact here.
- **Across agents** ShipIt is the broker: it spawns the subprocess and holds the
  result. The boundary is real, and only ShipIt can make it legible — "this
  opinion came from Codex, not Claude." Surfacing it is ShipIt's job, not the
  primary agent's.

## The current design is inverted

Routing both modes through `submit_review` puts the cost in exactly the wrong
places:

1. **The within-agent case gets a formal card it doesn't need.** A review that
   never left the agent is handed a bordered `aiReview` artifact via a dedicated
   MCP tool. The agent could simply narrate it.
2. **The cross-agent case — the one place ShipIt should be authoritative — is
   delegated back to the agent.** The reviewer's text round-trips out to the
   primary on stdout, and whether it reaches the transcript depends on the
   primary (an LLM) choosing to call `submit_review` with the text *verbatim*.
   It can forget the call, paraphrase, summarize, or editorialize. Routing the
   content through the thing being second-guessed is the wrong shape for a
   faithful second opinion — an extra hop and a fidelity risk.

So `submit_review` gives a card to the case that doesn't need one and punts the
case that does.

## The surface already exists

ShipIt already emits a deterministic, persisted **`sub_agent_consult_card`**
("Consulted Codex · 47s") for every terminal status (`docs/144` §7). It is
literally the "here's what happened across the boundary" primitive — it just
carries *metadata* (status / duration / cost), not the reviewer's *content*.
And `services/sub-agent.ts` already has the full result text (`result.text`) in
hand at emit time.

So making cross-agent surfacing deterministic is a small, additive change, not a
rearchitecture:

- Add a content field (e.g. `outputMarkdown`) to `SubAgentConsultCard`. This is
  a **type-only** change to the persistence layer: `chat-history.ts` already
  stores the whole card as JSON in the existing `sub_agent_consult` column
  (`toRow` does `JSON.stringify(subAgentConsult)`; `fromRow` parses it back), so
  a new field rides inside that blob — **no new column and no migration**. The
  card is already in `CARD_MESSAGE_FIELDS` and the round-trip guard tests already
  cover the wiring; the real work is the type + card construction + renderer +
  fixtures.
- Render the consultant's **verbatim** output in the card, **attributed** to the
  reviewer, expandable.
- Keep returning the text on stdout so the primary can still *act* on it (apply
  fixes). Surfacing and acting are decoupled: ShipIt owns surfacing, the agent
  owns acting.

The two properties that justify ShipIt's involvement and must be preserved:
**attribution** ("this is Codex's take") and **verbatim fidelity** (no LLM in
the middle re-typing it).

### How the card behaves (resolved under Option B)

- **No surface gating — every brokered spawn carries content.** `shipit agent
  run` is generic, but under B that doesn't force a `--surface review` signal:
  *all* brokered spawns carry their output in the card. The noise concern (a
  routine "fix this typo" spawn dumping stdout) is handled by **presentation,
  not gating** — see truncation below. So no flag has to thread the shim →
  broker → route → service path; the content already flows back to
  `services/sub-agent.ts` (`result.text`) and is written into the card there.
  **Decided:** all brokered output renders **identically** — an attributed
  markdown preview. There is no separate "review styling" and **no render-mode
  hint** in v1; a review is just a consult card whose content happens to be
  findings, and the attribution (`subAgentId`) is already on the card.
- **Each brokered call is its own card — no patch-in-place.** This deliberately
  **rejects** docs/203's single-card (`submit_review` patches the same card)
  semantics for the brokered path. A re-review is a *separate agent call*; from
  the user's point of view it makes no sense for it to silently rewrite a card
  several screens up. So the existing per-spawn `cardId` (`randomUUID()` in
  `services/sub-agent.ts`) stays as-is: the first review emits a card anchored
  where it happened, the parent's fixes land between, and the re-review emits a
  **second** card after them. The transcript reads as the real sequence —
  *review → fixes → re-review* — and each card is an accurate, persisted record
  of the state at its own moment (the first pass was correct *then*; it is not
  "stale," it is history). This is the CLAUDE.md transcript-content model: every
  brokered call is a fact the scrollback keeps.
- **Stripped-down in card, full review in a viewer (truncation).** The card
  shows a **preview** of the output (a leading slice / summary line), not the
  whole thing inline. Clicking it opens the **full markdown** in a viewer. The
  persisted blob keeps the full text up to a cap, with the spawn primitive's
  existing `truncated` flag marking a hard cut. "Available, not shouting": a
  routine delegation collapses to a quiet line, a review expands to its findings
  on demand.
  - **The viewer must be read-only and must not be a file view.** This output is
    transcript content, **not** a workspace file. Do **not** route it through
    `FilePreviewModal` / a workspace-relative path — that would wrongly expose
    file-review affordances (inline comments, "ask agent to review") on
    generated, non-file content. **Decided:** a **dedicated read-only modal/pane
    wrapping `MarkdownContent`** — *not* `FileContentView` (which carries
    file-review wiring even when flags disable it). The comment / ask-review
    handlers simply do not exist on this path.

## Consequence: `submit_review` is removed

**Decided:** `submit_review` is removed entirely — neither path uses it.

- **Cross-agent review** → ShipIt auto-renders from the brokered result (the
  content-carrying consult card). No tool.
- **Same-model review** (`/review` with Multi-agent off, or no other agent signed
  in) → the agent **narrates the findings as chat prose**. No card, no tool.

This is a deliberate change to today's `docs/203` behavior, where the same-model
review produced a card via `submit_review`; under B that card is gone for the
same-model case. Accepted on the principle: an agent reviewing its own session's
code in-context is doing *internal* work, which it narrates — ShipIt only renders
what it **brokers**, and a same-model `Task` review is not brokered.

Removing the tool also retires `docs/203`'s AI-review card for **new** reviews:
the `ai_review` write path stops, and `ReviewCard.tsx` renders only legacy rows.
The human **user-comment** review path (a person leaving inline notes) is
untouched.

## Decision: Option B

The choice was between:

- **(A) Accept a divergence.** Surface content only for review-shaped spawns;
  leave generic brokered delegations metadata-only. Two different surfaces.
- **(B) One content-carrying card for every brokered spawn.** The consult card
  is *always* the surface; a review is just that card rendered richly;
  `submit_review` is **removed** (see "Consequence" — same-model review then
  narrates as prose).

**B is chosen,** on the transparency principle: everything ShipIt brokers should
be visible in the UI, including the *content* the consultant produced — not only
generic delegations' metadata. A surfaces the call but hides its output unless it
was a review; B surfaces both, always.

Note this means **within-agent `Task` stays prose** regardless — and that is
consistent, not an exception: ShipIt does not *broker* a `Task` subagent (it runs
in-process; ShipIt never sees its output), so the transparency principle does not
reach it. B governs **brokered** calls; `Task` is not one.

## Reconciliation with existing docs

- **`docs/203` (plain-text AI review, SHI-136)** — currently implemented. Its §3
  + "submit_review" sections assume the parent records the card for both modes,
  and its `submit_review` **patches one card** across review → re-review. Under
  Option B `submit_review` is **removed** for both branches: the cross-agent
  review moves to the consult-card path here, and the same-model review narrates
  as prose. The single-card / patch-in-place semantics are dropped with it, and
  the AI-review card (`ReviewCard`, `ai_review`) is retired for new reviews
  (legacy rows still render). The human user-comment path is untouched. This is a
  deliberate revision of shipped behavior.
- **`docs/144` (sub-agent spawning, SHI-37)** — §6 ("output is text; review is an
  optional renderer") and §7 ("chat surfacing", the consult card). This proposal
  extends §7's consult card from metadata-only to content-carrying.

## Key files (Option B)

- `src/server/orchestrator/services/sub-agent.ts` — already holds `result.text`
  and emits the consult card; write the (capped) output into the card's new
  content field instead of dropping it. Keeps the per-spawn `cardId` — no
  patch-in-place.
- `src/server/shared/types/domain-types/chat.ts` — `SubAgentConsultCard` gains a
  content field (e.g. `outputMarkdown`). Reuse the **existing** `truncated`
  field (already on the type at `chat.ts:48`) for the hard-cut marker — no new
  truncation flag.
- `src/server/orchestrator/chat-history.ts` — `toRow`/`fromRow` already persist
  the whole card as JSON in the existing `sub_agent_consult` column (added in
  `shared/database.ts`), so the new content field rides inside that blob — **no
  migration needed**.
- `src/client/components/visual-elements.ts` — `CARD_MESSAGE_FIELDS` (already
  lists `subAgentConsult`).
- `src/client/components/MessageList.tsx` — `SubAgentConsultCardRow` renders the
  **stripped-down preview** + a click target.
- A **read-only** markdown viewer for the full output — a dedicated modal/pane
  wrapping `MarkdownContent`, **not** `FilePreviewModal` over a workspace path
  (see "How the card behaves" → viewer note). Must carry no file-review,
  comment, or ask-review affordances.
- `src/client/utils/compose-review-body.ts` — **in scope.** This is where the
  `/review` flow currently instructs the parent to call `submit_review` after
  `shipit agent run` and to patch the same card on re-review (lines ~15–17,
  101–107, 128). Rewrite **both** prompts to drop the `submit_review`
  instruction: the cross-agent prompt relies on the auto consult card (parent
  uses stdout **only** to act / fix / re-review); the same-model prompt tells the
  parent to **present findings as prose**. No `submit_review` call in either path.
- `src/server/session/mcp-tools/review.ts` — **remove** `submit_review` (the AI
  branch); drop its bridge registration (`mcp-shipit-bridge.ts`), the
  orchestrator submit relay, and the `ai_review` write path. `ReviewCard` renders
  legacy rows only. **Keep** the human user-comment endpoints.

Out of scope under B: a `--surface review` flag threaded through the shim /
broker / spawn route (that was only needed for the rejected Option A gate; B
carries content for every brokered spawn, so no flag). Note this is distinct from
the `compose-review-body.ts` change above, which *is* in scope — it removes the
`submit_review` instruction, it does not add a gate flag.
