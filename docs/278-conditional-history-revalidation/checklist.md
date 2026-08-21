# Checklist — conditional chat-history revalidation

- [ ] Migration: `session_transcript_revisions` table + `clearAll()` coverage
- [ ] `ChatHistoryManager`: counter statements, `bumpRevision`, `transcriptRevision`
- [ ] Bumps in every `messages`-table write path (appends, in-place card patches, rewrites)
- [ ] `/history` route: validator assembly, 304 before loading messages, wire-shape version constant
- [ ] Enumeration test: every mutating method moves the counter; no-ops don't
- [ ] Integration tests: 304 without load, in-place patch invalidates, rewrite invalidates, cross-session isolation
- [ ] `npm run typecheck` + `npm run lint:dev` clean
- [ ] `npm run test:dev` + new tests green
