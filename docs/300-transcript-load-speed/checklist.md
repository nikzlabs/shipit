# Transcript load speed

## Measurement

- [ ] Check whether the history response reaches the client compressed, on the
      path the user actually uses.
- [ ] Measure how long a big session takes to open on a throttled mobile
      profile, split into transfer and work after the bytes arrive.
- [ ] Break the payload down by row class, from the real endpoint on real
      sessions.
- [ ] Write the target number into the plan, then build.

## Server

- [ ] Add `?collapsed=1` to the history endpoint and to the ETag inputs.
- [ ] Key the client history cache by session id and mode.
- [ ] Emit reduced rows that keep index, role, `text` and the structural flags.
- [ ] Strip tool fields from a row kept for its prose.
- [ ] Never reduce the newest display turn. That is the only exception, and it
      is the same test docs/299 uses to decide what is collapsed.
- [ ] Add the range read with a `transcriptRevision` check and a `409` refusal.
- [ ] Guard test: collapsed and full payloads have equal length and equal role
      per index.
- [ ] Rewind and fork tests against a collapsed transcript.

## Client

- [ ] Splice range responses into their positions; never reload wholesale.
- [ ] Flush a content-visibility group at every display-turn boundary, keyed by
      the turn's first message index.
- [ ] Test that an unsent bug-report draft survives expanding an older turn.
- [ ] Add the expand-everything control to the search bar, active only while a
      query is present; it loads every reduced range and expands every turn.

## Before shipping

- [ ] Re-measure with the step-one script and record the result.
- [ ] `lint:dev`, `typecheck`, affected tests.
- [ ] Browser checks throttled, in a light and a dark theme.
- [ ] Independent review of the implementation.
