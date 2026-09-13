---
issue: planning#538
title: Transcript load speed — design
description: Reduce hidden rows in place on the wire, and splice a turn's full rows in when it is expanded.
---

# Design

See [requirements](./requirements.md). This builds on
[docs/299-collapsed-turns](../299-collapsed-turns/plan.md), which
decides what a collapsed turn shows. This document decides what the server sends
and when the rest arrives.

## Measure first

Requirement 1 is a time, so the work starts by measuring that time and splitting
it. The goal is the time from opening a big session to a transcript the user can
read and scroll. Define "usable" before measuring — the last message painted and
the list settled — or the number moves with whoever reads the screen.

**Check compression before anything else.** The orchestrator registers no
compression plugin: there is no `@fastify/compress` in `package.json` and none
in `buildApp()`. A deployed instance sits behind a Cloudflare Tunnel
(`deployment/vps/cloudflare.sh`), which compresses at the edge, but a Tailscale
or loopback client has no edge in front of it and receives raw JSON. A
transcript is highly compressible text, so compression at the origin may be most
of requirement 1 for one line of configuration. Read `Content-Encoding` on the
real response, on the path the user actually uses, before designing around the
payload size.

**Then split the time in two.**

- **Transfer.** The bytes as the client receives them, and the time to the last
  byte of the history request.
- **Work after the bytes arrive.** JSON parsing, `materializeTranscript`,
  `buildVisualElements`, and the first paint of the list. `session-data.ts:260`
  records ~2,000 rows as a real transcript size and **92 ms** merely to
  re-render the list when row identity changes, on a desktop machine. A phone is
  slower.

Confirm the split by changing one variable at a time: run the same session at
two bandwidths, and if the total scales with bandwidth, transfer dominates; run
at two CPU throttle settings, and if it scales with those instead, the phone's
processor does.

**Method rules, and why each exists.**

- Measure real sessions, one big, one medium, one small. Never a synthetic
  fixture: the mix of rows decides the answer, and in a fixture that mix is
  chosen by whoever writes it.
- Force a cold load. The history response carries an ETag and the client keeps
  it (`session-data.ts:209`), so a warm `304` measures nothing.
- Measure the bytes as served, not as generated. Compression sits between the
  two.
- Repeat at least five times, discard the first run, report the median.
- Write the target number into this document before building, and re-measure
  afterwards with the same script. A different script makes the comparison
  worthless.

**Then break the payload down** by row class — user rows, agent prose, tool
inputs, tool results, sub-agent events, cards, notices — and compute what the
reduced projection would leave. That is the ceiling of this work, known before a
line of it is written.

What the payload is **not** is raw tool output. Verified at
`transcript-projection.ts:113` and `:213`: tool results above
`RESULT_STRIP_FLOOR_BYTES` (200) are sliced or emptied, some tools ship whole
(`shipsResultBodyWhole`), sub-agent reports have their own slicer, tool inputs
are projected per key, and images become URLs (`transcript-projection.ts:26`).
`api-routes-lazy-bodies.ts` serves the rest on demand. There is no single
per-row ceiling.

**The measurement directs the work; it cannot cancel it.** Requirements 2 and 3
are the user's own.

## The hazard that shapes everything: positions are wire identity

Verified at `ws-client-messages.ts:102-114`: `rewind_at_gap`,
`rewind_preview_request` and their previews address the transcript by
`gapPosition: number`, a positional index into the client's message array.
Verified at `MessageList.tsx:228-245`: the client derives that position by
walking its own array.

So **a payload that omits rows shifts every later index**, and a rewind then
deletes history or resets code at the wrong point. Requirement 2 must never
remove a row from the array. It removes only content from inside a row.

## One mechanism: a reduced row

A row the user cannot see ships **reduced**: its displayed fields, and nothing
else.

```
{ index, role, reduced: true, text, isError?, notice?, rolledBack?, <card field>? }
```

- A fully hidden row keeps `role` and `text: ""`. `text` must be a string, not
  absent: `visual-elements.ts:223` calls `msg.text.trim()` directly.
- A row kept for its prose keeps `text` whole and loses `toolUse`,
  `toolResults`, `subagentEvents` and its images.
- `rolledBack` and `notice` keep the rewind gaps and status panels in place;
  `role` keeps `shouldShowGapBefore` and `previousRoleBefore` correct.

**Row selection is not enough — fields must be stripped inside a kept row.**
Verified at `chat-card-persistence.ts:60-71` and `agent-event.ts:185-195`: one
persisted row carries `text`, `toolUse` and `toolResults` together, and the live
merge concatenates prose and tool blocks into the same row. So the row docs/299
keeps for its prose is frequently also a tool row. Sending it whole would carry
the tool payload it is supposed to omit.

`messages.length` stays exact, so every gap position stays correct with no
change to the rewind code. That is the whole reason to reduce rows in place
rather than build a sparse array with explicit indices.

## What must never be reduced

Never reduce a row whose `in_progress` is set, and never reduce the newest
display turn.

