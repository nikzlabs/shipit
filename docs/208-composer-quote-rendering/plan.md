---
issue: https://linear.app/shipit-ai/issue/SHI-155
title: Composer quote rendering
description: Should quoted content in the message composer get richer rendering than plain text? Recommendation and rationale.
---

# Composer quote rendering

**Status: design investigation. Nothing implemented — this is a recommendation.**

When content is quoted **into the main message composer**, today it lands as
plain markdown `> ` lines inside the `<textarea>` with no special visual
treatment. This doc investigates whether quoted content should get a richer
rendering (styled blockquote, removable reply chip, hybrid) and makes a call.

It spun out of the action-checklist-cards work (**SHI-153**,
`docs/207-action-checklist-cards/plan.md`): one affordance there, "Add
comment…", seeds the composer with a quoted snapshot of the card's `[x]`/`[ ]`
lines that the user then annotates and sends. But the concern is
**composer-wide** — chat quote-reply (`docs/167`), doc-selection-comment
replies, and the action-card snapshot would all share whatever we decide.

**Visual reference:** [`mockup.html`](./mockup.html) — recommended treatment
plus the two rejected alternatives, side by side, dark mode.

## TL;DR — the recommendation

**Keep the composer a plain-text `<textarea>`. Do not move to a
contentEditable / rich editor, and do not move the quote out of the editable
text into a non-editable chip.** The quote stays as editable markdown `> `
lines — exactly what is sent to the agent.

Ship **one** low-risk, decoration-only enhancement: a subtle left-rail accent
on contiguous `> ` lines, painted by a mirrored backdrop *behind* the textarea
so the text model is untouched. Treat it as optional polish gated on a
feasibility spike; if the spike is fragile, **status quo plain text is an
acceptable final answer** and we lose nothing the feature needs.

**What the action-cards feature should assume: plain editable text.** That is
the most robust substrate for trim / annotate / voice-append / persistence, and
it requires nothing from this doc to ship.

The two richer options are rejected as defaults (details below): a rich editor
is disproportionate cost and endangers the textarea's many integrations; a
"quote lives in a removable chip outside the editable text" banner **breaks the
action-card editability requirement** and introduces a second source of truth.

## 1. How quoting works today

The composer (`MessageInput.tsx`) is a single `<textarea>` whose `value` is a
plain `text` string in component state. Quoted content reaches it through two
transient `session-store` channels, both consumed by `useEffect` subscriptions:

| Channel | Intent | Producer | Behaviour |
|---|---|---|---|
| `prefillText` | **replace** the draft | docs "Start Session", services "Send to Agent" | `setText(prefill)` |
| `quoteReplyText` | **append** to the draft | `ChatQuoteReply.tsx` (chat selection → Reply) | append blockquote + blank line, cursor at end |

The quote itself is produced by `utils/format-blockquote.ts`
(`formatBlockquote`): trim, normalise CRLF, prefix every line with `> `, keep
blank interior lines as bare `>` so it stays one contiguous markdown
blockquote. The doc-selection flow (`MarkdownSelectionComments.tsx`) is a
sibling producer that builds its own prompt and feeds the composer the same way.

**There is no structured/decorated representation.** Once inserted, a quote is
indistinguishable from anything else the user typed — it is literal `> …` text
in the textarea. This matters because everything downstream is built on "the
composer holds a plain string":

- **What gets sent** — `handleSubmit` ships `SendPayload.text = text.trim()`.
  The agent receives the literal `> …` lines verbatim. WYSIWYG: the user sees
  exactly what the agent gets.
- **Voice dictation** — `spliceTranscript` inserts at `selectionStart/End` of
  the live textarea. Pure string + cursor math.
- **`@` file and `/` skill autocomplete** — regexes run against `text` /
  `textBeforeCursor`.
- **Draft persistence** — `saveDraftMessage(focusKey, text)` writes the string
  to `localStorage` on every keystroke; reload and session-switch restore it.
  A half-composed message (quote + partial reply) survives for free.
- **Multi-quote stacking** — already works: `quoteReplyText` *appends*, so a
  second Reply lands below the first. No special handling.

The plain-text substrate is doing a lot of quiet work. Any richer rendering has
to either preserve all of it or pay to re-implement it.

## 2. The options and trade-offs

### A. Plain text (status quo)
`> …` lines live in the textarea, no decoration.

- **+** Zero cost; all integrations above work unchanged; perfect send-fidelity;
  trivially editable, voice-appendable, persistable, stackable.
- **−** `> ` lines are visually noisy and don't *read* as "quoted" at a glance;
  a long pasted snapshot can dominate the box. Discoverability of "this is a
  quote you can trim" is low.

### B. Styled blockquote rendered in-place
The quote renders as a real blockquote (left bar, muted text) inside the input,
while staying editable.

- **+** Best-looking; the quote is unmistakable and still editable in place.
- **−** Requires **contentEditable / a rich editor** (Lexical, ProseMirror,
  TipTap). That is a large dependency and a rewrite of the composer's core. It
  puts at risk, and forces re-implementation of: IME composition, paste
  sanitisation, the `@`/`/` autocomplete cursor logic, the voice-splice cursor
  math, draft serialization (no longer a plain string), accessibility of a
  custom editable, and the send-payload extraction (rich tree → markdown). High
  blast radius for a quote bar. See §3.

