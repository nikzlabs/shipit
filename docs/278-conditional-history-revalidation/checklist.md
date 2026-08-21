# Checklist — conditional chat-history revalidation

- [x] Migration: `session_transcript_revisions` table + `clearAll()` coverage
- [x] `ChatHistoryManager`: counter statements, `bumpRevision`, `transcriptRevision`
- [x] Bumps in every `messages`-table write path (appends, in-place card patches, rewrites)
- [x] `/history` route: validator assembly, 304 before loading messages, wire-shape version constant
- [x] Enumeration test: every mutating method moves the counter; no-ops don't
- [x] Integration tests: 304 without load, in-place patch invalidates, rewrite invalidates, cross-session isolation
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [x] `npm run test:dev` + new tests green
