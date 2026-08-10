---
issue: planning#346
title: Send-review dialog with a free-text note — design
description: How the confirmation dialog, the note field, and the note's place in the review prompt are built.
---

# 260 — Send-review dialog: design

Implements [`requirements.md`](./requirements.md). The interactive prototype is [`mockup.html`](./mockup.html).

## Shape

Sending a review becomes two steps: **Send comments** opens a dialog, and the dialog sends. The dialog carries one optional free-text note (req 4, 5). The note travels with the review to the server, becomes the first piece of feedback in the constructed prompt (req 6), and is stored on the review row so **Past reviews** can show it again (req 7).

Nothing else about the review flow changes. Drafts, anchoring, the composing guard, and the send-empties-the-draft behaviour stay as they are.

## Where the note goes in the prompt (req 6)

`buildReviewPrompt` takes an optional `note` and emits it after the lead-in line and before the first anchored comment, in both the markdown and the code builder:

```
I've reviewed docs/241-spec-discipline/plan.md and have the following feedback:

<note>

> Every new feature in this repo gets a…

Say what counts as a feature — …

Please read docs/241-spec-discipline/plan.md, address each piece of feedback by updating the file, and explain what you changed.
```

The note gets no label. It is the user's own words in the user's own message, and a label would be text they did not write. The closing instruction stays the last line, which is why the note goes at the top rather than the bottom — see the resolved question in `requirements.md`.

The orphaned-comment section (markdown) and the snippet blocks (code) are untouched.

## Server

**Type** (`shared/types/domain-types/review.ts`) — `FileReview` gets `note?: string`. Absent on a draft, set when the review is sent. Optional, so every existing persisted review stays valid.

**Schema** (`shared/database.ts`) — a new migration adds `note TEXT` to `file_reviews`. Additive, no backfill: reviews sent before this feature have no note, and the UI shows nothing for them.

**Store** (`orchestrator/review-store.ts`) — `markSent(reviewId, note?)` writes the trimmed note beside `sent_at`; `toRow`/`fromRow` carry the column. An empty or whitespace-only note is stored as `NULL`, so "sent without a note" has one representation, not two.

**Service** (`orchestrator/services/reviews.ts`) — `sendReview(..., note?)` trims, passes the note to `buildReviewPrompt`, and hands it to `markSent`. A note longer than 4000 characters is a `ServiceError(400)`: the field is for context, not for pasting a file, and an unbounded field on a prompt path is worth a ceiling.

**Route** (`orchestrator/api-routes-reviews.ts`) — `POST /api/sessions/:id/file-reviews/:reviewId/send` accepts an optional `{ note?: string }` body. The body stays optional, so an old client that sends none still works.

## Client

**`SendReviewDialog.tsx`** (new, `components/`) — the shared dialog, built on the existing `ui/dialog` primitives so it inherits Esc, backdrop, and Back-button dismissal. Props: `open`, `onOpenChange`, `commentCount`, `target` (a rendered description — a file path, or "3 files"), `note`, `onNoteChange`, `onSend`. It renders the count and target, the labelled textarea, the hint, and Cancel / Send. ⌘⏎ (Ctrl+⏎) inside the textarea sends. It is presentational: the note lives in the caller's state (req 10), so cancelling and reopening restores what was typed and an accidental unmount cannot drop it.

**`use-file-review-controls.ts`** — `handleSend` no longer sends. It opens the dialog. The hook gains `sendDialogOpen`, `note`, `setNote`, `closeSendDialog`, and `confirmSend()`, which is the old `handleSend` body plus the note. The `composing` guard still blocks the button, so the dialog cannot open over a half-typed comment.

**`file-review-store.ts`** — `sendDraft(sessionId, filePath, note?)` puts the note in the send request body. The returned `SentDraftPayload` is unchanged; the note is already in the prompt, and the sent review carries it into history.

**`FileReviewFooter.tsx`** — renders the dialog (covering both the file-viewer dialog and the Present tab, which share this footer), and `PastReviews` shows `review.note` above the comment list of a past review when present (req 7).

**`DiffPanel.tsx`** — same dialog, same note state. Its prompt is built client-side, so the note is inserted after its `"I have the following comments on the code:"` lead-in. The diff panel has no past-reviews surface, so req 7 does not apply there; the note only travels in the message.

## What this deliberately does not do

- No comment list in the dialog and no per-comment removal (`requirements.md` → Later versions).
- No keyboard bypass of the dialog (req 8). ⌘⏎ sends from *inside* the dialog only.
- No note on a draft. The note is composed at send time and stored with the sent review; it is not a persisted draft field that survives a cancel across a page reload.

## Key files

| File | Change |
|---|---|
| `src/server/shared/types/domain-types/review.ts` | `note?: string` on `FileReview` |
| `src/server/shared/database.ts` | migration: `file_reviews.note` |
| `src/server/orchestrator/review-store.ts` | `markSent(id, note?)`, row mapping |
| `src/server/orchestrator/services/reviews.ts` | `sendReview` note, `buildReviewPrompt` note placement, length cap |
| `src/server/orchestrator/api-routes-reviews.ts` | optional `{ note }` body on send |
| `src/client/components/SendReviewDialog.tsx` | new shared dialog |
| `src/client/hooks/use-file-review-controls.ts` | open-dialog / confirm-send split, note state |
| `src/client/stores/file-review-store.ts` | note in the send request |
| `src/client/components/FileContentView/FileReviewFooter.tsx` | render dialog, show past note |
| `src/client/components/DiffPanel.tsx` | render dialog, note in the client-built prompt |

## Tests

- `services/reviews.test.ts` — the note lands after the lead-in and before the first comment, in both builders; no note leaves the prompt byte-identical to today; an over-long note is rejected.
- `review-store.test.ts` — note round-trips through `markSent`; whitespace-only becomes `null`.
- `integration_tests/doc-reviews.test.ts` — send with a note returns the note in the review and in the prompt; send without a body still works.
- `SendReviewDialog.test.tsx` — count and target render; Send fires with the typed note; Cancel does not send.
- `use-file-review-controls.test.ts` — Send opens the dialog instead of sending; `confirmSend` sends once with the note; `composing` still blocks.
- `file-review-store.test.ts` — the note reaches the request body.
