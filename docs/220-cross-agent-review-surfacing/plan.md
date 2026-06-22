---
issue: https://linear.app/shipit-ai/issue/SHI-195
title: Cross-agent review surfacing — ShipIt renders what it brokers
description: Render cross-agent reviewer output deterministically in the consult card instead of routing it back through the parent agent's submit_review call.
---

# Cross-agent review surfacing — ShipIt renders what it brokers

> **Status: proposal, pre-decision.** Nothing here is implemented. It revises a
> mechanism that is currently *shipped* (`docs/203`, the parent calling
> `submit_review`) and the surfacing design in `docs/144` §6–§7. The current
> behavior stands until this is accepted. Split out of `docs/144` so the
> proposal isn't buried mid-doc.

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

### Two design constraints the content-carrying card must satisfy

These are not optional — they are why this is a real design and not a one-line
field add:

- **Gate the content render to surfacing intent (generic vs review).**
  `shipit agent run` is a *generic* delegation primitive — a spawn might be a
  refactor or a one-line fix, not a review — and dumping every spawn's full
  stdout into a persisted transcript card would be noise. So content-rendering
  must be gated: either a review/surface signal on the spawn (e.g. `shipit agent
  run --surface review`, or a review-specific orchestrator route) populates
  `outputMarkdown` only for that mode and leaves ordinary consults
  metadata-only — or, under option **(B)** below, the consult card *always*
  carries a collapsed content payload and "review" is just richer presentation
  on top. Which is right is part of the open question.
- **Preserve docs/203's re-review (single-card) semantics.** docs/203's flow is
  *review → fix → re-review*, and its `submit_review` **patches the same card**
  rather than stacking a second. The consult card today gets a fresh `cardId`
  per spawn (`randomUUID()` in `services/sub-agent.ts`), so a second review
  spawn would emit a **new** card and leave the stale first-pass findings in the
  transcript next to the final ones. A review-mode consult therefore needs a
  stable identity (a `reviewRunId`/attempt key) and must **update one card in
  place** on re-review — or explicitly mark the first-pass card superseded —
  before rendering the final reviewer output.

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

## The open question (decide before any code)

Under this model an in-agent review looks like **prose** and a cross-agent
review looks like a **card**. That asymmetry is **information** — it signals that
an opinion crossed into a different model — not an inconsistency to be smoothed
away. The thing `docs/203` optimized for ("identical card in both modes") is
exactly what this trades away, on purpose.

So the decision is:

- **(A) Accept the divergence.** Cross-agent is deterministic because it's
  brokered; `Task` keeps narrating. Two visibly different surfaces, on purpose.
- **(B) Reframe around the consult card.** The consult card is *always* the
  review surface; `submit_review` is demoted to a presentation-only escape
  hatch (or removed). Preserves a single "card path" while still killing the
  probabilistic hop.

This doc does not pick one — that's the reaction it's waiting on.

## Reconciliation with existing docs

- **`docs/203` (plain-text AI review, SHI-136)** — currently implemented. Its §3
  + "submit_review" sections assume the parent records the card for both modes.
  If accepted, the **cross-agent** branch of `docs/203` moves to the consult-card
  path here, and `submit_review`'s role shrinks to (at most) the within-agent
  presentation case. This is a deliberate revision of shipped behavior.
- **`docs/144` (sub-agent spawning, SHI-37)** — §6 ("output is text; review is an
  optional renderer") and §7 ("chat surfacing", the consult card). This proposal
  extends §7's consult card from metadata-only to content-carrying.

## Key files (if accepted)

- `src/server/orchestrator/services/sub-agent.ts` — already holds `result.text`;
  would render it into the consult card instead of only metadata.
- `src/server/shared/types/domain-types/chat.ts` — `SubAgentConsultCard` gains a
  content field.
- `src/server/orchestrator/chat-history.ts` — `toRow`/`fromRow` already persist
  the whole card as JSON in the existing `sub_agent_consult` column (added in
  `shared/database.ts`), so the new content field rides inside that blob — **no
  migration needed**.
- `src/client/components/visual-elements.ts` — `CARD_MESSAGE_FIELDS` (already
  lists `subAgentConsult`).
- `src/client/components/MessageList.tsx` — `SubAgentConsultCardRow` renders the
  reviewer's markdown.
- `src/server/session/mcp-tools/review.ts` — `submit_review`; role shrinks or is
  removed depending on the open question.

If the open question resolves to a gated `--surface review` signal (rather than
option **(B)**'s always-content card), the intent has to thread the whole spawn
path, not just the card — so these are also in scope:

- `src/server/session/agent-shim/shipit-agent.ts` — parse the surfacing flag/field
  on `shipit agent run`.
- `src/server/session/agent-ops-routes.ts` — worker broker relay carries it.
- `src/server/orchestrator/api-routes-agent.ts` — `POST /api/sessions/:id/agent/spawn`
  accepts it.
- `src/server/shared/sub-agent-run.ts` (and the spawn input types) — the field
  that carries surfacing intent into `runSubAgent`/`runAgentToCompletion`.
- `src/client/utils/compose-review-body.ts` — the `/review` flow sets the
  surfacing intent at request time.
- Tests for each of the above (shim, broker/route, service gate, client compose).
