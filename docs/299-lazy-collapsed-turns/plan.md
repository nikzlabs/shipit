---
issue: planning#536
title: Lazy collapsed turns — design
description: Collapse every turn but the newest, reduce hidden rows in place, and load a turn's body when it is expanded.
---

# Design

See [requirements](./requirements.md). This replaces the display rules of
[docs/296-compact-conversation](../296-compact-conversation/plan.md), which stay
in place until this work ships.

## What changes against the shipped feature

| Behavior | docs/296 today | This design |
|---|---|---|
| Newest turn | Collapses as soon as it settles | Always full (req 1) |
| Tool group with one error | Stays fully visible | Hidden (req 2) |
| Interrupted / failed turn | Never collapses | Collapses; its error rows stay (req 3, 11) |
| Attach during a turn | Whole transcript stays full | Earlier turns collapse (req 4) |
| Cards | All 24 types stay | Hidden, unless the card still needs the user (req 5, 12) |
| Expand control | Ghost text button | A real button (req 8) |
| Hidden content | Loaded, then hidden | Not loaded (req 6, 7) |

## The goal is load time on a slow connection

Requirement 13 states the purpose: a big session must open much faster on a
mobile network. That is what the work is judged against, and it decides where
the effort goes, so the first step measures it and splits it in two:

- **Transfer.** The bytes of `GET /api/sessions/:id/history` for a real long
  session, broken down by row class.
- **Client work after the bytes arrive.** Parsing the payload, materializing the
  rows and the first render. `session-data.ts:260` records ~2,000 rows as a real
  transcript size and **92 ms** just to re-render the list when row identity
  changes, so this half is not small, and a mobile CPU is slower than the
  machine that number came from.

Reducing the payload helps both halves — fewer bytes to move and fewer rows to
build — but only the measurement says which dominates. Measure the real endpoint
against a real long session over a throttled connection. Do not measure a
synthetic fixture: its row mix would decide the answer.

**The measurement directs the work; it cannot cancel it.** Requirements 6 and 7
are the user's own, so a modest byte count is a reason to look at the client
half as well, not a reason to stop.

**Check compression first, because it can be most of the win for one line.** The
orchestrator registers no compression plugin: there is no `@fastify/compress` in
`package.json` and none in `buildApp()`. A deployed instance sits behind a
Cloudflare Tunnel (`deployment/vps/cloudflare.sh`), which compresses at the
edge, but a Tailscale or loopback client has no edge in front of it and receives
raw JSON. A transcript is highly compressible text, so the measurement must
record the bytes **as the client actually receives them** on the path the user
uses, and must answer whether compression is applied at all before anyone
concludes that the payload has to shrink.

What the payload is **not** is the raw tool output. Verified at
`transcript-projection.ts:113` and `:213`: tool results above
`RESULT_STRIP_FLOOR_BYTES` (200) are sliced or emptied, some tools are exempt
and ship whole (`shipsResultBodyWhole`), sub-agent reports have their own
slicer, tool inputs are projected per key (removed, or cut to
`COMMAND_SUMMARY_CHARS`), and images become URLs (`transcript-projection.ts:26`).
`api-routes-lazy-bodies.ts` serves the rest on demand. There is no single
per-row ceiling, and an earlier draft of this plan claimed one.

## The hazard that shapes everything: positions are wire identity

Verified at `ws-client-messages.ts:102-114`: `rewind_at_gap`,
`rewind_preview_request` and their previews address the transcript by
`gapPosition: number`, a positional index into the client's message array.
Verified at `MessageList.tsx:228-245`: the client derives that position by
walking its own array.

So **a payload that omits rows shifts every later index**, and a rewind then
deletes history or resets code at the wrong point. Requirement 6 must therefore
never remove a row from the array. It removes only content from inside a row.

## One mechanism: a reduced row

A row the user cannot see ships **reduced**: its displayed fields, and nothing
else.

```
{ index, role, reduced: true, text, isError?, notice?, rolledBack?, <card field>? }
```

- A row that is fully hidden keeps `role` and `text: ""`. `text` must be a
  string, not absent: `visual-elements.ts:223` calls `msg.text.trim()` directly.
- A row kept for its prose keeps `text` whole and loses `toolUse`,
  `toolResults`, `subagentEvents` and its images.
- `rolledBack` and `notice` keep the rewind gaps and status panels in place;
  `role` keeps `shouldShowGapBefore` and `previousRoleBefore` correct
  (`MessageList.tsx:228-245`).

**Row selection is not enough — fields must be stripped inside a kept row.**
Verified at `chat-card-persistence.ts:60-71` and `agent-event.ts:185-195`: one
persisted row carries `text`, `toolUse` and `toolResults` together, and the live
merge concatenates prose and tool blocks into the same row. So "the last agent
message" is frequently also a tool row. Selecting it whole would ship the tool
payload (breaking requirement 6) and render it (breaking requirement 2). This is
why the projection is per-field.

