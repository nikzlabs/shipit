---
issue: https://linear.app/shipit-ai/issue/SHI-267
title: Lazy-load heavy tool-result bodies
description: Send a head slice of tool-result content on the wire and fetch the full body on expand, keyed by toolUseId.
---

# Lazy-load heavy tool-result bodies

Paging (SHI-266, not yet built) bounds how many **rows** a transcript load
transfers. It does not bound **bytes**: a window of ten turns containing several
near-1 MB tool outputs is still a heavy payload. This feature bounds the bytes.

## Requirement provenance

Stated by the issue (UX-level): loading a transcript should not transfer
megabytes of tool output the user will never look at.

Everything below is inferred mechanism. In particular the issue's proposed
shape — "keep per-result metadata inline and fetch bodies on demand" — does not
survive contact with the render code, for the reasons in the next section. The
design here is narrower than the issue proposes.

## What the issue assumed, and what the code actually does

The issue's premise is that the heavy columns "are not directly displayed in the
conversation UI — they sit behind a click". Verified against the render paths,
that is true of **one** column and false of the rest.

| Column | Issue's claim | Verified behavior |
|---|---|---|
| `tool_results` | behind a click | **Partly true.** `ToolResult.tsx` renders an inline preview of the first 15–30 lines on every path (Bash 30, Read 20, Grep 20, generic 15). Only the tail is behind "Show all N lines". |
| `tool_use` | behind a click | **False.** `Write`'s full `input.content` and `Edit`'s `old_string`/`new_string` render immediately as a `DiffBlock` (`message-tools.tsx:78–99`). No click. |
| `subagent_events` | behind a click | **False.** `SubagentCall` keeps the work timeline **expanded by default**, deliberately — `SubagentCall.tsx:53–57` documents the previous auto-collapse as a bug that hid the subagent's work. |
| `images` | behind a click | **False.** User-row images render inline via `message-media.tsx`; tool-result images render inline via `ToolResultImages`. |

Two further constraints the render code imposes:

* **The "Show all N lines" label needs the full line count.** `truncateLines`
  computes `totalLines` from the whole body. A head slice must therefore carry
  the true line count as metadata, or the button lies.
* **`parseContentForImages` needs the whole body.** MCP image results (e.g.
  Playwright screenshots) are persisted as `JSON.stringify(content)` — a JSON
  array of text and base64 image blocks. A head slice of a JSON array is
  unparseable, so the images silently vanish and the result renders as raw JSON.

The four consumers the issue flags as reading result *content* or *existence*
are all confirmed, and all read short values that fit comfortably inside a
generous head slice:

* `AskUserQuestion` — `resolvedAnswer={result?.content}` (`message-tools.tsx:137`)
* `ExitPlanMode` — `resolved={!!result}` (`message-tools.tsx:162`)
* Present — `parsePresentToolResult(tool, result)` (`message-tools.tsx:171`)
* Subagent final report — `findSubagentFinalReport(tool.id, parentToolResults)`
  (`SubagentCall.tsx:50`), rendered **in full** as markdown at
  `SubagentCall.tsx:132`. This one is *not* bounded and must be exempt.

## Verified facts

* The 1 MB cap is **client-side only** — `src/client/hooks/message-handlers/agent-event.ts:122`,
  on the live in-memory copy.
* The **persist path is uncapped**: `extractToolResults`
  (`ws-handlers/agent-event-normalizer.ts:15–31`) applies no size limit, and
  `chat-history.ts:489` stores `JSON.stringify(msg.toolResults)` verbatim. So
  the issue's claim that the persisted copy is uncapped holds.
* `PersistedMessage` carries **no row id** (`chat-history.ts:107`). The wire has
  no `rowId` today.

## The SHI-266 dependency is weaker than the issue states

SHI-267 was sequenced after SHI-266 "because it depends on `rowId` being on the
wire". That is only true for the `images` column, which this design scopes out.

`toolUseId` is a unique key within a session and is already on the wire. It
addresses tool results wherever they appear — top-level `tool_results` and the
results nested inside `subagent_events` (which carry their own `toolUseId`s, see
`collectToolResults`, `SubagentCall.tsx:248`). So the mechanism below needs no
`rowId` and **does not depend on SHI-266**. The two can ship in either order.

## Design

One mechanism, applied to one column.

**Serve a head slice of `tool_results[].content`; fetch the full body on
expand, keyed by `{sessionId, toolUseId}`.**