Verified at `chat-card-persistence.ts:35`: a steered user message is interleaved
into one execution, so one execution can contain several display turns; and
`route-registry.ts:645` snapshots the whole execution on attach. Keeping every
in-progress row full means a `turn_snapshot` always describes full rows, so its
replace-filter (`turn-snapshot.ts:20`, which selects on `inProgress`) keeps
working untouched. The cost is that a steered live execution keeps earlier
display turns full until it settles — bounded to one execution that is already
being streamed, and the deliberate price of leaving the live path alone.

This also means a stale `inProgress` flag would keep a dead turn permanently
full. docs/299 lists that fix; this design depends on it.

## The endpoint

`GET /api/sessions/:id/history` gains `?collapsed=1`. Two things follow it:

- **The ETag inputs.** Verified at `api-routes-session-spawn.ts:120-127`, the
  validator hashes `HISTORY_VALIDATOR_VERSION`, the session id,
  `transcriptRevision` and `rest`. The mode joins that list, or a collapsed body
  can answer a full request.
- **The client cache key.** Verified at `session-data.ts:209`, `historyCache` is
  keyed by session id alone. The key becomes `sessionId + mode`.

Expanding is a range read: `GET /api/sessions/:id/history?from=&to=&rev=`. The
client sends the `transcriptRevision` it holds; the server refuses a mismatch
with `409`, and the client falls back to a full reload. Without that check, a
response arriving after a rewind would splice old content over unrelated rows,
and equal lengths cannot detect it. `transcriptRevision` already exists, so this
needs no new counter.

## Client

### Splice; never reload wholesale

Expanding a turn splices the range response into the same positions. **Loading
the whole transcript — from the search control, or when the collapse setting is
turned off — is the same splice over every reduced range, not a call to
`loadSessionHistory`.**

Verified at `session-data.ts:410-425`: `loadSessionHistory` replaces the message
array wholesale, and during a running turn the payload is a *subset* of what is
on screen. Its safety comes from the attach sequence — `historyLoaded` is false
for the whole load, `turn_snapshot` is queued behind it, and the snapshot
restores the live tail. A search-triggered load performs no attach, so no
snapshot follows it, and the live tail would be erased. Splicing avoids the
hazard rather than guarding against it: reduced rows only exist below the live
execution, so a splice can never touch the live tail.

### Group parents must not move

Verified at `MessageList.tsx:369-400`: content-visibility groups are flushed
every `ROWS_PER_GROUP` (20) anchors and keyed by position,
`g-${rowGroups.length}`. Splicing rows into the middle re-buckets every later
group, moving card components to new DOM parents and remounting them. A
bug-report card with an unsent title and body loses the draft.

Fix: **flush a group at every display-turn boundary**, and key it by the turn's
first message index rather than by its ordinal. Expanding a turn then changes
only that turn's own groups. docs/299 req 12 makes this necessary rather than
tidy: the cards that survive a collapse are exactly the ones holding unsent user
input.

This hazard does not exist in docs/299 on its own, where hidden rows stay
mounted and counted and nothing is ever inserted.

### Search (req 4)

In-app search keeps matching `msg.text` on the client (`useSearch.ts`), so it
misses text in reduced rows. While a query is active, the search bar shows one
control — "Search the whole conversation" — which loads every reduced range,
**expands every turn**, and re-runs the search. Expanding every turn is part of
the action: loading the rows without expanding them would leave a matching turn
collapsed. The control sets no persistent state; the next session load is
collapsed again.

## Non-goals

- No server-side search. The user rejected it explicitly.
- No change to the persisted history, the agent lifecycle, or the turn-event
  buffer.
- No change to `turn_snapshot` or the live WS append path.
- User attachments stay whole in the payload. Making them lazy is separate work.

## Risks

- **Rewind and fork addressing.** Reducing rows in place exists for this. Any
  change that drops a row instead of reducing it is a data-loss bug, so the
  guard test asserts that a collapsed payload and a full payload have the same
  length and the same role at every index.
- **A range response that outlives its history.** Handled by the revision check.
- **Erasing the live tail.** Handled by splicing rather than reloading.
- **Remounting a card that holds unsent input.** Handled by the group-parent
  fix, verified by a test that types into a bug-report card, expands an older
  turn, and asserts the draft survives.

## Simpler alternatives considered

- **Compression only.** If the measurement shows the response reaches the phone
  uncompressed, this may deliver most of requirement 1 by itself. It does not
  deliver requirements 2 and 3, but it changes how much the rest is worth.
- **Sparse arrays with explicit row indices.** Rejected: it changes every
  consumer of the message array and every position-addressed message, for no
  gain over reducing rows in place.

## Verification

- A collapsed payload and a full payload have equal length and equal role per
  index. Rewind at a gap in a collapsed transcript targets the same row as in a
  full one.
- A kept prose row that also carried tools ships without them.
- Attach during a running turn, including after a steer: the whole live
  execution is full.
- Expand a reduced turn: one range request, rows spliced at the right positions,
  no scroll jump, no card remount.
- A range response for a superseded revision is refused and falls back.
- Expand-all from the search bar during a running turn: the live tail survives,
  and every turn is expanded.
- Collapse setting off: the payload and the view are exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- Re-measure against the requirement 1 target with the step-one script.
