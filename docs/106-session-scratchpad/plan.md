---
description: Persistent, agent-readable notes file (.shipit/notes.md) scoped to each session, surfaced as a side panel and auto-attached to every agent turn.
---

# 106 — Per-Session Scratchpad

## Summary

A persistent, agent-readable, human-editable note file scoped to each session, surfaced as a side panel and stored at `.shipit/notes.md` in the workspace. The agent can read it as context (it's auto-attached to every turn) and write to it via a `note_write` tool. Inspired by Conductor v0.27.0 (workspace scratchpad) and v0.28.1 (`.context` folder).

## Motivation

ShipIt currently has no structured place for:

- The user to leave persistent context that doesn't belong in `CLAUDE.md` (which is repo-wide and committed).
- The agent to remember decisions across turns without polluting the chat.
- A handoff artifact that survives session forks ([fork session](../103-diff-mark-files-viewed/plan.md) loses ad-hoc notes).

Today users either re-paste context every turn, edit `CLAUDE.md` (committing scratch into the repo), or accept context decay. Scratchpad fixes all three.

## Design

### Storage

- File: `.shipit/notes.md` inside the workspace.
- Gitignored by default — the `.shipit/` directory is for session-local state, not committed. (Add `.shipit/notes.md` to `.gitignore` automatically on first write if not already there.)
- Plain markdown so it's diff-friendly and human-editable in any editor.

### Surface in the UI

- New right-rail panel "Notes" (collapsible, persistent across reloads). Toggle: `⌘K N`.
- Markdown textarea with live preview tab (Tiptap, already in tree, or a lightweight MD renderer).
- Word count / token count footer.
- Auto-save 500ms after edit stops. Save flushes through the file watcher so the agent sees changes.

### Surface to the agent

Two modes:

1. **Always-attached** (default): the file's contents are prepended to the user's first message of each turn as a system note: `<session-notes>\n{contents}\n</session-notes>`. Implemented in `agent-instructions.ts`.
2. **On-demand**: the agent has a `note_read` and `note_append` MCP-style tool (or a simple CLI tool exposed by the session worker). For very long notes, attach-on-every-turn would burn context — `note_read` is preferred above ~2000 tokens.

A toggle in the Notes panel chooses the mode. Default to always-attached when the file is small (<2k tokens), switch to on-demand and show a banner when it exceeds the threshold.

### `note_append` tool

Defined in `src/server/session/agents/tool-map.ts` and surfaced via the session worker's HTTP API:

- `POST /notes/append { text }` — appends a timestamped block to `.shipit/notes.md`.
- `GET /notes` — returns full contents.

Each appended block is fenced:

```md
<!-- agent · 2026-04-30T14:22:11Z -->
Decided to use Zod for runtime validation because [...]
<!-- /agent -->
```

This keeps agent-authored sections distinct from human notes and lets the panel render them with a different background.

### Forking

When a session is forked ([existing RollbackDropdown / RewindDropdown](../099-auto-pr-on-meaningful-turn/plan.md) flows), copy `.shipit/notes.md` to the new session's worktree. The fork inherits the scratchpad — that's the value over throwaway chat messages.

## Server pieces

- New service: `src/server/orchestrator/services/notes.ts`:
  - `getNotes(sessionId)` — read `.shipit/notes.md` from the session container via worker HTTP.
  - `setNotes(sessionId, content)` — full write.
  - `appendNote(sessionId, text)` — atomic append with timestamp.
- New session-worker endpoints in `src/server/session/session-worker.ts`:
  - `GET /notes`, `PUT /notes`, `POST /notes/append`.
- WS broadcast `notes_update { sessionId, content }` so multi-tab edits stay in sync.
- `agent-instructions.ts`: include notes in the per-turn system note when `notesAttachMode === 'always'`.

## Client pieces

- New component: `src/client/components/NotesPanel.tsx`.
- New store slice in `session-store.ts`: `sessionNotes: Record<sessionId, { content, mode, dirty }>`.
- New hook: `useNotesAutoSave` (debounced PUT + WS sync conflict handling).

## Tests

`integration_tests/notes.test.ts`:

1. PUT notes → file written → `notes_update` broadcast → second tab receives.
2. Append from agent tool → file appended with timestamp fence.
3. Always-attached mode → next turn's prompt includes `<session-notes>` block (assert via FakeClaude prompt capture).
4. Fork session → child session has identical `.shipit/notes.md`.
5. Notes file > 2k tokens → mode auto-switches to on-demand, banner shown.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/services/notes.ts` | New service |
| `src/server/session/session-worker.ts` | New `/notes` endpoints |
| `src/server/session/agents/tool-map.ts` | Add `note_read` / `note_append` |
| `src/server/orchestrator/agent-instructions.ts` | Inject notes in system prompt when always-attached |
| `src/server/orchestrator/api-routes-session.ts` | `/api/sessions/:id/notes` GET/PUT/POST routes |
| `src/shared/types/ws-server-messages.ts` | `notes_update` |
| `src/client/components/NotesPanel.tsx` | New panel |
| `src/client/hooks/useNotesAutoSave.ts` | New hook |
| `src/client/stores/session-store.ts` | `sessionNotes` slice |

## Future extensions

- **Templates** — boilerplate scratchpad for "design doc," "bug investigation," "architecture decision record."
- **Pin to TOC** — surface notes as the first entry in the chat [TOC](../104-chat-toc-and-summaries/plan.md).
- **Cross-session notes** — repo-level notes that span sessions, stored in repo metadata.