`messages.length` stays exact, so every gap position stays correct with no
change to the rewind code. That is the whole reason to reduce rows in place
rather than build a sparse array with explicit indices.

## Display turn, execution turn

A turn has no identity in storage. Verified at `database.ts:13-28`: the
`messages` table has `session_id`, `role`, `content`, `in_progress` and no turn
column. A **display turn** is the span from one user row to the next, which is
how the client already derives a run (`compact-turns.ts:20`). No migration is
needed.

An **execution** is not the same span. Verified at
`chat-card-persistence.ts:35`: a steered user message is interleaved into one
execution, so one execution can contain several display turns; and
`route-registry.ts:645` snapshots the whole execution on attach.

The rule that reconciles them: **never reduce a row whose `in_progress` is set,
and never reduce the newest display turn.** Then a `turn_snapshot` always
describes rows that are full, so its replace-filter (`turn-snapshot.ts:20`,
which selects on `inProgress`) keeps working untouched. The cost is that a
steered live execution keeps earlier display turns full until it settles. That
is bounded — one execution, already being streamed — and it is the deliberate
price of leaving the live path alone.

## Server: the reduced projection

Put the display-turn split and the keep/drop rule in one shared module,
`src/server/shared/collapsed-turns.ts`, imported by both sides. The client
already imports from `server/shared/` (`visual-elements.ts:3`), so this needs no
new boundary. One module is what keeps the server's projection and the client's
expand state from drifting apart.

Keep a row's content when any of these holds:

1. `role === "user"` — requirement 5, with its attachments.
2. `isError`, or `notice === true` — requirement 11.
3. A card that still needs the user — requirement 12. The card's own resolved
   state decides: an action checklist not yet submitted, a bug report not yet
   filed, an issue write still inside its undo window.
4. It is the display turn's **last agent prose**: an assistant row with
   non-empty text that is not a card carrier and not a notice. Keep `text`;
   strip the tool fields.
5. It is in the newest display turn, or `in_progress` is set.

Everything else is reduced to `{ role, text: "" }`. Requirement 2 needs no rule
of its own: a tool row is never kept by rules 1 to 4, and rule 4 strips the
tools from the row it does keep.

### The endpoint

`GET /api/sessions/:id/history` gains `?collapsed=1`. Two things follow it:

- **The ETag inputs.** Verified at `api-routes-session-spawn.ts:120-127`, the
  validator hashes `HISTORY_VALIDATOR_VERSION`, the session id,
  `transcriptRevision` and `rest`. The mode joins that list, or a collapsed body
  can answer a full request.
- **The client cache key.** Verified at `session-data.ts:209`, `historyCache` is
  keyed by session id alone. The key becomes `sessionId + mode`.

Expanding is a range read: `GET /api/sessions/:id/history?from=&to=&rev=`. The
client sends the `transcriptRevision` it holds; the server refuses a mismatch
with `409`, and the client falls back to a full reload. Without that check a
response that arrives after a rewind would splice old content over unrelated
rows, and equal lengths cannot detect it. `transcriptRevision` already exists
(`api-routes-session-spawn.ts:120`), so this needs no new counter.

## Client

### Expanding, and never reloading wholesale

Expanding a turn splices the range response into the same positions. **Loading
the whole transcript — from the search control, or when the setting is turned
off — is the same splice over every reduced range, not a call to
`loadSessionHistory`.**

That matters. Verified at `session-data.ts:410-425`: `loadSessionHistory`
replaces the message array wholesale, and during a running turn the payload is a
*subset* of what is on screen. Its safety comes from the attach sequence —
`historyLoaded` is false for the whole load, `turn_snapshot` is queued behind
it, and the snapshot restores the live tail. A search-triggered load performs no
attach, so no snapshot follows it, and the live tail would be erased. Splicing
avoids the hazard completely rather than guarding against it: reduced rows only
exist below the live execution, so a splice can never touch the live tail.

### State

- A row is `full` or `reduced`.
- A display turn renders collapsed unless it is the newest, or the user expanded
  it.
- Expanding a turn that holds reduced rows fetches its range, splices, then
  shows it. Expanding an already-full turn only shows it.
- A turn once loaded is never unloaded. When a new turn starts and the previous
  one collapses, the client hides rows it already holds.

The `activeFrom` boundary of `useCompactConversation.ts:20-28` is deleted.
Requirement 4 removes the case it defends against: what is collapsed no longer
depends on what the viewer observed.

**Keep the focus and selection protection** of `useCompactConversation.ts:29-69`
and the reading-anchor restoration of `CompactLayout.tsx`. Automatic collapse
still happens while the user reads — another viewer or a queued message can
start the next turn — and asynchronous expansion moves content under the reader
in a way the shipped feature never had to handle.

