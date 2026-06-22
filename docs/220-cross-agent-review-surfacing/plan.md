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
  A spawn *may* still carry an optional hint for *how richly* to render (review
  styling vs plain output), but that is cosmetic, not a gate on whether content
  is shown.
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
  whole thing inline. Clicking it opens the **full markdown** in a viewer (the
  shared markdown renderer used by the file dialog / Present tab). The persisted
  blob keeps the full text up to a cap, with the spawn primitive's existing
  `truncated` flag marking a hard cut. "Available, not shouting": a routine
  delegation collapses to a quiet line, a review expands to its findings on
  demand.

## Consequence: `submit_review` may not need to exist

Following the principle to its end:

- **Within-agent review** → the agent narrates (prose / markdown). No tool.
- **Cross-agent review** → ShipIt auto-renders from the brokered result (the
  content-carrying consult card). No tool.

The one residual function `submit_review` performs — "render my markdown as a
styled card" — is a pure **presentation** concern, a cousin of the `present`
tool, not a review- or spawn-specific one. If within-agent reviews genuinely
want a bordered card, that argues for a generic "render-as-card" primitive, not
a review-shaped MCP tool wired into the spawn flow.

## Decision: Option B

The choice was between:

- **(A) Accept a divergence.** Surface content only for review-shaped spawns;
  leave generic brokered delegations metadata-only. Two different surfaces.
- **(B) One content-carrying card for every brokered spawn.** The consult card
  is *always* the surface; a review is just that card rendered richly;
  `submit_review` is demoted to presentation-only or removed.

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
  Option B the **cross-agent** branch moves to the consult-card path here:
  `submit_review` is demoted to presentation-only (or removed), and the
  single-card / patch-in-place semantics are **explicitly dropped** for brokered
  reviews — each brokered call is its own anchored card. This is a deliberate
  revision of shipped behavior.
- **`docs/144` (sub-agent spawning, SHI-37)** — §6 ("output is text; review is an
  optional renderer") and §7 ("chat surfacing", the consult card). This proposal
  extends §7's consult card from metadata-only to content-carrying.

## Key files (Option B)

- `src/server/orchestrator/services/sub-agent.ts` — already holds `result.text`
  and emits the consult card; write the (capped) output into the card's new
  content field instead of dropping it. Keeps the per-spawn `cardId` — no
  patch-in-place.
- `src/server/shared/types/domain-types/chat.ts` — `SubAgentConsultCard` gains a
  content field (e.g. `outputMarkdown`) plus the `truncated` marker if not
  already carried.
- `src/server/orchestrator/chat-history.ts` — `toRow`/`fromRow` already persist
  the whole card as JSON in the existing `sub_agent_consult` column (added in
  `shared/database.ts`), so the new content field rides inside that blob — **no
  migration needed**.
- `src/client/components/visual-elements.ts` — `CARD_MESSAGE_FIELDS` (already
  lists `subAgentConsult`).
- `src/client/components/MessageList.tsx` — `SubAgentConsultCardRow` renders the
  **stripped-down preview** + a click target.
- The shared markdown viewer (file-dialog / Present renderer, unified per the
  recent shared-renderer change) — opened on click to show the **full** output.
- `src/server/session/mcp-tools/review.ts` — `submit_review` demoted to
  presentation-only or removed; if removed, drop its bridge registration and the
  `/review` flow's dependence on it.

Out of scope under B (would only be needed for the rejected Option A gate): a
`--surface review` flag threaded through the shim / broker / spawn route /
`compose-review-body.ts`. Not built.
