# Checklist — conditional history revalidation

- [x] `requirements.md` written from `planning#324`'s text, both "correct today" behaviours and the validator subtlety preserved as numbered requirements
- [x] `plan.md` — the revision counter, the conditional route, the client no-clobber rule
- [x] Migration: `session_history_revision` table + `clearAll()` wipe
- [x] `ChatHistoryManager.getHistoryRevision` / `bumpHistoryRevision` (atomic with each write)
- [x] Bump on every mutating path: appends, in-place card patches, `saveMessages`/`replaceInProgress`/`finalize`/`clear`/`truncate`/`delete` rewrites (req 4)
- [x] `GET /history`: 304 requires the transcript revision AND the body-hash ETag; `x-history-revision` served on 200 and 304
- [x] Client: cache carries the revision; `X-History-Revision` sent on warm refetch
- [x] Client: a validated-unchanged 304 never replaces a live transcript; an empty transcript still materializes from the cache (req 5)
- [x] Tests: `chat-history.test.ts` write-path revision guards (incl. the in-place patch trap)
- [x] Tests: `http-phase3.test.ts` conditional contract incl. the same-content rewrite
- [x] Tests: `session-data.test.ts` validator send + no-clobber
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev` green
- [x] Exactly one PR, `Refs planning#324` (benchmark rules: no tracker writes, no reviewer run)