### Group parents must not move

Verified at `MessageList.tsx:369-400`: content-visibility groups are flushed
every `ROWS_PER_GROUP` (20) anchors and keyed by position, `g-${rowGroups.length}`.
Splicing rows into the middle therefore re-buckets every later group, moving
card components to new DOM parents and remounting them. A bug-report card with
an unsent title and body loses the draft.

Fix: **flush a group at every display-turn boundary**, and key it by the turn's
first message index rather than by its ordinal. Expanding a turn then changes
only that turn's own groups. Requirement 12 makes this necessary rather than
merely tidy: the cards that survive a collapse are exactly the ones holding
unsent user input.

### Stale in-progress flags

Only `agent_result` clears the per-row `inProgress` flag
(`agent-event.ts:299-311`); `agent-interrupted.ts:10` and `error.ts:9` do not,
and `session-data.ts:297` turns a persisted in-progress row into
`streaming: true`. Today that pins a run open forever, which is why the shipped
feature sometimes shows no button at all.

This design does **not** make that harmless: rule 5 keeps `in_progress` rows
full, so a stale flag would keep a dead turn permanently expanded. The flags
have to be fixed, as their own small change, before or with this work.

## The expand control (req 8)

One real button per collapsed turn, above the turn's content: a `Button` with
`variant="secondary"` and a `CaretDown` icon at `ICON_SIZE.SM`, not the current
ghost text (`MessageList.tsx:331`). It keeps `aria-expanded` and
`aria-controls`, and it shows a loading state while the range fetch is in
flight. No hidden-row count, and no failure status beside it — requirement 11
already keeps the error row on screen.

Follow the `design-language` skill: semantic color tokens only, no hardcoded
palette values, `@phosphor-icons/react` for the icon.

## Search (req 10)

In-app search keeps matching `msg.text` on the client (`useSearch.ts`), so it
misses text in reduced rows. While a query is active, the search bar shows one
control — "Search the whole conversation" — which loads every reduced range,
**expands every turn**, and re-runs the search. Expanding every turn is part of
the action: loading the rows without expanding them would leave a matching turn
collapsed.

Keep the shipped behavior where a turn with a match opens automatically
(`useCompactConversation.ts:96`), so ordinary search results stay navigable.

The control sets no persistent state: the next session load is collapsed again.
Turning the setting off remains the way to read the whole transcript without
searching.

## Non-goals

- No server-side search. The user rejected it explicitly.
- No truncation of the kept agent message.
- No change to the persisted history, to the agent lifecycle, or to the
  turn-event buffer.
- No change to `turn_snapshot` or to the live WS append path. The live execution
  is never reduced, so it needs no projection.
- User attachments stay whole in the payload. Making them lazy is separate work.

## Risks

- **Rewind and fork addressing.** Reducing rows in place exists for this. Any
  change that drops a row instead of reducing it is a data-loss bug, so the
  guard test asserts that a collapsed payload and a full payload have the same
  length and the same role at every index.
- **A range response that outlives its history.** Handled by the revision check.
- **Erasing the live tail.** Handled by splicing rather than reloading.
- **Remounting a card that holds unsent input.** Handled by the group-parent
  fix, and verified by a test that types into a bug-report card, expands an
  older turn, and asserts the draft survives.

## Simpler alternatives considered

- **Client-only, no server change.** Delivers requirements 1 to 5, 8, 11 and 12.
  A sound first pull request, and it is where the display rules get proved — but
  it does not deliver requirement 13, so it is an intermediate step, not the
  feature.
- **Sparse arrays with explicit row indices.** Rejected: it changes every
  consumer of the message array and every position-addressed message, for no
  gain over reducing rows in place.
- **A turn id column.** Rejected: user-row boundaries already define a display
  turn on both sides, and a new column would need a backfill migration.

## Verification

- A collapsed payload and a full payload have equal length and equal role per
  index. Rewind at a gap in a collapsed transcript targets the same row as in a
  full one.
- A kept prose row that also carried tools ships without them, and renders
  without them.
- Newest turn full; previous turn collapses when a new turn starts.
- Tool groups hidden whether or not a tool failed; error rows and notices kept;
  an unresolved action card and an unsent bug report kept, with their state.
- Attach during a running turn, including after a steer: the whole live
  execution stays full, earlier turns are collapsed.
- Expand a reduced turn: one range request, rows spliced at the right positions,
  no scroll jump, no card remount.
- A range response for a superseded revision is refused and falls back.
- Expand-all from the search bar during a running turn: the live tail survives,
  and every turn is expanded.
- Setting off: the payload and the view are exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- `lint:dev`, `typecheck`, affected tests, and browser checks in a light and a
  dark theme, on a throttled mobile profile.
