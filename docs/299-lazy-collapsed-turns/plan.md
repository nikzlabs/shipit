---
issue: planning#536
title: Lazy collapsed turns — design
description: Collapse every turn but the newest, keep positions stable with placeholder rows, and load a turn's body when it is expanded.
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
| Cards | All 24 types stay | Hidden (req 5) |
| Expand control | Ghost text button | A real button (req 8) |
| Hidden content | Loaded, then hidden | Not loaded (req 6, 7) |

## Measure before building the server half

**Step one is a measurement, not code.** The history payload is already smaller
than it looks, and the design must not claim a saving it does not produce.

Verified at `transcript-projection.ts:299` and `transcript-slice.ts:2-6`: the
wire projection already slices every tool input and tool result to 40 lines or
16 KiB, whichever comes first, and `api-routes-lazy-bodies.ts` serves the full
body on demand. Verified at `transcript-projection.ts:26`: images are replaced
by a URL, so no image bytes ride in the payload.

So the saving of requirement 6 is not "the tool output". It is the sliced
remainder — up to 16 KiB per row — plus intermediate prose and card payloads.
That is still large for a long session (`session-data.ts:260` cites ~2,000 rows
as a real transcript size), but the number has to be measured on a real session
and broken down by row class before the server work starts. If the measurement
shows the win is small, the client half of this design still delivers
requirements 1 to 5, 8 and 11 on its own, and requirements 6 and 7 can be
dropped or deferred.

## The hazard that shapes everything: positions are wire identity

Verified at `ws-client-messages.ts:102-114`: `rewind_at_gap`,
`rewind_preview_request` and their previews address the transcript by
`gapPosition: number`, a positional index into the client's message array.
Verified at `MessageList.tsx:228-245`: the client derives that position by
walking its own array.

So **a payload that omits rows shifts every later index**, and a rewind then
deletes history or resets code at the wrong point. Requirement 6 must therefore
never remove a row from the array. It removes only a row's *content*.

### Placeholder rows

A collapsed row ships as a placeholder: the structural fields only, with no
body.

```
{ index, role, placeholder: true, rolledBack?, notice? }
```

- `role` keeps `shouldShowGapBefore` and `previousRoleBefore` correct
  (`MessageList.tsx:228-245`).
- `rolledBack` and `notice` keep the rewind gaps and status panels in their
  right places.
- Everything else — `content`, `toolUse`, `toolResults`, `images`, `files` and
  every card field — is absent.

`messages.length` stays exact, so the end-of-transcript rewind point and every
gap position stay correct without a single change to the rewind code. This is
the whole reason to prefer placeholders over a sparse array with explicit
indices.

## Server: the collapsed projection

A turn has no identity in storage. Verified at `database.ts:13-28`: the
`messages` table has `session_id`, `role`, `content`, `in_progress` and no turn
column. A turn is the span from one user row to the next, which is exactly how
the client already derives a run (`compact-turns.ts:20`). No migration is
needed.

Put the split and the keep/drop rule in one shared module,
`src/server/shared/collapsed-turns.ts`, imported by both sides. The client
already imports from `server/shared/` (`visual-elements.ts:3`), so this needs no
new boundary. One module is what keeps the server's projection and the client's
expand state from drifting apart.

Keep a row whole when any of these holds:

1. `role === "user"` — requirement 5, with its attachments.
2. `isError`, or `notice === true` — requirement 11.
3. It is the turn's **last agent prose**: an assistant row with non-empty text
   that is not a card carrier and not a notice. This mirrors `lastProse` in
   `compact-turns.ts:43`.
4. It belongs to the newest turn, or to a turn that is still in progress —
   requirement 1.

Everything else becomes a placeholder. Requirement 2 needs no rule of its own: a
tool row has no prose, so rule 3 never keeps it, and the error carve-out of the
current classifier (`compact-turns.ts:50`) is simply not carried over.

### The endpoint

`GET /api/sessions/:id/history` gains `?collapsed=1`. Two things must follow it:

- **The ETag inputs.** Verified at `api-routes-session-spawn.ts:120-127`, the
  validator hashes `HISTORY_VALIDATOR_VERSION`, the session id,
  `transcriptRevision` and `rest`. The mode joins that list, or a collapsed body
  can be served for a full request.
- **The client cache key.** Verified at `session-data.ts:209`, `historyCache` is
  keyed by session id alone. The key becomes `sessionId + mode`.

