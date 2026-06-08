---
description: Collapsible table-of-contents pane with auto-generated one-line summaries per turn so users can jump between turns in long sessions.
---

# 104 — Chat Table of Contents & Turn Summaries

## Summary

Add a table-of-contents pane that lets users jump between turns in long sessions, plus auto-generated one-line summaries per turn. Builds on the existing `useSearch.ts` hook (⌘F is already implemented). Conductor shipped this in v0.32.0 / v0.34.2 / v0.39.0 and it transformed long sessions from a wall-of-text into a navigable artifact.

## Motivation

ShipIt sessions can run hundreds of turns. The existing message list is a single scrollable column with no anchor navigation. After 30 turns, finding "the turn where Claude added the auth middleware" requires either remembering it visually or using ⌘F with a guessed keyword. Conductor's table-of-contents (a collapsible pane showing one bullet per turn, hyperlinked to the message) removed that pain.

We already generate turn summaries — `runner.turnSummary` is set during `claude-execution.ts` and used as the auto-commit message. Reusing those gives us TOC entries for free.

## Design

### TOC pane

- Right-side collapsible pane in `MessageList.tsx`, toggled by a button in the chat header (`⌘K T` shortcut).
- Each entry: `[turn N] {summary} · {timestamp}` with a small icon for "had file changes" / "user question" / "errored."
- Click → smooth-scroll the message list to the corresponding turn. Active turn highlights as the user scrolls (intersection observer).
- Hover an entry to see a 2-line preview popover (first 200 chars of the turn's last assistant message).

### Where summaries come from

Three sources, in priority order:

1. **`runner.turnSummary`** — already populated post-turn (`claude-execution.ts`, `post-turn.ts`). This is the same string used as the auto-commit message. Authoritative for completed turns.
2. **First user message** — fallback for question-only turns where no summary was generated.
3. **"Working…"** — placeholder while a turn is in progress.

### Persistence

Turn summaries are already in the chat-history JSON written by `ChatHistoryManager`. We extend the existing `MessageGroup` type with an optional `summary?: string` so reloads have it without recomputing.

### Insta-summarize for old sessions

Sessions created before this feature won't have summaries on existing turns. Add a one-shot batch summarizer in `services/chat-summary.ts` that walks chat history and asks a small/fast model (Haiku) to produce one-liners. Triggered lazily on first TOC open per session and cached.

### Search integration

The existing `useSearch.ts` already case-insensitively scans messages. Extend it to also match against summaries — a search for "auth middleware" should hit the summary even if the wording differs from the body. Highlight matched TOC entries with a yellow accent the same way matched messages are.

## Server pieces

- Extend `MessageGroup` (`src/shared/types/agent-types.ts`) with `summary?: string`.
- `services/chat-summary.ts`:
  - `summarizeMissing(sessionId)` — finds groups with no summary and fills them via a Haiku call.
  - Rate-limited (max 20 turns per call; further calls require user action) so the lazy fill on a 500-turn session doesn't burn through tokens.
- Reuse the existing `session-namer.ts` Anthropic client wiring rather than introducing a new one.

## Client pieces

- New component: `src/client/components/ChatTableOfContents.tsx`.
- New hook: `src/client/hooks/useTurnSummaries.ts` — returns `Map<groupId, summary>`, triggers `summarizeMissing` on mount if any are missing.
- `MessageList.tsx`: assigns `data-turn-id` to each group root for scroll-into-view targeting; intersection observer reports the active turn.
- New keyboard shortcut: `⌘K T` toggles TOC.

## Tests

`integration_tests/chat-toc.test.ts`:

1. Session with N completed turns → GET /chat-history returns summaries on each group.
2. Reload after server restart → summaries persist.
3. Session created before feature → opening TOC triggers `summarizeMissing`, fills via stubbed Anthropic client.
4. Search for a string only present in a summary → TOC entry is highlighted, message body match also highlighted if applicable.

Component test for `ChatTableOfContents.tsx` covering rendering, click-to-scroll, and active-entry highlighting.

## Key files

| File | Change |
|---|---|
| `src/shared/types/agent-types.ts` | Add `summary?: string` to `MessageGroup` |
| `src/server/orchestrator/services/chat-summary.ts` | New — batch summarizer using Haiku |
| `src/server/orchestrator/chat-history.ts` | Persist summaries; lazy-fill API |
| `src/server/orchestrator/api-routes-session.ts` | `POST /api/sessions/:id/summaries/fill` |
| `src/client/components/ChatTableOfContents.tsx` | New TOC pane |
| `src/client/hooks/useTurnSummaries.ts` | New hook |
| `src/client/hooks/useSearch.ts` | Extend to search summaries |
| `src/client/components/MessageList.tsx` | TOC toggle, data-turn-id anchors |

## Future extensions

- **Section dividers** — let the user manually insert a "Phase 1: scaffold" header between turns to chunk a session.
- **Filter** — show only turns with file changes / errors / questions.
- **Export** — generate a markdown summary of an entire session from its TOC, useful for handoffs.
