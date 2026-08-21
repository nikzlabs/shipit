---
issue: planning#311
title: Agent session rename
description: Let the agent keep a session's title current as it does more work, unless the user has renamed it.
---

# 250 — Agent session rename

Implements [`requirements.md`](./requirements.md). Read that first — the numbered requirements below are cited as `(req N)`.

## Problem

A session's title is written once and never revisited. `graduateSession` sets a placeholder from the first message, then `scheduleSessionNaming` replaces it with an AI-generated name derived from that same first message. After that the only writer is the user's sidebar rename. A session that goes on to ship three PRs keeps a title describing the first one, so the sidebar stops describing what the session is about (req 1).

## Design

### Title provenance — one nullable column

`SessionManager.rename` was a flat `UPDATE sessions SET title = ?` shared by the AI namer and the user's sidebar edit, so who set a title was unrecoverable after the fact. It now takes a source:

```ts
export type SessionTitleSource = "user" | "agent";
rename(id: string, title: string, source?: SessionTitleSource): SessionInfo | null
```

`sessions.title_source` is NULL for every automatic write — the graduation placeholder, the AI namer, and a title the session was *born* with (`explicitTitle`: from the seeding issue, or chosen by a parent agent spawning a child). NULL means replaceable, which is exactly req 7: those titles describe the starting task, and the starting task is what goes stale.

Two values, not four, because only two questions are ever asked of the column: *may the agent write?* (no iff `user`) and *may the AI namer write?* (no iff `user` or `agent`, req 8). A `placeholder`/`ai` distinction would be recorded and never read.

Precedence lives in one exported predicate, `isTitleLockedAgainst(session, source)` (`services/session-title.ts`), so the two automatic writers and the agent path can't drift apart.

### Where each writer sits

| Writer | Source recorded | Respects the lock |
|---|---|---|
| `graduateSession` placeholder | none (NULL) | no — runs before any turn, on a session that has never been renamed |
| `scheduleSessionNaming` (AI namer) | none (NULL) | **yes** — skips entirely when the title is `user` or `agent` (req 8) |
| `PATCH /api/sessions/:id` (sidebar) | `user` | n/a — the user always wins (req 4) |
| `POST /api/sessions/:id/rename` (agent) | `agent` | **yes** — refuses with 409 when the source is `user` |

The AI namer's guard re-reads the session immediately before writing rather than trusting the snapshot it captured at schedule time — the whole point is that a rename may have landed during the CLI call, which is a multi-second window (req 8). Nik's note on that requirement was that the window is rarely hit in practice, so this is a single re-read and an early return, not a lock or a queue.

### Renaming never touches the branch (req 10)

The AI namer renames the git branch alongside the title; the agent path deliberately does not, and there is no code path from `renameSessionByAgent` to `setBranch` or `renameBranch`. By the time the agent wants to rename, a PR usually exists on that branch, and moving it underneath would strand the PR. Guarded by a test asserting the git manager is never constructed on the rename path.

### Transcript card (req 9)

A rename is side-channel transcript content — it arrives over HTTP mid-turn, off the agent-event stream — so it goes through `emitChatCard`, exactly like the docs/239 self-merge-watch card. That one primitive emits live, records in-band anchored by `afterGroupIndex`, and persists, and it decides on `runner.running` whether the card rides the in-progress turn or is appended as final. Following `CLAUDE.md`'s recipe: `SessionRenamedCard` domain type → `WsSessionRenamedCard` → `messages.session_renamed` column → `PersistedMessage.sessionRenamed` + `toRow`/`fromRow` → `CARD_MESSAGE_FIELDS` → `TRANSCRIPT_SCOPED_MESSAGES` → client handler + `SessionRenamedCard.tsx`.

Note the two similarly-named messages are different things and both are needed: the pre-existing `session_renamed` WS/SSE event updates the *sidebar* entry, while the new `session_renamed_card` puts a row in the *transcript*.

Visual reference: [`mockup.html`](./mockup.html) — the card, plus the sidebar before/after it explains.

### The sidebar broadcast, including the pre-existing gap

`renameSessionByAgent` broadcasts `session_renamed` over SSE so every viewer's sidebar updates. The existing sidebar rename route did **not** broadcast at all — it returned the session and relied on the renaming client's own optimistic store update, so a second tab kept the old title until it reloaded. That was invisible while the only renamer was the user in the tab doing the renaming; an agent rename has no client to be optimistic, so the route now broadcasts too.

### When the agent renames (req 6)

Two moments, both attached to something the agent already does, rather than a standing per-turn judgement:

1. **On PR creation** — `prompts/pull-requests.md`, next to the existing "open a PR when you finish a turn that edited files" instruction. The agent is already writing a title and summary for the work at that moment.
2. **On continuing past a merged PR** — appended to `buildAgentPrefix` in `services/pre-turn-reset.ts`, the `[System]` prefix prepended to the turn's prompt when the docs/218 pre-turn reset moves a merged session's branch onto the updated base. This is the "user sends a message with auto-rebase" moment: the session is demonstrably starting a second round of work, which is precisely when the first round's title goes stale.

Both are instructions, not enforcement. Nothing fires a rename on the agent's behalf.

### Agent surface

`shipit session rename --title "<new title>" [--json]`, own-session only — `rename` comes off `REJECTED_SESSION_SUBCOMMANDS` (where it was marked "user-driven; not part of the agent's surface"), which `shipit session create --title` had already made a half-truth for child sessions. It takes no session id: the worker injects the container's own `SESSION_ID`, so an agent cannot rename anyone else's session (req 3), same shape as `notify-on-merge --self`.

Title length is capped at 60 characters — the same cap `generateSessionName` applies — and a longer one is **rejected**, not silently truncated, so the agent learns the constraint instead of shipping a cut-off name.

## Key files

- `src/server/shared/database.ts` — two migrations: `sessions.title_source`, `messages.session_renamed`.
- `src/server/orchestrator/sessions.ts` — `rename(id, title, source?)`, `title_source` row + `fromRow`.
- `src/server/shared/types/domain-types/session.ts` — `SessionTitleSource`, `SessionInfo.titleSource`.
- `src/server/shared/types/domain-types/chat.ts` — `SessionRenamedCard`.
- `src/server/shared/types/ws-server-messages/cards.ts` — `WsSessionRenamedCard`.
- `src/server/orchestrator/services/session-title.ts` — `isTitleLockedAgainst`, `renameSessionByAgent`.
- `src/server/orchestrator/services/graduate-session.ts` — AI namer respects the lock.
- `src/server/orchestrator/services/pre-turn-reset.ts` — merged-continue prompt prefix.
- `src/server/orchestrator/api-routes-session-crud.ts` — `POST /rename` (container-accessible); sidebar `PATCH` now broadcasts.
- `src/server/session/agent-ops-routes.ts` + `agent-shim/shipit-session.ts` + `agent-shim/shipit.ts` — the `shipit session rename` surface.
- `src/server/orchestrator/prompts/pull-requests.md` — the PR-creation trigger.
- `src/server/shipit-docs/sessions.md` — agent-facing docs.
- `src/client/components/SessionRenamedCard.tsx` + `hooks/message-handlers/session-renamed-card.ts` — the transcript card.
