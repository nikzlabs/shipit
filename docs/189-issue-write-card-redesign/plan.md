---
issue: https://linear.app/shipit-ai/issue/SHI-101
title: Issue-write provenance card redesign — content-led, attribution dropped
description: Redesign the agent issue-write card to lead with the issue and surface the actual change (comment body, title/status/assignee deltas), and remove the meaningless authorship line.
---

# Issue-write provenance card redesign

## What this changes

docs/177 shipped the do-then-surface provenance card for agent issue writes
(`shipit issue comment`/`edit`/`status`/`assign`). In use it reads:

> ✎ Agent commented on SHI-48 *by the ShipIt agent (workspace token)* ⧉ SHI-48 ↶ Undo

It records **that** a write happened but not **what** — and spends its most
prominent words on an authorship string that carries no actionable information.
This doc redesigns the card to lead with the issue and surface the actual
change, and drops the attribution line entirely.

**Visual reference:** [`mockup.html`](./mockup.html) — before/after across all
four verbs plus the GitHub-identifier and undone-terminal states.

## The three problems (today's card)

1. **The actual content is missing.** For a comment, the body is the whole point
   — and it is never even *captured* on the card (`IssueWriteCard.undo` for a
   comment stores only `{ commentId }`). For an edit, the summary says
   `edited title & description on SHI-48` but never the new values. The card
   records the verb, not the change.
2. **The issue is opaque.** The payload already carries `title`, but the card
   never renders it, so `SHI-48` tells you nothing about which issue was touched.
   The identifier also appears **twice** — once in the sentence, once as the link
   chip.
3. **Attribution is noise.** `by the ShipIt agent (workspace token)` is the
   visually loudest element, and `(workspace token)` is implementation jargon.

## Decisions

### Drop the authorship line entirely

The `attribution` field encodes **which tracker identity the write posts under** —
*not* who triggered it (the agent always does). GitHub writes use the acting
user's own token, so the comment is authored by **you**; Linear writes use a
single deployment-wide workspace PAT, so the comment is authored by the
**workspace bot**, identically for every ShipIt user.

The docs/177 constraint was narrow: the card must **not claim** *you* authored a
Linear write. The clean way to honor "don't overclaim authorship" is to **claim
no authorship at all** — the card is self-evidently the agent's (it lives in the
agent's transcript and carries an Undo), so spelling out the backing identity
adds nothing the user can act on. If they ever care, the deep-link shows the real
author in the tracker.

A `workspace`/`agent` badge was considered and rejected for the same reason: no
action attaches to it. The `attribution` field **stays in the data model**
(cheap, useful for a future audit log) — it is simply no longer rendered.

### Lead with verb + issue; surface the change on a second line

- **Line 1 — verb + identifier:** an explicit verb word does the disambiguation,
  not the icon alone: **Commented on** · **Edited** · **Set status of** ·
  **Assigned** + the bold identifier. (`Set status of`, not `Moved` — "moved"
  reads as moved-to-another-project.) The identifier is no longer duplicated; the
  deep link collapses to a bare ⧉ icon.
- **Issue title** renders faint under line 1, so you know *which* issue without
  the link-out.
- **Line 2 — the actual change**, verb-specific:
  - **comment** → a 2-line quoted preview of the comment body
  - **edit** → `title: old → new` strikethrough/insert delta + "description updated"
  - **status** → `In Progress → In Review`
  - **assignee** → `→ Nik Zherebtsov`
- Comments get a distinct filled speech-bubble icon so the most common write is
  unmistakable at a glance.

The undone terminal state and the GitHub `owner/repo#N` identifier render through
the same layout (see mockup).

## Implementation sketch

The layout changes are client-only, but **surfacing the change requires a
server-side payload addition** — today only undo internals are captured, so the
display values for line 2 don't exist on the card yet.

- **Types** — add an optional `content` to `IssueWriteCard` carrying the line-2
  display values: comment-body preview, the title `{ before, after }` pair, the
  status `{ from, to }` names, the assignee name. Keep `attribution` but stop
  rendering it.
- **Services** (`services/issues.ts`) — `commentOnIssueForTracker` /
  `updateIssueForTracker` / `setIssueStatusForTracker` /
  `setIssueAssigneeForTracker` already read prior state for the undo snapshot;
  stash the human-readable display values onto the outcome alongside it. The
  comment body is available at call time (`body`) but currently discarded — keep
  a clipped preview.
- **Persistence** — flow the new `content` field through `chat-history.ts`
  `toRow`/`fromRow` (+ a `database.ts` migration), and extend the docs/188 guard
  contract: add the field to `EVERY_OPTIONAL_FIELD_MESSAGE` and the
  history round-trip + no-duplicate-on-replay tests.
- **Client** — rewrite `IssueWriteCard.tsx` to the two-line layout; remove the
  `attribution` string; add the speech-bubble/verb mapping. `issueWrite` stays in
  `CARD_MESSAGE_FIELDS` (already there).

## Out of scope

- The undo mechanics, brokering path, and identity/token isolation — unchanged
  from docs/177.
- Per-user Linear attribution (would need per-user Linear auth) — still a noted
  docs/177 limitation, not addressed here.

## Key files

- `src/client/components/IssueWriteCard.tsx` — the card; two-line rewrite.
- `src/server/shared/types/domain-types.ts` — `IssueWriteCard.content` field.
- `src/server/orchestrator/services/issues.ts` — stash line-2 display values.
- `src/server/orchestrator/chat-history.ts` — persist the new field (`toRow`/`fromRow` + migration).
- `src/server/shared/types/ws-server-messages.ts` — `WsIssueWriteCard` carries the same payload.
- `chat-history.test.ts`, `visual-elements.test.ts` — docs/188 guard contract.

## Related docs

- `docs/177-agent-issue-writes/` — the card and write path this redesigns.
- `docs/188-issue-read-card/` — the read-card sibling and the persisted-card guard contract.
