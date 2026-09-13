# Lazy collapsed turns

## Design

- [x] Record the user's requirements and the four reported problems.
- [x] Verify the storage, wire and caching facts the design depends on.
- [x] Write the design.
- [x] Answer the open question about cards that still need the user.
- [x] Get an independent review of the design.
- [x] Correct the design against the review: per-field reduction for mixed
      rows, a revision check on range reads, splicing instead of a wholesale
      reload, stable group parents, display turn against execution turn, and
      the corrected description of the existing projection.

## Measurement

- [ ] Measure how long a big session takes to open on a throttled mobile
      profile, split into transfer bytes and client work after the bytes
      arrive.
- [ ] Break the payload down by row class, from the real endpoint on a real
      session.
- [ ] Record the numbers in the plan, and use them to direct the work.

## Client half (req 1 to 5, 8, 11, 12)

- [ ] Add the display-turn split and the keep/strip rule in
      `src/server/shared/collapsed-turns.ts`.
- [ ] Replace `useCompactConversation`: newest turn always full, no `activeFrom`
      boundary; keep the focus/selection protection and the reading anchor.
- [ ] Hide all tool groups and all intermediate prose; keep user rows, error
      rows, notices, and cards that still need the user.
- [ ] Strip tool fields from a kept prose row.
- [ ] Rebuild the expand control as a real button.
- [ ] Flush a content-visibility group at every display-turn boundary, keyed by
      the turn's first message index.
- [ ] Test that an unsent bug-report draft survives expanding an older turn.
- [ ] Component tests, including one that goes red without each new guard.

## Stale flags (separate change)

- [ ] Clear the per-row `inProgress` and `streaming` flags on every turn-end
      path, not only `agent_result`.

## Server half (req 6, 7, 13)

- [ ] Add `?collapsed=1` to the history endpoint and to the ETag inputs.
- [ ] Key the client history cache by session id and mode.
- [ ] Emit reduced rows that keep index, role, `text`, and the structural flags.
- [ ] Never reduce a row with `in_progress` set, or the newest display turn.
- [ ] Add the range read with a `transcriptRevision` check and a `409` refusal.
- [ ] Splice range responses; never reload wholesale.
- [ ] Guard test: collapsed and full payloads have equal length and equal role
      per index.
- [ ] Rewind and fork tests against a collapsed transcript.

## Search (req 10)

- [ ] Add the expand-everything control to the search bar, active only while a
      query is present; it loads every reduced range and expands every turn.
- [ ] Keep automatic reveal of a turn that matches the query.

## Before shipping

- [ ] Re-measure against the requirement 13 goal and record the result.
- [ ] `lint:dev`, `typecheck`, affected tests.
- [ ] Browser checks in a light and a dark theme, narrow and wide, throttled.
- [ ] Independent review of the implementation.
