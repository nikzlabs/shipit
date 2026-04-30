---
status: planned
---

# 112 — Unified Review Surface

## Summary

ShipIt has two overlapping ways to leave inline comments on files and send
them to the agent: the file preview modal (any file, localStorage-persisted,
section comments on markdown and line comments on code) and the docs-pane
"Review" button (server-persisted, only on feature plans, with AI Review
and a history of past reviews). The two surfaces look almost identical to
the user but behave very differently underneath, and the entry point to
the richer one is silently broken. This doc proposes collapsing them into
a single review surface, anchored on the file preview modal, that gains
the strengths of the docs-pane review tool.

## Motivation

When a user reviews a file — whether it's a feature plan, a generated
component, or anything else — the task is the same shape every time:

> Read it. Leave notes attached to specific parts. Send the notes to the
> agent so it can act on them.

Today, two systems answer that need.

| | File preview modal | Feature review panel |
|---|---|---|
| **Entry point** | Click any file in the file tree, the docs pane, an upload chip, a message attachment | Click "Review" on a doc row in the docs pane (broken — fetches a non-existent endpoint) |
| **Scope** | What you can comment on | Feature plans only (`docs/NNN-*/plan.md`) |
| **Granularity** | Section comments on markdown, line comments on code | Section comments on markdown |
| **Storage** | Browser `localStorage`, keyed by `(sessionId, filePath)` | Server, keyed by feature directory |
| **Persistence across sessions** | No | Yes |
| **Survives clearing browser data** | No | Yes |
| **Lifecycle** | Flat list of comments | Draft → Sent, with auto-cleanup of empty drafts |
| **History of prior reviews** | None | "Past reviews (N)" expander with comment-by-comment recall |
| **AI assist** | None | "AI Review" button generates section comments |
| **Send to agent** | "Send Comments" → prompt → `send_message` | "Send Comments" → prompt → `send_message` |

This is two implementations of the same product idea, with different
strengths split between them. The feature review panel has the better
backend (server-persisted, lifecycle, history, AI). The file preview modal
has the better reach (every file, every entry point, line and section
granularity, already wired in). Neither alone covers what we want, and
together they confuse the user — there are two buttons to leave a comment
on a feature plan, they store data in different places, and one of them
doesn't even open.

The product principles in `CLAUDE.md` apply directly:

- **§1 ShipIt is the surface.** Reviewing should not require remembering
  which of two panels the user happened to use last time, nor "I left a
  note in the other browser tab and it's gone now."
- **§2 Inline beats link-out.** Having two inline panels compete for the
  same job is the same anti-pattern as linking out, just localized.
- **§4 If we don't render it inline yet, that's a backlog item.** The
  full set of review affordances (drafts, history, AI Review) should be
  reachable from anywhere a user can open a file, not just from one
  buried button on docs with a `status` frontmatter.

## Goals

1. **One review surface.** A single panel handles all file-attached
   comments, regardless of file type or where the user opened the file
   from.
2. **Server-persisted within the session.** Comments survive browser
   changes, device changes, and `localStorage` resets. Pulling out a
   phone to continue the same session on a desktop should Just Work.
   Comments do not follow the user across session switches — a session
   is the unit of work, and a review belongs to the session it was
   written in.
3. **A real lifecycle.** Drafts and sent reviews are first-class. The
   user can tell what they've already sent, what's still pending, and
   what was reviewed before.
4. **AI Review available everywhere it makes sense.** Not gated behind
   one specific button on one specific file type.
5. **One predictable entry point.** Clicking the file opens the surface.
   No second button that does almost-but-not-quite the same thing.

## Non-goals

- **Multi-user collaborative review.** Out of scope. One user, one
  review at a time.
- **Diff-anchored review (PR-style).** Comments tied to a specific commit
  or to changed lines in a diff are a different feature; the existing
  diff panel already covers in-flight diff feedback. This doc is about
  the durable, file-anchored surface.
- **Sync to or from GitHub PR comments.** Tracked separately under
  `102-github-pr-comment-sync`.
- **Replacing the inline diff comment flow.** The diff review panel
  remains the place to comment on a specific staged change; the unified
  surface is for reviewing files in their current state.

## Proposed design

### One panel, opened the same way every time

