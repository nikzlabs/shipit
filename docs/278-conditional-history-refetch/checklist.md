# Checklist — conditional history refetch

- [x] `requirements.md` from planning#324's own words; benchmark assumptions recorded under Resolved questions
- [x] Migration: `history_revisions` table + AFTER INSERT/UPDATE/DELETE triggers on `messages`
- [x] `clearAll()` clears `history_revisions` after the messages delete
- [x] `ChatHistoryManager.revision(sessionId)` accessor
- [x] `composedEtag(revision, remainder)` in `http-etag.ts`
- [x] `/history` route: revision read first, `rest` hashed, 304 answered without reading message rows
- [x] Unit tests: every mutation path moves the revision; in-place patches leave `MAX(id)`/`COUNT(*)` still; raw-SQL bypass covered; no ABA; reads don't move it
- [x] Integration tests: 304 unchanged, 200 on append / in-place patch / non-transcript change, 304 without `load()`
- [x] `composedEtag` unit tests
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev` green
