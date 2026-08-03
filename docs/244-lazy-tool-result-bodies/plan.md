---
issue: https://linear.app/shipit-ai/issue/SHI-267
title: Lazy-load heavy chat-history row bodies
description: Keep what the transcript actually draws inline and fetch the rest on demand, so a history load transfers kilobytes instead of megabytes.
---

# Lazy-load heavy chat-history row bodies

Paging (SHI-266, not yet built) bounds how many **rows** a transcript load
transfers. It does not bound **bytes**: a window of ten turns containing several
near-1 MB tool outputs is still a heavy payload. This feature bounds the bytes.

## Requirements

This feature is under requirements discipline — `requirements.md` in this folder
is the source of truth for what it must do. No open questions remain.
Everything in this document is design: the mechanism chosen to satisfy those
requirements, not the requirements themselves.

Two resolutions shape the design directly:

* **Req 8** — the transcript must look exactly as it does today and carry no
  loading states of its own, but a view opened by a click may load on demand.
  So the inline artifacts below (the preview, `+N -M`, the thumbnail) are
  non-negotiable, while the diff modal, the full-size image preview, and the
  "Show all N lines" expansion may each show a spinner.
* **Req 9** — images *may* render inline at reduced resolution. Permission, not
  obligation: the design ends up not needing it, and req 8 turns out to forbid
  exercising it for tool-result images, which have no full-size view to recover
  the detail from.

Req 1 also fixes the completion criterion: *do not load information that is not
visible without a click*. There is no byte target to tune against.

## What the UI actually draws

> **The `tool_results` row of this table is out of date.** It described the UI
> as it was when this design was written. The transcript no longer previews tool
> output at all — it draws a one-line summary from the tool's *input*, and the
> output moved into the click-opened modal. The issue's original premise
> ("not directly displayed… they sit behind a click") turns out to be *more*
> true than this analysis concluded. See *Requirement 1 is not met* below; the
> rest of the table still holds.

The issue's premise is that the heavy columns "are not directly displayed in the
conversation UI — they sit behind a click". Checked against the render paths,
that is broadly right — but each column draws a small *derived* artifact inline,
and it is that artifact, not raw metadata, that has to stay on the wire.

| Column | What renders inline | What's behind a click |
|---|---|---|
| `tool_results` | ~~First 15–30 lines + a "Show all N lines" button~~ — **nothing**; see the note above | A slice in the modal, then the whole body behind the modal's own "Show all N lines" |
| `tool_use` (Write/Edit) | One line: verb, path, `+40 -12` (`DiffBlock.tsx:66–92`) | The whole diff body, in a modal |
| `images` (user rows) | A 96×96 thumbnail (`w-24 h-24 object-cover`, `message-media.tsx:53`) | Full-size preview |
| `subagent_events` | A `Disclosure` — "Subagent's work (N actions)" — open by default, containing ordinary tool calls | Per-step detail, via the same components |

So three mechanisms cover all four columns, and `subagent_events` needs none of
its own: its contents are rendered by the *same* components as top-level tools,
so fixing tool results and Write/Edit bodies covers its innards for free. What
remains on a subagent row is per-step text, which is small.

### The inline artifacts each mechanism must preserve

* **`totalLines`** — `truncateLines` computes the "Show all N lines" label from
  the whole body. A head slice must carry the true count or the button lies.
* **`added` / `removed`** — `DiffBlock` derives these via `countLines(newString)`
  and `countLines(oldString)`. Persist the two integers and the body can go
  lazy with no visible change at all.
* **The image itself, at today's resolution** — user-row images draw at 96×96
  (`message-media.tsx:53`) behind a click-to-full-size; tool-result images draw
  at up to 256px (`max-h-64`, `ToolResult.tsx:252`) with **no click affordance
  at all**. `ChatMessageImage` already carries an optional `src?: string`
  (`MessageList/types.ts:59`), so a URL-backed path exists in the type today.

### One thing that must never be truncated

* **The subagent final report.** `findSubagentFinalReport` reads it from the
  *parent's* `toolResults` and renders it in full as markdown
  (`SubagentCall.tsx:50, 132`) with no expand affordance. Exempt by parent tool
  name (`SUBAGENT_TOOLS`).

The other three consumers the issue flags all read short values that fit well
inside a slice: `AskUserQuestion` (`resolvedAnswer={result?.content}`,
`message-tools.tsx:137`), `ExitPlanMode` (`resolved={!!result}`, `:162`), and
Present (`parsePresentToolResult`, `:171`).

## Verified facts

* The 1 MB cap is **client-side only** — `src/client/hooks/message-handlers/agent-event.ts:122`,
  on the live in-memory copy.
