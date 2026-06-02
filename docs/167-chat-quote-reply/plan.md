---
description: Highlight text in a chat message to quote it as a blockquote into the composer (SHI-10).
---

# Chat quote-reply (SHI-10)

When a user highlights/selects text inside a chat message bubble, show a small
floating **Reply** button near the selection. Clicking it inserts the selected
passage as a markdown blockquote into the chat composer, followed by a blank
line so the user can immediately type their reply to that specific passage.

Linear: **SHI-10**.

## Why

The conversation often contains a specific claim, plan step, or code reference
the user wants to push back on or expand. Re-typing or paraphrasing the passage
is friction; quoting it inline (as the user would in email/GitHub) makes the
reply unambiguous to the agent. This keeps the whole interaction inside the
chat surface (CLAUDE.md §1) — no copy-paste round-trip.

## UX

- Select text inside a message bubble → a `Reply` pill appears just above the
  selection (falls back to below when there isn't room above), with a quotes
  icon.
- Click it → the passage is appended to the composer as a blockquote:

  ```
  > the selected passage
  >
  > (blank interior lines preserved as bare `>`)

  ```

  …with the cursor placed on the trailing blank line, the composer focused, and
  the native selection cleared (so the button disappears).
- The button only appears for selections **inside the conversation/message-list
  scroll container** — never the composer, design-doc viewer, or other panels.
- If the composer already has a draft, the quote is **appended** (separated by a
  blank line), not replaced — distinct from the `prefillText` channel which
  replaces the whole draft.

## Design / mechanics

Producer → relay → consumer, mirroring the existing `prefillText` pattern:

1. **Producer** — `ChatQuoteReply.tsx` (rendered inside `MessageList`'s scroll
   container, handed its `containerRef`). Listens to `document`'s
   `selectionchange`, and when the live selection is non-collapsed, non-empty,
   and `containerRef.current.contains(range.commonAncestorContainer)`, captures
   a snapshot (`{ rect, text }`) and renders a `position: fixed` button anchored
   to the selection's bounding rect. On press (`onMouseDown` + `preventDefault`
   so the selection isn't collapsed before the handler reads it) it formats the
   blockquote and writes it to the store.
2. **Relay** — `session-store.quoteReplyText` (+ `setQuoteReplyText`). A
   transient, append-intent channel separate from `prefillText`. Part of
   `initialResettableState` so it clears on session switch.
3. **Consumer** — `MessageInput.tsx` subscribes (same shape as the prefill
   effect, skipped for the `overlay` surface) and, on a defined value, clears
   the field and **appends** the blockquote to its local `text` state, then
   focuses the textarea and drops the cursor at the end.

Blockquote formatting lives in `utils/format-blockquote.ts` (`formatBlockquote`)
so it's unit-testable in isolation: trims surrounding whitespace, normalises
CRLF, prefixes each line with `> `, and keeps blank interior lines as a bare `>`
so the quote stays a single contiguous blockquote.

### Why a separate component from `MarkdownSelectionComments`

`MarkdownSelectionComments` anchors **persistent** review comments to a doc and
lives in the file-preview modal. Quote-reply is a **transient**, fire-and-forget
action for live chat with a different lifecycle. The shared mechanics
(selectionchange listener + floating-button positioning) are intentionally
reimplemented rather than abstracted — a shared base would be thin and leaky.

## Key files

- `src/client/components/ChatQuoteReply.tsx` — the floating Reply button (new).
- `src/client/components/ChatQuoteReply.test.tsx` — component test (new).
- `src/client/utils/format-blockquote.ts` — blockquote formatter (new).
- `src/client/utils/format-blockquote.test.ts` — formatter unit test (new).
- `src/client/components/MessageList.tsx` — mounts `ChatQuoteReply` with the
  scroll `containerRef`.
- `src/client/components/MessageInput.tsx` — consumes `quoteReplyText`, appends
  to the draft.
- `src/client/stores/session-store.ts` — `quoteReplyText` + `setQuoteReplyText`.

## Tests

- `format-blockquote.test.ts` — single/multi-line, blank interior lines, CRLF,
  trimming, whitespace-only → empty.
- `ChatQuoteReply.test.tsx` — button shows on in-list selection; hidden for
  out-of-list selection and when the selection collapses; click sets the store
  blockquote and clears the native selection; end-to-end click inserts the
  blockquote into the real composer and appends rather than replaces an existing
  draft.