Clicking any file — in the file tree, the docs pane, an upload chip, a
message attachment, or a deep link — opens the file preview. The preview
already knows how to render markdown (with section anchors) and code
(in Monaco with a glyph margin); both are kept. Comments and review
controls become a built-in part of the preview, not a separate panel.

The "Review" button on doc rows is removed. The user reviews a feature
plan the same way they review anything else: open it, leave comments,
send. There is no second affordance to discover, and no per-file-type
fork in the UI.

### Mockup

```
┌─────────────────────────────────────────────────────────────────────┐
│  docs/064-pr-lifecycle-flow/plan.md       [AI Review] [Send] [×]   │
│─────────────────────────────────────────────────────────────────────│
│                                                                     │
│  ## Summary                                                  [+]    │
│  The PR lifecycle card is a unified surface for…                    │
│                                                                     │
│    ┌─ 👤 You ──────────────────────────────────────────────┐       │
│    │ This section is too vague — what does "unified" mean   │       │
│    │ in concrete terms?                                     │       │
│    │                                          [Edit] [Del]  │       │
│    └────────────────────────────────────────────────────────┘       │
│                                                                     │
│  ## Architecture                                             [+]    │
│  Three components: the card, the poller, the renderer…              │
│                                                                     │
│    ┌─ 🤖 AI ────────────────────────────────────────────────┐      │
│    │ Consider documenting the failure modes of the poller    │      │
│    │ — what happens if GitHub returns 5xx?                   │      │
│    │                                          [Edit] [Del]   │      │
│    └─────────────────────────────────────────────────────────┘      │
│                                                                     │
│─────────────────────────────────────────────────────────────────────│
│  2 comments — draft                              [Cancel] [Send ▶]  │
│  ▸ Past reviews (3)                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

The header carries the action affordances (AI Review, Send, Close); the
body is the file with inline comments interleaved at section or line
anchors; the footer summarizes the draft state and exposes past reviews.
Code files use the same shell, but the body is Monaco with a gutter
comment widget instead of a markdown renderer.

### Comment scope and persistence

A review draft lives at the granularity of `(session, file path)` and
is persisted server-side. Opening the same file inside the session
where the comments were written loads the draft back; opening the same
file in a different session starts fresh.

This rule mirrors how the rest of ShipIt scopes work — chat history,
diffs, queued prompts, the agent's running turn — and matches the
mental model that a session is one continuous slice of work. A comment
left during a session belongs to that session's review, not to the
file in the abstract. If the user later switches sessions to pick up
the same line of work, that's a session-history concern, not something
the review surface tries to solve.

When the user sends a review, that draft is frozen as a "sent" review
and a fresh empty draft is started for the next pass within the same
session. Sent reviews are preserved as history (see below) and never
overwritten.

Empty drafts auto-cleanup when the user closes the panel without typing,
matching today's feature review panel behavior, so the database doesn't
fill up with empty rows just from people skimming files.

### Lifecycle: draft → sent → history

Three states, exposed clearly in the UI:

- **Draft.** The user is composing comments. Status pill in the footer
  reads "draft." All edit/delete affordances available.
- **Sent.** The user clicked Send Comments. The review is frozen, the
  prompt was dispatched to the agent, and a new empty draft was created.
  The just-sent review appears at the top of "Past reviews."
- **History.** All previously-sent reviews on this file *within the
  current session*, with timestamps, comment counts, and the ability
  to expand and re-read individual comments. Read-only. Reviews from
  other sessions don't appear here — that view, if we want it later,
  is a different feature.

This matches today's feature review panel lifecycle for plans, and
extends the same shape to every file.

### AI Review, generalized

The AI Review affordance is preserved and is available on the unified
panel, not only on feature plans. The actual usefulness of an AI review
varies by file type — a feature plan is the strongest case, code files
are weaker but plausible, binaries are not in scope. Whether AI Review
should be visible at all on a given file type is a question for the
detailed design phase; the product-level position is that it's a
property of the unified panel, not of one file type.

### Granularity preserved per file type

- **Markdown:** comments anchored to `##` (and lower) headings, with
  `[+]` controls in the gutter of each section. This is what both
  systems do today.
- **Code:** comments anchored to a line number, with the comment widget
  shown in the Monaco glyph margin. This is what the file preview does
  today and is preserved.
- **Image / binary:** no comment surface. The preview opens read-only.

### Send Comments → prompt