* The **persist path is uncapped**: `extractToolResults`
  (`ws-handlers/agent-event-normalizer.ts:15–31`) applies no size limit, and
  `chat-history.ts:489` stores `JSON.stringify(msg.toolResults)` verbatim.
* `PersistedMessage` carries **no row id** (`chat-history.ts:107`).

## The SHI-266 dependency is not real

SHI-267 was sequenced after SHI-266 "because it depends on `rowId` being on the
wire". Neither mechanism needs one:

* Tool results and Write/Edit inputs are addressed by `toolUseId`, already on
  the wire and unique within a session — including results nested inside
  `subagent_events`, which carry their own (`collectToolResults`,
  `SubagentCall.tsx:248`).
* Images are addressed by a content hash, which is a better key than a row id
  anyway: it dedupes a screenshot pasted twice and survives rewind renumbering.

The two issues can ship in either order.

## Design

### 1. Tool results — head slice, lazy tail

Each tool result gains three fields:

```ts
{
  toolUseId: string;
  content: string;      // head slice when `truncated`, else the whole body
  isError?: boolean;
  durationMs?: number;
  truncated?: true;     // content is a prefix; full body available on demand
  totalLines?: number;  // true line count, for the "Show all N lines" label
  totalBytes?: number;
}
```

`truncated` is the `contentAvailable` flag the issue asks for, inverted so the
common (small) case stays absent from the JSON.

**Slice size: the first 40 lines, hard-capped at 16 KB** — whichever comes
first.

> **The justification below no longer holds. 40 is now a provisional bound, not
> a derived one.** It was derived from the transcript's inline previews — but
> the transcript no longer has any. `<ToolResult>` is rendered in exactly one
> production place, `message-tools.tsx:500`, which is *inside the click-opened
> modal*; the transcript itself draws a one-line summary built only from the
> tool's **input** (`command` truncated to 80 chars, `file_path`, `pattern`,
> `query`, `url`) plus a hover "Show output" button. No tool output is visible
> without a click. That means the 40 lines this ships are 40 lines nobody can
> see, which is precisely what req 1 forbids — see *Requirement 1 is not met*
> below. The number is retained as-is for now because changing it is a
> redesign, not a tuning exercise.

The line cap does the real work, and 40 was derived rather than picked: the
largest inline preview was Bash at 30 lines (`ToolResult.tsx:11–14`), so 40
covered every render path with headroom. A pure byte cap was the first proposal
and is worse: at 16 KB it transfers roughly eight times what is drawn, and a
page of 50 results still moves ~800 KB — which is exactly the outcome req 1
rules out.

The byte cap is a backstop for the case a line cap cannot bound: one
pathological line (minified JSON, a base64 blob) can be megabytes on its own.
It is the one place the design knowingly deviates from req 8 — a result whose
first 40 lines exceed 16 KB shows less inline than it does today. The
alternative, honouring 40 lines at any width, re-admits the unbounded payload
the feature exists to remove. Rare enough to accept, and the "Show all N lines"
button already there is the recovery path.

`SLICE_LINES` lives in shared code with a guard test asserting it is ≥ every
`*_MAX_LINES` in `ToolResult.tsx`, so a future render path that shows more
lines fails the build rather than silently rendering a short preview. That guard
is still meaningful, but its subject moved: those previews now render inside the
output modal rather than in the transcript.

## Requirement 1 is not met, and why that is recorded rather than fixed here

Req 1 is the completion criterion: *do not transfer information that is not
visible without a click.* As built, this feature ships the first 40 lines of
every ordinary tool result, and — since the UI change described above — **none
of those lines is visible until the user opens the modal.** So the feature
reduces the payload substantially while still failing its own headline
requirement.

The four things that *do* render result content without a click are exactly the
consumers req 4 names:

| What | Renders | Size |
|---|---|---|
| **`Task`** final report (`SubagentCall.tsx:132`) | full markdown, no expand affordance | can be large — already exempt |
| `AskUserQuestion` (`message-tools.tsx:137`) | the chosen answer, from result content | short |
| Present (`message-tools.tsx:171`) | `presentId` parsed from result content | short |
| `ExitPlanMode` (`message-tools.tsx:162`) | existence only, never content | none |

### The exemption set is wider than the renderer

`SUBAGENT_TOOL_NAMES` is `{Task, Skill, Agent}` and is used for two different
jobs: deciding which tools render as their own top-level element, and deciding
which results are exempt from every size bound. Only the first is true of all
three. **Only `Task` routes to `SubagentCall` and renders a final report**
(`MessageToolUse.tsx:41`); `Skill` and `Agent` fall to the branch below it,
which draws a label, a description and the prompt, and never touches result
content at all (`MessageToolUse.tsx:52`).