Expanding one turn is a range read: `GET /api/sessions/:id/history?from=&to=`,
returning the full rows for that span. The client splices them into the same
positions. A range is the right unit because a turn is a contiguous span, and
because the reply then needs no turn identity that storage does not have.

## Client

`useCompactConversation` is replaced. The new state is simpler, because the
server now decides what is collapsed:

- A row is `loaded` or `placeholder`.
- A turn renders collapsed unless it is the newest turn, or the user expanded
  it.
- Expanding a turn with placeholders fetches the range, splices, then shows it.
  Expanding an already-loaded turn only shows it.
- A turn already loaded is never unloaded. When a new turn starts and the
  previous one collapses, the client hides rows it already holds; it does not
  refetch them if the user expands again.

The whole `activeFrom` boundary of `useCompactConversation.ts:20-28` is deleted.
Requirement 4 removes the case it defends against: what is collapsed no longer
depends on what the viewer observed.

This also removes the defect behind the current "no button at all" reports. Only
`agent_result` clears the per-row `inProgress` flag (`agent-event.ts:299-311`);
`agent-interrupted.ts:10` and `error.ts:9` do not, and
`session-data.ts:297` turns a persisted in-progress row into `streaming: true`.
Today any of those pins a run open forever. Under this design the server
classifies from stored rows, so a stale flag cannot pin anything. The flags
still need fixing for the live view, and that fix is small and independent —
keep it as its own change.

## The expand control (req 8)

One real button per collapsed turn, above the turn's content:

- `Button` with `variant="secondary"` and a `CaretDown` icon at `ICON_SIZE.SM`,
  not the current ghost text (`MessageList.tsx:331`).
- The label carries the count: "Show 12 hidden messages". A count tells the user
  whether expanding is worth it.
- It keeps `aria-expanded` and `aria-controls`, and it shows a loading state
  while the range fetch is in flight.
- A failed turn puts its status beside the button, after the kept error row.

Follow the `design-language` skill: semantic color tokens only, no hardcoded
palette values, `@phosphor-icons/react` for the icon.

## Search (req 10)

In-app search keeps matching `msg.text` on the client (`useSearch.ts`), so it
now misses text in placeholder rows. While a query is active, the search bar
shows one control — "Search the whole conversation" — which loads the full
transcript for the session and re-runs the search. It sets no persistent state:
the next session load is collapsed again.

Turning the setting off in Settings remains the way to read the whole transcript
without searching.

## Non-goals

- No server-side search. The user rejected it explicitly.
- No truncation of the kept agent message.
- No change to the persisted history, to the agent lifecycle, or to the
  turn-event buffer.
- No change to `turn_snapshot` or to the live WS append path. The live turn is
  always full, so it needs no projection.
- User attachments stay whole in the payload. Making them lazy is separate
  work.

## Risks

- **Rewind and fork addressing.** The placeholder design exists for this. Any
  change that drops a row instead of blanking it is a data-loss bug, so the
  guard test asserts that a collapsed payload and a full payload have the same
  length and the same role at every index.
- **Card state.** Verified at `session-data.ts:303-330`: the client seeds the
  bug-report, permission, egress and issue-write card stores from the persisted
  rows on every load. Hiding card rows removes that seed. This is the open
  question in the requirements; until it is answered, keep card rows loaded even
  when they are not displayed.
- **A measurement that does not justify the work.** Handled by making the
  measurement step one.

## Simpler alternatives considered

- **Client-only, no server change.** Delivers requirements 1 to 5, 8 and 11 and
  nothing else. This is the fallback if the measurement is disappointing, and it
  is also a sound first pull request.
- **Sparse arrays with explicit row indices.** Rejected: it changes every
  consumer of the message array and every position-addressed message, for no
  gain over placeholders.
- **A turn id column.** Rejected: user-row boundaries already define a turn on
  both sides, and a new column would need a backfill migration for existing
  sessions.

## Verification

- A collapsed payload and a full payload have equal length and equal role per
  index. Rewind at a gap in a collapsed transcript targets the same row as in a
  full one.
- Newest turn full; previous turn collapses when a new turn starts.
- Tool groups hidden whether or not a tool failed; error rows and notices kept.
- Attach during a running turn: earlier turns collapsed, live turn full.
- Expand a placeholder turn: one range request, rows spliced at the right
  positions, no scroll jump.
- Expand-all from the search bar finds text that was not loaded.
- Setting off: the payload and the view are exactly as today.
- Reload, reconnect, session switch, rewind, fork.
- `lint:dev`, `typecheck`, affected tests, and browser checks in a light and a
  dark theme.
