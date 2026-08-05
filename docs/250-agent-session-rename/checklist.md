# 250 — Agent session rename: checklist

- [x] `requirements.md` written from Nik's ask; five open questions batched and answered on review
- [x] `sessions.title_source` migration + `SessionTitleSource` / `SessionInfo.titleSource` + `rename(id, title, source?)`
- [x] `isTitleLockedAgainst` — the single precedence predicate (reqs 4, 7, 8)
- [x] `renameSessionByAgent` service: validation, 409 on a user-set title, no branch write (req 10)
- [x] `POST /api/sessions/:id/rename`, container-accessible; golden route-table entry updated
- [x] Sidebar `PATCH /api/sessions/:id` records `user` **and** now broadcasts (it never did)
- [x] AI namer skips the title write when locked, keeps renaming the branch (req 8)
- [x] `messages.session_renamed` column + `SessionRenamedCard` + `WsSessionRenamedCard` through `emitChatCard` (req 9)
- [x] Client: handler, `CARD_MESSAGE_FIELDS`, `TRANSCRIPT_SCOPED_MESSAGES`, `SessionRenamedCard.tsx`, `MessageCards.tsx`
- [x] `shipit session rename --title` shim + worker relay; `rename` removed from the rejected list
- [x] Prompts: `pull-requests.md` (PR-creation trigger) and `buildAgentPrefix` (merged-continue trigger) — req 6
- [x] `shipit-docs/sessions.md` updated for the agent
- [x] Tests: service, graduation-namer race, shim, worker relay, HTTP integration, client handler, card component, history round-trip
- [x] `npm run typecheck`, `npm run lint:dev`, full `npm test` (650 files, 9290 tests) green
- [ ] Independent fresh-context review against the numbered requirements (Codex, in flight)