So `Skill` and `Agent` results are exempt from the server slice *and* from the
client cap while rendering nothing — meaning an arbitrarily large body is
transferred and then never shown. That is a strictly worse req-1 violation than
the documented 40-line slice, and it is not fixed here: splitting the set means
separating "renders as its own element" from "is a final report", which belongs
with the redesign rather than bolted onto it. Recorded in `checklist.md`.

So the correct shape is: carry **no** result content for anything outside that
list — only the metadata req 3 requires — and fetch the body when the modal
opens, exactly as `DiffBlock` already fetches when *its* modal opens. That
also retires the 16 KB byte backstop and the derived-slice guard for ordinary
results, since there would be no inline preview left to bound, and it needs the
fetch endpoint to substitute image URLs so the modal fetch does not simply
become the new heavy payload.

That is a redesign of the projection rather than a tuning change, and it landed
as a finding on an already long-lived branch, so it is deliberately **deferred
to a follow-up** and tracked in `checklist.md`. What ships here is a large byte
reduction with an honestly-documented requirement gap, not a claim that req 1 is
satisfied.

The cut lands on a UTF-8 character boundary so a preview never ends
mid-codepoint.

Exempt: Task-parent results (final report). Image-bearing results are **not**
exempt — see below.

### 2. Write/Edit inputs — store the stats, lazy body

Persist `added` / `removed` alongside the tool input and drop `content` /
`old_string` / `new_string` from the wire, replacing them with a `truncated`
marker. `DiffBlock` reads the stats from metadata instead of recomputing them,
and fetches the body when the user opens the modal — which is already an
explicit click with a loading state to hang a spinner on.

### 3. Images — serve by URL, no thumbnail

Replace the inline base64 with a URL to a content-addressed endpoint, and mark
the `<img>` `loading="lazy"`. No downscaling, no thumbnail, no new artifact to
store: the bytes stay exactly where they are today, and only the *wire format*
changes.

This is a deliberate reversal of the earlier "stored thumbnail" proposal, for
three reasons:

* **Downscaling tool-result images would be an unrecoverable quality loss.**
  They render at up to 256px (`max-h-64`) and have **no click-to-full-size
  affordance at all** (`ToolResult.tsx:242–255`) — unlike user-row images, there
  is no second view to load the full resolution into. A thumbnail there is
  simply a permanently worse screenshot, which req 8 forbids.
* **Req 9 permits reduced resolution; it does not require it.** The completion
  criterion is req 1 — do not transfer what is not visible without a click. A
  lazily-fetched URL satisfies that directly: an image scrolled off-screen
  transfers *nothing*, and an image on screen is, by definition, visible.
* **There is no image library in the tree** (no `sharp`, `jimp`, or `canvas`).
  Downscaling means a new native dependency in every session image — a real
  cost, and by the two points above it buys no requirement.

What the URL buys on its own: the transcript JSON stops carrying megabytes of
base64 (which also inflates the bytes by ~33%); off-screen images cost nothing;
on-screen ones load in parallel without blocking the transcript render; and
content-addressing means a screenshot that appears twenty times is fetched
once. The `<img>` boxes are fixed-size (`w-24 h-24`, `max-h-64`), so lazy
loading introduces no layout shift.

The client change is close to nothing: `MessageImages` already prefers
`img.src` over a `data:` URI (`message-media.tsx:41`), and the preview modal is
handed that same `src` — so one URL serves both the inline render and the
full-size view, with the browser cache making the second free. `data` becomes
optional on `ChatMessageImage`; `ToolResultImage` gains the same optional `src`.

If a future measurement shows on-screen image bytes still dominate, downscaling
can be added *behind the same URL* (`?w=192`) with no client change and no
change to what is stored. That is the reason to leave it out now rather than a
reason it is unnecessary forever.

Because image blocks are substituted rather than left intact, image-bearing
tool results no longer need the head-slice exemption they had in the earlier
draft — the base64 is gone before the slice is applied, so what remains is
ordinary text that slices safely and stays valid JSON.

### Fetch endpoints

* `GET /api/sessions/:id/tool-results/:toolUseId` → full result content
* `GET /api/sessions/:id/tool-inputs/:toolUseId` → full Write/Edit body
* `GET /api/sessions/:id/images/:hash` → the image, at its stored resolution

Lookup scans the session's `tool_results` / `tool_use` columns and, on a miss,
`subagent_events`.

