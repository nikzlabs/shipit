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
> true than this analysis concluded. The projection now acts on that: a result
> nothing draws inline ships no body at all. See *How requirement 1 is met*
> below; the rest of the table still holds.

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

### 1. Tool results — no body for anything modal-only

Each tool result gains three fields:

```ts
{
  toolUseId: string;
  content: string;      // "" when nothing draws it inline; a head slice for the
                        // unknown-tool fallback; else the whole body
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
> see, which is precisely what req 1 forbids. That is fixed: an ordinary result
> now ships no body at all, and the number below governs only the unknown-tool
> fallback and image-result text. See *How requirement 1 is met* below.

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

## How requirement 1 is met

Req 1 is the completion criterion: *do not transfer information that is not
visible without a click.* The first implementation did **not** meet it, and said
so. It shipped the first 40 lines of every ordinary tool result — a number
derived from the inline previews in `ToolResult.tsx` — but `ToolResult` renders
only inside `ToolCallModal`. The transcript line is built from the tool's
*input*. So those 40 lines were 40 lines of something nobody sees.

The fix is the shape that section predicted: carry **no** result content for
anything the transcript doesn't draw, and let the modal fetch the body when it
opens. `rendersResultContentInline` (`shared/transcript-slice-tools.ts`) is the
predicate, and there are exactly three inline readers, each pinned to its call
site by a guard test:

| What | Renders | Treatment |
|---|---|---|
| `SUBAGENT_REPORT_TOOL_NAMES` (`Task`, `Agent`) | the final report, full markdown, no expand affordance (`SubagentCall.tsx:132`) | exempt from every bound |
| `AskUserQuestion` | the chosen answer, from result content (`message-tools.tsx:149`) | body kept (short) |
| the `present` tool, any name form | `presentId` parsed from the result (`message-tools.tsx:370`) | body kept (short) |
| **everything else** | nothing, until the modal opens | **body emptied**; metadata only |

`ExitPlanMode` is deliberately not in the list: it reads `resolved={!!result}`,
existence rather than content, which survives an emptied body.

### Two deliberate deviations

* **A floor** (`RESULT_STRIP_FLOOR_BYTES`, 200 bytes). Stripping replaces a body
  with `truncated` + `totalLines` + `totalBytes` — about 60 bytes of JSON — so
  for a result like `"ok"` it makes the payload *larger* and buys a round-trip
  to fetch two characters. Below the floor the body stays. At 200 bytes even 50
  short results carry under 10 KB, which is noise against the megabytes removed.
* **Image URLs stay.** An image-bearing result has its text emptied but keeps
  its substituted image URLs (~100 bytes each), so the screenshot paints as soon
  as the modal opens instead of blanking until the fetch lands.

### What the slice is still for

The 40-line slice and its 16 KB backstop are no longer what bounds an ordinary
result — that body is now simply absent. They still govern two cases:

* a result whose **tool name can't be resolved** from the message's tool_use
  blocks. An unknown name might be one of the three above, so the conservative
  answer is to ship a bounded body rather than blank a card that has no fetch
  path behind it;
* the **text inside an image-bearing result** on the paths that slice rather
  than empty.

So the derived-cap guard test still holds, and still fails the build if a
preview grows past the slice.

### The exemption set, resolved

An earlier revision flagged a second, wider instance: `SUBAGENT_TOOL_NAMES` is
`{Task, Skill, Agent}` and was used both for layout and for the size exemption,
so `Skill` and `Agent` results were exempt from every bound while rendering
nothing. That split landed separately: `SUBAGENT_REPORT_TOOL_NAMES` (`Task`,
`Agent`) is the exemption, `SUBAGENT_TOOL_NAMES` stays the layout set, and
`Skill` — which emits a ~33-character acknowledgement and no report — now goes
through the ordinary bound. With this change it goes further and ships no body
at all, since nothing renders its result content either.


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
