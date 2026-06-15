---
issue: https://linear.app/shipit-ai/issue/SHI-151
description: Surface the issue(s) related to a session/PR as intent-led chips folded into the PR card's collapsible changed-docs panel.
---

# PR-card issue chips (docs/206)

Show the issue(s) a session or PR relates to as compact, clickable chips folded
into the PR card's existing collapsible panel — the same strip that already
lists changed docs (docs/205). No new surface, no new chrome: the panel toggle
that today appears for notable files now also appears when there are related
issues, and the chips lead the wrapping row ahead of the file chips.

This is the inline realization of the principle in CLAUDE.md §1/§2: the issue a
PR closes is part of "everything the user wants to know about the PR," so it
renders **inside** ShipIt. Clicking a chip opens ShipIt's inline issue detail
view (`issues-store.openIssue`) — the same destination the docs-list
jump-to-issue chip uses — not a GitHub/Linear tab.

Visual reference: [`mockup.html`](./mockup.html) — four layout options were
prototyped; we shipped **Option 3 (intent-led pill, single row)**.

## Why Option 3

Each chip carries its own intent verb (`Closes` / `Refs` / `From session`), so:

- **Source and intent travel with the chip**, not a section label — order and
  wrapping don't change meaning, so the chips can share one flat row with the
  file chips (smallest structural change to docs/205's panel).
- **The session-origin case is first-class.** A session started from an issue
  shows its `From session` chip *before any PR exists* — covering the pre-PR
  window the PR-body-only options (1/2/4) can't.

Full chips drop the issue title to stay compact; the title rides in the chip's
`title` tooltip.

## Detection — two sources, deduped, zero new persistence

The key realization: **everything needed is already on the client.** No server,
poller, type, or DB-migration change.

1. **PR body** (`Closes` / `Fixes` / `Resolves` → `closes`; `Refs` /
   `References` → `refs`). Parsed by the existing
   `parsePrBodyIssueRefs()` (`src/server/shared/pr-issue-refs.ts`). The body is
   already on the client: `card.pr.body` (lifecycle update) and
   `PrStatusSummary.prBody` (poller) both carry it.
2. **Session origin** (`origin`). When a session is created from an issue (the
   Issues tab / `seedFromIssueRef`), the first user message contains a seed of
   the form `You are working on issue <KEY>: <title>` + `Issue link: <url>`.
   The first user message is already in the client session store (the same field
   `SessionTitleLabel` reads). A new conservative free-text extractor,
   `extractIssueRefsFromText()`, pulls pointers out of it.

The two source lists are merged and deduped by `tracker:issueId` with
precedence **closes > refs > origin** (the strongest intent a pointer appears
under wins), by `collectPrCardIssueRefs()`.

### Why a conservative free-text extractor

`parsePrBodyIssueRefs` is keyword-anchored (`Closes …`), which a free-form first
message won't reliably contain. But scanning free text for bare Linear keys
(`[A-Z]+-\d+`) false-positives on `UTF-8`, `ISO-8601`, `GPT-4`, etc. So
`extractIssueRefsFromText` only accepts **unambiguous** shapes:

- Full Linear issue URLs (`https://linear.app/<ws>/issue/KEY`)
- Full GitHub issue URLs (`https://github.com/o/r/issues/N`)
- GitHub short refs (`owner/repo#N`)
- Bare Linear keys **only when preceded by the word `issue`** (case-insensitive,
  e.g. `working on issue SHI-90`, `issue: SHI-90`) — which the seed always
  produces and natural phrasing usually does.

A bare `SHI-90` typed with no `issue` lead-in is intentionally *not* matched
(the false-positive cost outweighs it). Documented as a known limitation.

## Data flow

```
                 ┌─ card.pr.body / status.prBody ──► parsePrBodyIssueRefs ─┐
PrLifecycleCard ─┤                                                          ├─► collectPrCardIssueRefs ─► IssueChipRef[]
                 └─ first user message (session store) ► extractIssueRefsFromText ┘                          │
                                                                                                              ▼
                                              gate panel toggle on (notableFiles.length || issueRefs.length)
                                                                                                              │
                                                                          ChangedDocsStrip(issueRefs, notableFiles)
                                                                          → [issue chips] │ divider │ [file chips]
```

## Key files

- `src/server/shared/issue-ref.ts` — `parseIssueRef` (existing) + new
  `extractIssueRefsFromText()` free-text extractor.
- `src/server/shared/pr-issue-refs.ts` — `parsePrBodyIssueRefs` (existing,
  reused unchanged).
- `src/client/utils/pr-card-issue-refs.ts` — `IssueChipRef` type +
  `collectPrCardIssueRefs({ prBody, firstUserMessage })` combiner/deduper.
- `src/client/components/ChangedDocsStrip.tsx` — extended to render leading
  issue chips + a divider before the file chips; new `PrCardIssueChip`.
- `src/client/components/PrLifecycleCard.tsx` — computes `issueRefs` via memo,
  gates the panel toggle on issues-or-files, passes `issueRefs` to the strip.

## Rendering rules

- Chip click → `issues-store.openIssue()` for a known tracker (inline detail);
  external link only for an unknown-shape pointer with a URL; plain badge
  otherwise. Mirrors the docs-list `IssueChip`.
- Intent tint: `closes` → success border/tint; `refs` → quiet tertiary verb;
  `origin` → dashed border, `--color-pr` verb.
- The panel (and its header toggle) now appears when there are issues **or**
  notable files. An issues-only PR still gets the toggle.
- The strip keeps docs/205's sticky behavior; issue chips are recomputed from
  card/store data each render (pure), so they survive poll ticks for free.

## Known limitations / future work

- Bare Linear keys without an `issue` lead-in aren't matched in the first
  message (false-positive avoidance).
- Session-origin detection re-parses the first user message each render rather
  than persisting an `issueRef` on the session row. If we later want the chip
  before the first message is even in the store, persist `issuePointer` on
  `SessionRow` (a migration) — deferred; the parse-the-message approach covers
  the UI-created-from-issue path today.