The image hash is computed **at serve time**, over the base64 payload, during
the same projection that strips it. Nothing is persisted for it and nothing is
backfilled, so existing transcripts get the benefit on their next load. A hash
is also what lets images avoid the row id that SHI-267 was thought to need: it
addresses an image by what it *is* rather than where it sits, so it survives
rewind renumbering and dedupes a screenshot that appears in many rows.

Image responses are immutable by construction — the hash *is* the content — so
they carry `Cache-Control: immutable` and a matching `ETag`. Each distinct image
is fetched at most once per browser, which is what keeps the scan-based lookup
affordable; if profiling later says otherwise, a per-session `hash → row`
index is the fix, not a schema change.

A miss is not a state to design for. A chat rewind deletes rows
(`ChatHistoryManager.truncate`) and the client drops the same rows from the
transcript in the same handler (`rewind-complete.ts` →
`setMessages(prev.slice(0, gapPosition))`), so the expand affordance disappears
with the row; a code rewind only sets `rolled_back = 1` and deletes nothing, so
those rows keep both their affordance and their body. A visible row therefore
always has a fetchable body. The endpoint 404s and the client surfaces an
ordinary error, with no bespoke "no longer available" affordance.

### Where the projection happens — and where it must not

The slice is a **serve-path projection**. Full bodies stay in SQLite; no data
loss, and an existing transcript benefits immediately.

**It must not live in `ChatHistoryManager.fromRow`.** `fromRow` feeds six
read-modify-write paths (`chat-history.ts:630, 659, 686, 716, 745, 808` —
`updateLastMessage`, `updateBugReportCard`, `upsertReleaseCard`, and siblings)
that decode a row, mutate one field, and write the whole row back via `toRow`.
Slicing in `fromRow` would make every one of those silently persist the
truncation, permanently destroying the bodies this design is careful to keep.
This is the single most dangerous way to implement the feature and the reason
the projection is a separate function.

### Three projection sites, not one

Req 6 puts live turns, reconnects, *and* history loads inside the bound, and
those are three different code paths — only one of which reads through
`getChatHistory`:

| Path | Site | Top-level results / images | Tool inputs | Nested subagent results |
|---|---|---|---|---|
| History load, session switch | `getChatHistory` (`services/session.ts`) | stripped | stripped | stripped |
| Live turn | `projectAgentEventForWire` (`agent-listeners.ts`) | stripped | **inline** | **inline** |
| Reconnect mid-turn | `projectTurnSnapshotForWire` (`route-registry.ts`) | stripped | **inline** | **inline** |

The reconnect site is the easy one to miss: `turn_snapshot` is built from
`runner.chatMessageGroups` in memory, so it never touches the history read and
an early version of this feature re-sent on reconnect every megabyte the
history path had just removed.

### Why only the history path may strip everything

**A body may only leave the wire once the row holding it is committed** —
otherwise the fetch the client makes on click 404s, which breaks req 2. Exactly
one payload class is committed in the same tick as its emit:

* **Top-level tool results** are committed by `replaceInProgress` inside the
  `agent_tool_result` handler, synchronously before the frame reaches the
  network. Strippable everywhere.
* **User-row images** are persisted when the turn opens. Strippable everywhere.
* **Edit/Write inputs** arrive on an `agent_assistant` event, and nothing
  commits the row until the *next* tool-result boundary. The diff modal can be
  opened the instant the summary renders — i.e. exactly inside that window.
* **Nested subagent results** are the worst case: the `parentToolUseId` branch
  of the same handler calls `attachSubagentToolResults` and **returns**,
  skipping the `replaceInProgress` below it entirely. They reach disk only at
  the next *top-level* boundary, which for a long Task is many tool calls later.

So the last two are stripped on the history path only, where every row is on
disk by construction. This costs part of the live-path saving; it is the right
trade, because an unfetchable body is a visible failure and a fatter live frame
is not. The bytes accumulate across reloads, not within one turn.

**Rejected alternative: persist nested results before emitting them.** That
would make the guarantee true everywhere and keep the saving. But
`replaceInProgress` deletes and re-inserts *every row in the turn*,
re-serializing the whole `subagent_events` blob each time — so calling it per
nested result is quadratic in the number of subagent tool calls, and the blob it
keeps re-stringifying is made of exactly the heavy bodies this feature exists to
stop moving around. The cost lands hardest on Task-heavy turns, which is the
case the feature targets. Making persistence incremental would change the trade,
but that is `ChatHistoryManager` work, not this feature's.