Unchanged in shape: the user clicks Send Comments, the server
serializes the comments into a structured prompt that names the file,
the section or line, and the comment text, and dispatches it to the
agent in the active session via the existing `send_message` flow. The
review transitions to "sent" and is added to history.

### What goes away

- The "Review" button on doc rows in the docs pane.
- The `localStorage`-only file comment store. (Migration: see below.)
- The split between "feature review" and "file comment" as separate
  product concepts. There is one concept: a review.

## Decisions and open questions

Things this doc commits to:

1. **One panel.** The file preview is the surface; the feature review
   panel as a separate route is removed.
2. **Server-side persistence.** No `localStorage` for comments.
3. **Draft scope is (session, file).** Comments belong to the session
   they were written in. Not repo-scoped, not feature-scoped, not
   branch-scoped.
4. **Lifecycle = draft → sent → history.** Same shape across all files.
   History is per-session, per-file.
5. **The "Review" button in the docs pane is removed.** Click the doc
   to review it.
6. **Existing comments are dropped on rollout.** No migration. The
   `localStorage` store is cleared on first load after the change, and
   server-side feature reviews from `049-design-doc-comments` are not
   ported into the new schema. Users start with an empty review surface.

Things to settle in detailed design (not in this doc):

1. **Do code files get AI Review?** The infrastructure can support it;
   the question is whether the output is good enough to expose. Could
   ship behind a per-file-type capability flag.
2. **Do line-anchored comments on code "stick" when the file changes?**
   GitHub anchors to a specific commit; we don't have that grain
   naturally. Likely answer: best-effort line tracking, with an
   "outdated" indicator when the surrounding text has shifted enough.
3. **Cross-session history view.** Some users will want to see "all
   reviews on this file across all sessions" eventually. Not in v1;
   noted here so we don't paint ourselves into a corner that makes it
   hard to add later.
4. **Visibility once we add multi-user repos.** Today this is single-user
   so the question is moot; flagging it for the eventual sharing design.

## Migration

There is no migration. On rollout:

- The `localStorage` file-comment store is cleared on first load. Any
  unsent local notes are lost.
- Server-side feature reviews stored under
  `049-design-doc-comments` are not ported. Their endpoints can be
  removed once the unified surface ships.

Both stores are scratchpad-shaped — they hold unsent drafts and
recently-sent reviews that have already been delivered to the agent as
prompts and are visible in chat history. Dropping them does not lose
information that the user couldn't already get from the chat record.
Skipping the migration keeps the rollout simple and avoids carrying two
data shapes during a transition window.

## Risks

- **Discoverability of the new flow.** Today the entry point to the
  richer panel is broken, so most users have only ever used the
  `localStorage` modal. The good news is that "click the file to leave
  comments" is exactly what the modal already does — the change makes
  more reach, not less, so existing muscle memory keeps working.
- **Loss of in-flight notes on rollout.** Because there's no migration,
  a user who happens to have an unsent draft in `localStorage` at
  rollout time loses it. Mitigation: a release note. The blast radius
  is small — drafts are short-lived by their nature.
- **Server load from drafts.** Empty-draft auto-cleanup mitigates this.
  Bounded comment count per draft (some sane cap) is reasonable and can
  be tuned.
- **Anchoring drift on code.** Acknowledged above; the fallback is to
  show the comment with an "outdated" badge rather than dropping it.
- **Backwards compatibility for `049`.** Once this ships, the feature
  review panel ceases to be its own entry point. The plan there should
  be updated to point to this doc as the successor.

## Out of scope

- Diff-anchored review comments (covered by the existing diff review
  panel).
- GitHub PR comment sync (covered by `102-github-pr-comment-sync`).
- Multi-user collaborative review.
- Threaded replies on comments (single-author, single-pass for now).
- Reviewing non-file artifacts (e.g., an agent message, a build log).
  The unified surface is file-anchored. Other artifact types would be
  a separate design.

## Relationship to existing docs

- **Supersedes the entry-point design in `049-design-doc-comments`.**
  The data model and AI Review concept from `049` survive in the
  unified surface; the standalone "feature review panel" UI does not.
- **Builds on `081-consolidate-file-preview`.** That doc collapsed
  multiple file viewers into one modal; this doc takes the next step
  and folds review behavior into the same modal so there isn't a
  second one beside it.
- **Compatible with `017-diff-review-panel`.** Diff review remains the
  surface for comments on a staged change; this doc is about the
  durable file surface.