### C. Removable "reply context" chip/banner above the textarea
The quote is held as **structured state**, rendered as a styled blockquote chip
*above* the textarea (with an ✕ to remove), and **not** present in the editable
text. On send it's serialized back into a `> ` blockquote prepended to the
typed reply.

- **+** Declutters the textarea; removal is one obvious click; matches the
  familiar iMessage / Slack / email reply-banner pattern; the typed reply and
  the quoted context are visually separate.
- **−** **Breaks the action-card requirement that the user edit the quote.**
  The action-card snapshot *is* the thing the user trims and annotates inline
  (`[x]`/`[ ]` lines) — a non-editable chip can't do that. Introduces a
  **second source of truth** (chip state + textarea text) and a serialization
  step, so "what gets sent" is no longer literally "what's in the box." Voice
  dictation only ever targets the textarea, never the chip. Reload/persistence
  now needs to round-trip structured chip state, not just a string.

  Chip semantics fit *reply-to-reference* flows (quote a passage you won't edit,
  then reply below) but are wrong for *seed-and-annotate* flows.

### D. Hybrid — plain editable text + a derived, decoration-only indicator
Keep the quote as editable `> ` text in the textarea (so A's whole win-column
holds), and add a **non-editable visual layer that does not own the text**:

- **D1 (recommended):** a mirrored backdrop *behind* the transparent textarea
  paints a left-rail accent on contiguous `> ` lines. Pure decoration — the
  textarea remains the single source of truth, every integration is untouched,
  and the quote reads as a quote. Known technique (cf.
  `react-highlight-within-textarea`); the cost is the finicky bit: the backdrop
  must match font, line-height, padding and wrapping exactly and sync scroll,
  which interacts with `field-sizing: content` and the `max-h-[40vh]` scroll.
- **D2:** a small derived banner ("Quoted 4 items") above the box. Rejected:
  once the user edits the quote, the banner can't reliably track the quote's
  boundary to offer a correct "Remove", so it's a lie waiting to happen.

## 3. Does this need a rich editor? (the contentEditable question)

Only option B requires it. The honest cost accounting:

- The `<textarea>` is **load-bearing simple**. Six independent features
  (send, voice, `@`, `/`, drafts, multi-quote) lean on "value is a string with
  a cursor." A rich editor replaces that with a document model and forces each
  one to be re-derived.
- IME (CJK composition), paste normalisation, and a11y of a custom editable are
  exactly the areas where rich editors leak; we'd be buying a long tail of
  edge-case bugs.
- The dependency policy (exact pin, 7-day minimum age) plus the bundle and
  maintenance cost of a ProseMirror/Lexical-class editor is a real, recurring
  tax.

For the payoff — making a quote *look* like a quote — this is wildly
disproportionate. **Reject B.** D1 buys ~80% of B's visual benefit with none of
the model change.

## 4. Recommendation & rationale

1. **Composer stays a plain `<textarea>`. Reject the rich editor (B).** Cost vs.
   benefit is upside-down, and it endangers six working integrations.
2. **Quote stays as editable plain `> ` text. Reject the quote-as-chip default
   (C).** It breaks the action-card editability requirement, adds a second
   source of truth, and erodes send-fidelity. (C remains a reasonable *future*
   enhancement scoped **only** to pure reply-reference flows — chat quote-reply,
   doc replies — where the quote is genuinely never edited; it should not be
   coupled to this investigation or block action-cards.)
3. **Optionally ship D1** — the decoration-only left-rail highlight — behind a
   short feasibility spike. If the mirrored-backdrop proves robust against
   `field-sizing` + scroll, it's a cheap, pure-CSS-ish win. If it's fragile,
   **stop and keep status quo plain text** — the `> ` convention is already
   legible to anyone who's used markdown or email, and nothing the feature needs
   is lost.
4. **Guidance for action-cards (SHI-153): assume plain editable text.** The
   "Add comment…" snapshot should be inserted exactly as it is today — markdown
   text the user freely trims and annotates. Do **not** build the action-card on
   a chip or rich-editor representation; the plainest substrate is also the most
   robust one for that flow.

This is the CLAUDE.md §5 / "keep it simple" answer: the composer is the input
surface, and the cheapest representation that the agent receives verbatim is the
right one. We improve *legibility* without taking on an editor.

## Key files (touched only if D1 is built)

- `src/client/components/MessageInput.tsx` — the composer; would gain the
  mirrored-backdrop layer behind the existing `<textarea>`.
- `src/client/utils/format-blockquote.ts` — quote formatter (unchanged).
- `src/client/components/ChatQuoteReply.tsx`,
  `MarkdownSelectionComments.tsx` — quote producers (unchanged).
- `src/client/stores/session-store.ts` — `prefillText` / `quoteReplyText`
  channels (unchanged).

## Related

- `docs/167-chat-quote-reply/plan.md` — the existing quote-reply producer.
- `docs/207-action-checklist-cards/plan.md` (SHI-153) — the action-card flow
  whose "Add comment…" affordance motivated this investigation.