This section has been wrong twice, the same way both times: a guarantee was
verified on one code path and then written up as general — first claiming the
same-tick commit covered `agent_assistant`, then claiming it covered nested
results. Both were caught by independent review, not by the tests. That failure
mode is the one `CLAUDE.md` calls out, and it is why the distinction is now a
required argument (`allRowsPersisted`) rather than a comment.

The projection always runs on a *copy* for the emit; the original event flows on
to `extractToolResults` and is persisted whole. The client's existing 1 MB cap
in `agent-event.ts` becomes redundant for sliced results but stays as a backstop
for the exempt classes.

### Transcript paths deliberately NOT projected

An independent review enumerated every server→browser message that can carry
transcript content. Beyond the three sites above, two carry a scoped heavy field
and are knowingly left alone in this pass — recorded here so the next reader
does not have to rediscover them:

* **`message_steered`** (`ws-handlers/send-message.ts`) echoes a live steer,
  including full base64 `images`. The row is persisted *before* the emit, so URL
  projection would be safe here — this is a gap, not a hazard.
* **`sub_agent_consult_card.outputMarkdown`** — a brokered `shipit agent run`
  result, shown as one preview line until clicked, but transferred whole.

Every other transcript-bearing message (the persisted card rows, user/error
rows, `fork_breadcrumb`, and the mutation-only messages) carries no field in
this feature's scope.

## Key files

Added by this feature:

* `src/server/shared/transcript-slice.ts` — `sliceBody`, `TRANSCRIPT_SLICE_LINES` (40), `TRANSCRIPT_SLICE_BYTES` (16 KB); UTF-8-safe, dependency-free so the client can import the constants
* `src/server/shared/transcript-slice-tools.ts` — `SUBAGENT_TOOL_NAMES`, the one exemption set, re-exported by `visual-elements.ts` so the renderer and the projection cannot disagree
* `src/server/orchestrator/transcript-projection.ts` — the serve-path projection: `projectMessagesForWire` (history), `projectAgentEventForWire` (live), `projectToolResult`, `projectToolUse`, `imageHash`
* `src/server/orchestrator/api-routes-lazy-bodies.ts` — the three fetch endpoints; scans top-level *and* `subagent_events`

Touched:

* `src/server/orchestrator/services/session.ts` — `getChatHistory`, the history projection site
* `src/server/orchestrator/ws-handlers/agent-listeners.ts` — live emit site; projects the wire copy only, `event` stays whole for persistence
* `src/server/orchestrator/route-registry.ts` — `turn_snapshot`, the reconnect projection site (req 6)
* `src/server/orchestrator/chat-history.ts` — `PersistedMessage`, `fromRow` (do not slice here)
* `src/server/orchestrator/ws-handlers/agent-event-normalizer.ts` — `extractToolResults`, the uncapped persist path
* `src/server/orchestrator/api-routes-session-spawn.ts:85` — `GET /api/sessions/:id/history`
* `src/client/components/ToolResult.tsx` — the four preview/expand render paths
* `src/client/components/DiffBlock.tsx` — the `+N -M` summary and the diff modal
* `src/client/components/message-media.tsx` — user-row image thumbnails
* `src/client/components/message-tools.tsx` — the constraint consumers
* `src/client/components/SubagentCall.tsx` — final report (exempt), nested tool results
* `src/client/hooks/message-handlers/agent-event.ts:122` — the client-side 1 MB cap

## Settled decisions

No open decisions remain; implementation is unblocked.

* **Slice size — first 40 lines, capped at 16 KB.** Derived from the largest
  inline preview (Bash, 30 lines) rather than picked as a byte budget, and
  guarded by a test against the client's `*_MAX_LINES`. The byte cap is a
  backstop for single pathological lines. Reasoning above under *1. Tool
  results*.
* **Thumbnail size — no thumbnail.** Images are served by URL at their stored
  resolution. Downscaling tool-result images would be permanent quality loss
  (they have no full-size view), req 9 permits reduction without requiring it,
  and no image library exists in the tree. Reasoning above under *3. Images*.
* **Thumbnail storage — no new store.** Falls away with the thumbnail. Image
  bytes stay in SQLite where they already are; only the wire format changes,
  and the hash is computed at serve time, so there is no migration, no
  backfill, and no new disk surface for the janitor (SHI-196) to own.

The through-line: each of the three resolutions removes mechanism rather than
adding it. The first replaced an arbitrary byte budget with a number derived
from what the UI drew *at the time*; the second and third delete a thumbnail
pipeline, a native dependency, and a storage decision by observing that the
requirement they were meant to serve is already met by not inlining the bytes.

The first of those has since expired — the UI it was derived from no longer
exists, so 40 is now a provisional number awaiting the redesign described under
*Requirement 1 is not met*. The second and third still hold.
