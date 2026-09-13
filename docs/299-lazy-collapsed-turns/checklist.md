# Lazy collapsed turns

## Design

- [x] Record the user's requirements and the four reported problems.
- [x] Verify the storage, wire and caching facts the design depends on.
- [x] Write the design.
- [ ] Answer the open question about unresolved cards.
- [ ] Get an independent review of the design.

## Measurement

- [ ] Measure a real long session's history payload, broken down by row class.
- [ ] Decide from the number whether the server half (req 6, 7) is worth
      building, or whether the client half ships alone.

## Client half (req 1 to 5, 8, 11)

- [ ] Add the shared turn split and keep/drop rule in
      `src/server/shared/collapsed-turns.ts`.
- [ ] Replace `useCompactConversation`: newest turn always full, no `activeFrom`
      boundary.
- [ ] Hide all tool groups, all cards and all intermediate prose; keep user
      rows, error rows and notices.
- [ ] Rebuild the expand control as a real button with a hidden-row count.
- [ ] Fix the stale `inProgress` / `streaming` flags on the interrupt and error
      paths, as its own change.
- [ ] Component tests, including one that goes red without each new guard.

## Server half (req 6, 7)

- [ ] Add `?collapsed=1` to the history endpoint and to the ETag inputs.
- [ ] Key the client history cache by session id and mode.
- [ ] Emit placeholder rows that keep index, role, `rolledBack` and `notice`.
- [ ] Add the range read and splice it into the same positions.
- [ ] Guard test: collapsed and full payloads have equal length and equal role
      per index.
- [ ] Rewind and fork tests against a collapsed transcript.

## Search (req 10)

- [ ] Add the expand-everything control to the search bar, active only while a
      query is present.

## Before shipping

- [ ] `lint:dev`, `typecheck`, affected tests.
- [ ] Browser checks in a light and a dark theme, narrow and wide.
- [ ] Independent review of the implementation.
