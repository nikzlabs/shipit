# Checklist — conditional history refetch

- [x] `requirements.md` from the issue's words; the two design choices recorded as dated
      benchmark assumptions under `## Resolved questions`
- [x] `plan.md` — why compose rather than replace, why triggers rather than a TypeScript bump
- [x] Migration: `transcript_revisions` + `AFTER INSERT / UPDATE / DELETE` triggers on `messages`
- [x] `clearAll` empties the table after the messages delete, not before (req 7)
- [x] `ChatHistoryManager.transcriptRevision(sessionId)`
- [x] `GET /history` composes the validator and answers `304` before reading the transcript (req 2)
- [x] `HISTORY_VALIDATOR_VERSION` folded into the tag, for a wire-projection change that no
      data-derived counter can see
- [x] `304` carries the ETag, per RFC 9110 §15.4.5
- [x] Verified no client change is needed — `If-None-Match` + the per-session cache + `304`
      handling already landed with planning#375 (reqs 1, 3)
- [x] Unit tests: one case per mutating method; the in-place patch that leaves `MAX(id)` and
      `COUNT(*)` untouched (req 8); a raw SQL write that goes around the manager; scoping;
      durability; no rewind after a delete
- [x] Schema tests: raw SQL moves the counter; a reassigned row moves BOTH counters; the value
      survives closing and reopening a file-backed database; `clearAll` empties the table
- [x] Integration tests: `304` unchanged, fresh body on card patch / same-length rewrite /
      non-transcript change, and no transcript read on the `304` path
- [x] Mutation-checked all three suites — a naive `MAX(id)` + `COUNT(*)` validator, a missing
      `UPDATE` trigger, and a missing reassignment trigger each fail them
- [x] `npm run typecheck`, `npm run lint:dev`, `npm run test:dev`
- [x] Reviewed by ShipIt's configured reviewer; three findings fixed (invalidation contract
      widened past `projectMessagesForWire`, reassignment trigger added, restart-durability
      test moved to a file-backed database)
