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
* **Req 9** — images may render inline at reduced resolution. This is what
  makes the thumbnail mechanism legal rather than a compromise.

Req 1 also fixes the completion criterion: *do not load information that is not
visible without a click*. There is no byte target to tune against.

## What the UI actually draws

The issue's premise is that the heavy columns "are not directly displayed in the
conversation UI — they sit behind a click". Checked against the render paths,
that is broadly right — but each column draws a small *derived* artifact inline,
and it is that artifact, not raw metadata, that has to stay on the wire.

| Column | What renders inline | What's behind a click |
|---|---|---|
| `tool_results` | First 15–30 lines (`ToolResult.tsx`: Bash 30, Read 20, Grep 20, generic 15) + a "Show all N lines" button | The tail |
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
* **A real thumbnail** — the UI is already thumbnail-shaped; it just draws the
  96px image from full-resolution base64. `ChatMessageImage` already carries an
  optional `src?: string` (`MessageList/types.ts:59`), so a URL-backed path
  exists in the type today.

### Two things that must never be truncated

* **Image-bearing tool results.** MCP image results (Playwright screenshots) are
  persisted as `JSON.stringify(content)` — a JSON array of text and base64 image
  blocks. `parseContentForImages` needs the whole array; a head slice is
  unparseable JSON, so the image silently degrades to raw JSON text. These get
  the thumbnail treatment instead of the slice treatment.
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

**Slice size: 16 KB**, a byte cap rather than a line cap — the goal is bounding
payload, and one pathological line is as heavy as a thousand. Two orders of
magnitude below the 1 MB case, and far above anything drawn inline (30 lines of
Bash output is ~2 KB) or read by the constraint consumers. The cut lands on a
UTF-8 character boundary, preferring the last newline within the final 10% of
the slice so a preview never ends mid-codepoint or mid-line.

Exempt: image-bearing results, and Task-parent results (final report).

### 2. Write/Edit inputs — store the stats, lazy body

Persist `added` / `removed` alongside the tool input and drop `content` /
`old_string` / `new_string` from the wire, replacing them with a `truncated`
marker. `DiffBlock` reads the stats from metadata instead of recomputing them,
and fetches the body when the user opens the modal — which is already an
explicit click with a loading state to hang a spinner on.

### 3. Images — stored thumbnail, lazy full-res

Store a downscaled thumbnail (192px longest edge, so 96×96 stays crisp on
2× displays) content-addressed by hash, and put its URL in the existing `src`
field. The full-resolution bytes stay in the row and are fetched only when the
preview modal opens.

This applies to both user-row images and image-bearing tool results, which is
what lets those results skip the head-slice mechanism safely.

### Fetch endpoints

* `GET /api/sessions/:id/tool-results/:toolUseId` → full result content
* `GET /api/sessions/:id/tool-inputs/:toolUseId` → full Write/Edit body
* `GET /api/sessions/:id/images/:hash` → full-resolution image

Lookup scans the session's `tool_results` / `tool_use` columns and, on a miss,
`subagent_events`.

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

### Live path

The same projection applies to the live WS path as well as history loads, so the
client has one code path and the per-turn event replay buffer gets lighter too.
The client's existing 1 MB cap in `agent-event.ts` becomes redundant for sliced
results but stays as a backstop for the exempt classes.

Thumbnail generation happens once, at persist time, off the turn's critical
path.

## Key files

* `src/server/orchestrator/chat-history.ts` — `PersistedMessage`, `fromRow` (do not slice here)
* `src/server/orchestrator/ws-handlers/agent-event-normalizer.ts` — `extractToolResults`, the uncapped persist path
* `src/server/orchestrator/api-routes-session-spawn.ts:85` — `GET /api/sessions/:id/history`
* `src/client/components/ToolResult.tsx` — the four preview/expand render paths
* `src/client/components/DiffBlock.tsx` — the `+N -M` summary and the diff modal
* `src/client/components/message-media.tsx` — user-row image thumbnails
* `src/client/components/message-tools.tsx` — the constraint consumers
* `src/client/components/SubagentCall.tsx` — final report (exempt), nested tool results
* `src/client/hooks/message-handlers/agent-event.ts:122` — the client-side 1 MB cap

## Open decisions

* Slice size: 16 KB proposed.
* Thumbnail size: 192px longest edge proposed.
* Whether thumbnails are stored in SQLite alongside the row or on disk keyed by
  hash. Disk keeps the DB small; SQLite keeps teardown simple.