### Wire shape

Each tool result gains three metadata fields alongside the existing
`toolUseId` / `content` / `isError` / `durationMs`:

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

### Slice size

A byte cap, not a line cap — the goal is bounding payload, and one pathological
line is as heavy as a thousand. **16 KB** is the proposed default: two orders of
magnitude below the 1 MB case the issue names, and far above anything the UI
renders inline (30 lines of Bash output is ~2 KB) or that any of the four
constraint consumers reads.

The slice is cut on a UTF-8 character boundary and, where one exists within the
last 10% of the slice, at the last newline — so the preview never ends
mid-codepoint or mid-line.

### Exemptions

Two result classes must never be sliced, both detectable server-side:

1. **Image-bearing results** — `content` starts with `[` and parses to an array
   containing a `type: "image"` block. Slicing breaks `parseContentForImages`.
   These are heavy, which is unfortunate, but correctness wins; bounding them is
   a separate problem (see Deferred).
2. **Task/subagent parent results** — the final report renders in full with no
   expand affordance. Exempt by parent tool name (`SUBAGENT_TOOLS`).

### Where the slice happens — and where it must not

The slice is a **serve-path projection**, applied where history is sent to the
client. The full body stays in SQLite; no migration, no data loss, and an old
transcript benefits immediately.

**It must not live in `ChatHistoryManager.fromRow`.** `fromRow` feeds six
read-modify-write paths (`chat-history.ts:630, 659, 686, 716, 745, 808` —
`updateLastMessage`, `updateBugReportCard`, `upsertReleaseCard`, and siblings)
that decode a row, mutate one field, and write the whole row back via `toRow`.
Slicing in `fromRow` would make every one of those silently persist the
truncation, permanently destroying the bodies this design is careful to keep.
This is the single most dangerous way to implement the feature and the reason
the projection is a separate function.

### Fetch endpoint

`GET /api/sessions/:id/tool-results/:toolUseId` → `{ content, isError, truncated: false }`.

Lookup scans the session's `tool_results` column and, on a miss, the
`subagent_events` column. If the row is gone (rewind truncated the tail) the
endpoint 404s and the client renders "output is no longer available" in place of
the expanded body rather than failing the expand.

### Client

`ToolResult.tsx`'s four render paths already share the same
preview/expand/`totalLines` structure. The change is one hook — on expand, if
`result.truncated`, fetch the body and swap it in; show a spinner in the
expanded region meanwhile. `totalLines` comes from the metadata instead of
`truncateLines` when the content is a slice.

### Live path

The live WS path applies the same projection, so the client has one code path
and the per-turn event buffer gets lighter too. The client's existing 1 MB cap
in `agent-event.ts` becomes redundant for sliced results but is harmless and
stays as a backstop for the exempt classes.

## Deferred, with reasons

Scoped out because each renders inline with no click, so lazy-loading trades
bytes for visible pop-in on every transcript load — and none is the near-1 MB
case the issue names:

* **`tool_use` input** — bounded by the size of the file the agent wrote, and
  rendered as a diff the user reads. Making a `Write` diff pop in after a fetch
  is a real UX regression for a modest byte saving.
* **`subagent_events`** — expanded by default by deliberate design.
* **`images` on user rows** — the genuinely unsolved one. Base64 in a text
  column is the wrong storage; the fix is content-addressed blob storage with
  the row holding a reference, not a lazy fetch of an inline blob. This is also
  the only piece that would need `rowId`, hence the only real SHI-266
  dependency. Worth its own issue.
* **Image-bearing tool results** — same underlying problem as above.

## Key files

* `src/server/orchestrator/chat-history.ts` — `PersistedMessage.toolResults`, `fromRow` (do not slice here)
* `src/server/orchestrator/ws-handlers/agent-event-normalizer.ts` — `extractToolResults`, the uncapped persist path
* `src/server/orchestrator/api-routes-session-spawn.ts:85` — `GET /api/sessions/:id/history`
* `src/client/components/ToolResult.tsx` — the four preview/expand render paths
* `src/client/components/message-tools.tsx` — the four constraint consumers
* `src/client/components/SubagentCall.tsx` — final report (exempt), nested tool results
* `src/client/hooks/message-handlers/agent-event.ts:122` — the client-side 1 MB cap

## Open decisions

* Slice size: 16 KB proposed, not confirmed.
* Whether to apply the projection to the live WS path as well as history, or
  history only.
