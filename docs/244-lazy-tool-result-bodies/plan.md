---
issue: planning#269
title: Lazy-load heavy chat-history row bodies
description: Keep what the transcript actually draws inline and fetch the rest on demand, so a history load transfers kilobytes instead of megabytes.
---

# Lazy-load heavy chat-history row bodies

Paging (planning#268, not yet built) bounds how many **rows** a transcript load
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

> **The shipped feature does not fully meet that criterion, and this section
> used to read as though it did** (correction from the independent review,
> 2026-08-04). Four things still transferred without a click: modal-only results
> at or under the 200-byte floor, ~~every tool input that is not Edit/Write~~
> (fixed, planning#298 — see *2. Tool inputs* below),
> ~~`sub_agent_consult_card.outputMarkdown`~~ (fixed, planning#299), and the
> full-resolution bytes behind each 96×96 image thumbnail. ~~The live and
> reconnect paths relax it further.~~ The reconnect path no longer relaxes it
> for the committed part of a turn (planning#299); the live path still does, and
> must. All are listed in `checklist.md` → *Known gaps*; the two that were
> undisclosed are planning#293 and planning#294. Two of the four are now closed; the
> criterion stands as the goal, and the claim that the design achieves it still
> does not.

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
| `tool_use` (everything else) | Whatever *that tool's* renderer draws — 80 chars of `command`, a `pattern`, a subagent's `description`; see *2. Tool inputs* | The rest of the input, in the tool-call modal or a disclosure |
| `images` (user rows) | A 96×96 thumbnail (`w-24 h-24 object-cover`, `message-media.tsx:53`) | Full-size preview |
| `subagent_events` | A `Disclosure` — "Subagent's work (N actions)" — open by default, containing ordinary tool calls | Per-step detail, via the same components |

So three mechanisms cover all four columns, and `subagent_events` needs no new
*component* of its own: its contents are rendered by the *same* components as
top-level tools, so fixing tool results and Write/Edit bodies covers its innards
for free. It did still carry unprojected payload — a collapsed subagent prompt
is a `Task` input, and non-Edit/Write inputs were not projected at all — so
"needs none of its own", as this sentence originally read, was too strong
(independent review, 2026-08-04). planning#298 closed that: the prompt is now
dropped and fetched on expand, and every tool's input goes through the policy
below. What remains on a subagent row is per-step text, which is small.

### The inline artifacts each mechanism must preserve

* **`totalLines`** — `truncateLines` computes the "Show all N lines" label from
  the whole body. A head slice must carry the true count or the button lies.
* **`added` / `removed`** — `DiffBlock` derives these via `countLines(newString)`
  and `countLines(oldString)`. Persist the two integers and the body can go
  lazy with no visible change at all.
* **The image itself, at today's resolution** — user-row images draw at 96×96
  (`message-media.tsx:53`) behind a click-to-full-size; tool-result images draw
  with **no click affordance at all**. `ChatMessageImage` already carries an
  optional `src?: string` (`MessageList/types.ts:59`), so a URL-backed path
  exists in the type today.

  Tool-result images used to carry a 256px height cap (`max-h-64`) on top of
  that. **They now carry no size bound at all** — natural size, scrolling
  sideways when wider than the modal. `ToolResult` renders only inside the
  tool-call modal, which is a click and already scrollable in both axes, so
  there was never a transcript to keep tidy; the cap simply reduced a 1280×720
  screenshot to an unreadable strip.

  Fitting the width (`max-w-full`) was the intermediate step and is also wrong,
  for a subtler reason worth keeping: **a resampled screenshot is
  indistinguishable from a faithful one**, so a reader squinting at a blurry
  control cannot tell whether the blur is in the page or in the render. A
  scrollbar answers that; a silent resample does not. `max-w-none` on the image
  is load-bearing — Tailwind preflight's `img { max-width: 100% }` would
  otherwise re-fit it and leave a scrollbar that never scrolls.

  The same argument then applies in the *other* direction, which "natural size"
  alone does not cover: these screenshots are 1× (headless Chromium runs at
  `deviceScaleFactor: 1`), so on a high-DPI display an image pixel laid out as a
  CSS pixel is smeared across `dpr²` physical ones — magnified, beside text the
  same display renders sharply. The fix is a `srcSet` density descriptor
  carrying the viewer's own ratio, which lays the image out at
  `naturalWidth / dpr` and lands each image pixel on exactly one physical pixel.
  Verified in Chromium rather than assumed, because the mechanism is easy to get
  backwards: **the descriptor sets the layout size outright**, it is not a hint
  weighed against the display (`srcset="X 2x"` halves X even at `dpr === 1`), and
  `src` naming the same URL neither overrides it nor costs a second request.
  `1.5x`, `3x` and a Windows-scaling `1.7647…x` all divide exactly. Two
  consequences: the descriptor must carry the *live* ratio, so
  `useDevicePixelRatio` re-arms its media query on every change instead of
  reading `devicePixelRatio` once — there is no fallback if it goes stale; and at
  `dpr === 1` the whole thing is a no-op. A base64 `data:` URL is safe in
  `srcset` (candidates split on commas that follow whitespace, and base64 has
  none) where a `utf8,<svg …>` one is not.

### One thing that must never be truncated

* **The subagent final report.** `findSubagentFinalReport` reads it from the
  *parent's* `toolResults` and renders it in full as markdown
  (`SubagentCall.tsx:50, 132`) with no expand affordance. Exempt by parent tool
  name (`SUBAGENT_TOOLS`).

The other three consumers the issue flags read values that *usually* fit inside
a slice — but `AskUserQuestion` is not bounded by its producer, and a free-form
answer over 16 KB is sliced with no modal and no fetch path to recover the tail
(planning#293). "All read short values" was an assumption about typical input, not a
property of the code (independent review, 2026-08-04): `AskUserQuestion`
(`resolvedAnswer={result?.content}`,
`message-tools.tsx:137`), `ExitPlanMode` (`resolved={!!result}`, `:162`), and
Present (`parsePresentToolResult`, `:171`).

## Verified facts

* The 1 MB cap is **client-side only** — `src/client/hooks/message-handlers/agent-event.ts:122`,
  on the live in-memory copy. It caps a **content-block array through its text**,
  never as a raw string — see *The client cap had the block-array bug too* below.
* The **persist path is uncapped**: `extractToolResults`
  (`ws-handlers/agent-event-normalizer.ts:15–31`) applies no size limit, and
  `chat-history.ts:489` stores `JSON.stringify(msg.toolResults)` verbatim.
* `PersistedMessage` carries **no row id** (`chat-history.ts:107`).

## The client cap had the block-array bug too

`projectBlockArray` exists because *"a block array must never be sliced as a raw
string"*: an MCP result is a `JSON.stringify`'d array of text and image blocks,
so it is **one line**, the line cap never fires, and a byte cut lands mid-array.
`parseContentForImages` then returns null and the tool-call modal draws the
payload — base64 and all — as a wall of raw JSON where the screenshot should be.

The serve path was fixed for that. The **client cap was not**, and it does the
same raw `content.slice(0, cap)`. It only bites the results the projection
deliberately leaves inline, which is exactly where the heaviest unstripped
screenshots are: a **nested subagent's**, since nothing strips it until its row
is committed. Reported from the field as a screenshot rendering as raw JSON,
reproduced by slicing a 1.4 MB block array at the cap.

`capContentBlocks` (`agent-event.ts`) now caps the **text inside the blocks** and
rebuilds the array, mirroring the serve path. Two consequences worth stating:

* **Image blocks are kept whole**, not counted against the budget. There is
  nothing to substitute them with here — the `/images/:hash` URL is backed by
  the persisted row, and a nested result has no committed row — so the choice is
  the image or nothing. The bound is recovered on the next history load, where
  the projection replaces the payload with that URL.
* **The `truncated` marker follows what was actually removed.** An image-only
  result loses nothing, so it is not marked; marking it would send the modal
  after a multi-megabyte body it already holds.

A body that is *not* a content-block array (a tool returning an ordinary JSON
array) still takes the raw cap unchanged. Guard tests:
`agent-event.test.ts` → *the cap never breaks an MCP content-block array*.

## And so did the lazy fetch — the third instance

Same bug class, third surface, reported from the field: opening the tool-call
modal on a `browser_take_screenshot` result drew the screenshot **and**, beneath
it, the whole `JSON.stringify`'d array with its base64 payload as the text panel.
Two independent defects, either sufficient on its own:

* **`/api/sessions/:id/tool-results/:toolUseId` served the stored bytes
  verbatim.** A caller reaches it because something wants the body's *text*; the
  images in it are already on screen, painted from `/images/:hash` out of that
  same row. So the endpoint re-sent every screenshot as base64 the moment a modal
  opened — the exact transfer this feature exists to remove, on the one path that
  had never been projected. It now applies `substituteResultImages`, the same
  function the report branch of `projectToolResult` already ran for the same
  reason.
* **`ToolResult` handed the previews a lazy body in the wrong units.**
  `useExpandable` prefers `lazy.full` over its `content` prop, and for a block
  array the two are different kinds of thing: `content` is the text
  `parseContentForImages` unwrapped out of the blocks, `lazy.full` is the raw
  array. The raw one won, so the fetched payload rendered as the text preview.
  `ToolResult` now substitutes `parsed.text` into the lazy body before passing it
  down.

The lesson the first two instances already taught, restated: **a content-block
array must be unwrapped before any text-shaped code touches it** — slicing,
capping, serving, or previewing. Guard tests: `lazy-transcript-bodies.test.ts` →
*substitutes images in the fetched tool-result body instead of re-sending
base64*; `ToolResult.test.tsx` → *draws the unwrapped text, not the raw block
array, once an image result's body arrives*.

Cross-backend review of that fix surfaced three more, two of them in code the
fix newly depended on:

* **`projectBlockArray`'s `keep` mode was collapsing text blocks.** It changes no
  text, so it had no business changing the array's shape either — but it emitted
  one text block regardless of mode. `parseSubagentReport` recognizes the CLI's
  accounting footer *only* as a separate final text block, so an image-bearing
  subagent report came back from the endpoint with its footer glued onto the
  prose: metadata rendered to the reader, header chips gone. Latent on the serve
  path before this (the report branch already called `substituteResultImages`);
  routing the fetch through the same function is what would have made it visible.
  `keep` now passes text blocks through untouched.
* **A failed body fetch on an image result was silent.** A projected screenshot is
  an emptied text block plus a URL-backed image, so `hasImages` carries it past
  both the loading and the error branch: the picture rendered and the body that
  never loaded left no trace. The miss is now reported beside the image rather
  than in place of it.
* **`capContentBlocks` measured `totalLines` in the wrong units** — over the
  serialized array rather than the text inside it. A stringified block array is
  one physical line, so a capped result advertised *"Show all 1 lines"* for a body
  of thousands. Same mismatch as the two above, one layer down.

## The planning#268 dependency is not real

planning#269 was sequenced after planning#268 "because it depends on `rowId` being on the
wire". Neither mechanism needs one:

* Tool results and Write/Edit inputs are addressed by `toolUseId`, already on
  the wire and — by assumption, not by anything this repo enforces — unique
  within a session (the endpoints return the first match; no collision has been
  observed in any current adapter, but nothing prevents one) — including results nested inside
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
`*_MAX_LINES` constant it **manually enumerates** from `ToolResult.tsx`. A
change to one of those four constants fails the build; a *new* render path that
reads result content elsewhere does not, because nothing enumerates it
automatically. The earlier wording here ("a future render path that shows more
lines fails the build") claimed a guarantee the test does not provide
(independent review, 2026-08-04). That guard
is still meaningful, but its subject moved: those previews now render inside the
output modal rather than in the transcript.

### 2. Tool inputs — a per-tool, per-key policy (planning#298)

The first implementation projected exactly two tool names, `Edit` and `Write`,
and `projectToolUse` opened with `if (!DIFF_INPUT_TOOLS.has(tool.name)) return
tool`. Everything else shipped whole: a 1 MB `Bash` command behind an 80-character
summary, a kilobyte `Task` prompt behind a *collapsed* disclosure, any MCP
argument object behind nothing at all. That is reqs 1 and 5 unmet for every tool
but two.

Edit/Write were easy for two reasons that do not generalise — the transcript
draws a *computed* summary (`+N -M`) that survives the body's removal, and there
was already a modal to fetch into. So the fix is not a wider tool set. It is a
policy answering, per tool **and per key**, "what does the transcript actually
draw from this?" — the input-side counterpart of
`rendersResultContentInline`.

`inputKeyTreatment(toolName, key, input)`
(`shared/transcript-input-policy.ts`) returns one of three treatments:

| Treatment | Meaning | Members |
|---|---|---|
| **`keep`** | drawn inline, in full, with no click | `file_path` / `pattern` / `query` / `url` (the one-line summary); the whole input of `AskUserQuestion`, `TodoWrite`, `apply_patch`; a subagent's `description`, `subagent_type`, `skill`, `args`; a `present` card's `title`; **a plan document's `content`** |
| **`head`** | drawn inline as a fixed-length prefix | `command`, and only `command` |
| **`drop`** | nothing draws it until a click | everything else — the tool-call modal is the only other reader, and opening it is the click |

Three things make this more than a list:

* **`head` is used exactly once, because it is only sound once.** The
  transcript's command summary is a literal `slice(0, 80)`. Shipping 80
  characters is *provably* invisible, because the client slices to the same
  number — `COMMAND_SUMMARY_CHARS` is imported by both ends rather than written
  twice. No other inline key has a bound in code: `pattern`, `query` and `url`
  are clipped by CSS, whose width depends on the viewport, so slicing them
  would mean guessing how much a wide screen shows. They are kept whole, the
  same trade `AskUserQuestion` makes on the result side.
* **A plan document's `content` is a `keep`, and finding that out fixed a live
  regression.** `findPlanContent` (`MessageList.tsx`) scans backwards for a
  `Write` whose path contains `.claude/plans/` and renders its body as markdown
  **inline in the transcript** (`PlanApproval`, `data-testid="plan-content"`) —
  no click, no fetch path. The blanket Edit/Write strip therefore blanked the
  plan card on every history load. `isPlanDocumentWrite` is shared by the
  projection and the reader so the two cannot drift again.
* **The 200-byte floor applies here too**, for the same reason it applies to
  results: replacing a 12-byte `timeout` with a `bodyTruncated` marker and an
  `inputChars` entry makes the payload larger *and* buys a round-trip. A
  consequence worth stating: a small Edit now keeps its strings, where before
  every Edit was stripped. `DiffBlock` recomputes byte-identical stats from the
  strings it still has, so nothing about the summary changes.

Two supporting pieces:

* **`inputChars`** — the original character length of each shortened or removed
  *string* key. It exists for one label: `SubagentCall`'s `Prompt (N chars)`
  toggle is drawn from a length the transcript no longer holds. Without it the
  disclosure would vanish entirely, which req 8 forbids.
* **`GET /api/sessions/:id/tool-inputs/:toolUseId` now returns the input
  verbatim** (`{ input }`) rather than the three Edit/Write fields it used to
  name. What a caller needs back depends on the tool, and the persisted row
  holds all of it. One client hook, `useLazyToolInput`, serves all three views
  that need it — the diff modal and the tool-call modal fetch on mount, the
  subagent prompt fetches on expand.

**Unchanged: when the projection is allowed to run.** Widening *what* the policy
covers did not widen *when* it applies. An input still only leaves the wire once
the row holding it is committed — on the history path always, and on the
reconnect snapshot for the ids planning#299's `committedBodyIds.toolInputs` records
as already written by a boundary. The live emit still ships every input whole,
because an `agent_assistant` row is not committed until the next tool-result
boundary. `projectToolUse` is called from behind those gates and knows nothing
about them, which is why the two changes composed without either having to
relax the other.

Deliberately not done, and recorded as a gap: `apply_patch`'s `changes` ships
whole. Its inline `+N -M` is derived from each change's `diff`, so deferring the
bodies needs per-change stats and a per-change fetch key — a second lazy
mechanism, for one backend's tool.

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


## The five browser-facing paths (planning#299)

The design named three projection sites. Two more carry transcript payload of
their own and reach the browser without passing through any of them — a
side-channel emit is exactly the shape that keeps slipping past this feature
(`CLAUDE.md`'s card-persistence contract has the same recurring failure). All
five are now projected, and the rule is the same everywhere: **a body may only
leave the wire once the row holding it is committed.**

| Path | What it carries | When the row lands |
|---|---|---|
| `getChatHistory` | everything | already on disk — read came from the DB |
| live `agent_event` | top-level tool results | same tick as the emit |
| `turn_snapshot` | the in-flight turn | partly on disk — see below |
| `message_steered` | the steered user row's images | before the emit, by ordering |
| `sub_agent_consult_card` | the consult's output | before the emit, by ordering |

### The snapshot's committed prefix

The snapshot is built from `runner.chatMessageGroups`, half of which a boundary
has already written. It used to take the conservative option for all of it and
re-send every committed tool input and nested subagent result on each reconnect.
`CommittedBodyIds` (`transcript-projection.ts`) records what each
`replaceInProgress` actually wrote, so only the genuinely in-memory tail stays
inline.

It is an **id set, not a "committed up to event N" cursor**, because groups are
mutated in place after they are persisted — `attachToolResultsToGroup`,
`attachSubagentToolResults`, and the standalone-merge branch of
`accumulateAssistantGroups` all append to a group a boundary already wrote. So a
group index cannot express "every body in here is on disk"; an id can. Inputs
and results are tracked in **separate** sets even though they share an id, since
a subagent's `tool_use` reaches disk at a boundary its result skips entirely.

The set is filled from the message list actually written, so it can only
under-report: a missed call site costs bytes, never a 404. Live nested subagent
results remain unprojected and correct — nothing has written them at emit time.

### The consult card

`projectConsultCardForWire` replaces `outputMarkdown` with the one-line preview
the card face draws and sets `outputTruncated`; the viewer fetches the rest.
`subAgentPreviewLine` is **shared with the client** rather than reimplemented —
the server now builds the line the client used to derive, and a byte-different
preview would change the card face on reload. The stored card stays whole, which
is what keeps planning#247's "the agent's copy and the user's copy are one artifact"
true: the preview is transport, not a second extraction.

## Key files

Added by this feature:

* `src/server/shared/transcript-slice.ts` — `sliceBody`, `TRANSCRIPT_SLICE_LINES` (40), `TRANSCRIPT_SLICE_BYTES` (16 KB); UTF-8-safe, dependency-free so the client can import the constants
* `src/server/shared/transcript-slice-tools.ts` — `SUBAGENT_TOOL_NAMES`, the one exemption set, re-exported by `visual-elements.ts` so the renderer and the projection cannot disagree
* `src/server/shared/transcript-input-policy.ts` — planning#298: `inputKeyTreatment`, `isPlanDocumentWrite`, `COMMAND_SUMMARY_CHARS`, `PLAN_DOC_PATH_MARKER`, `INPUT_STRIP_FLOOR_BYTES`. Imported by the client too, so the renderer's bounds and the projection's are the same numbers
* `src/server/orchestrator/transcript-projection.ts` — the serve-path projection: `projectMessagesForWire` (history), `projectAgentEventForWire` (live), `projectToolResult`, `projectToolUse`, `imageHash`
* `src/server/orchestrator/api-routes-lazy-bodies.ts` — the four fetch endpoints (results, inputs, images, sub-agent consults); scans top-level *and* `subagent_events`
* `src/client/hooks/useLazyToolInput.ts` — planning#298: the one fetch behind all three views that display a removed input key

Touched:

* `src/server/orchestrator/services/session.ts` — `getChatHistory`, the history projection site
* `src/server/orchestrator/ws-handlers/agent-listeners.ts` — live emit site; projects the wire copy only, `event` stays whole for persistence
* `src/server/orchestrator/route-registry.ts` — `turn_snapshot`, the reconnect projection site (req 6); passes `runner.committedBodyIds`
* `src/server/orchestrator/session-runner.ts` + `turn-accumulator.ts` — `committedBodyIds`, cleared by `resetRunnerTurnState` (planning#299)
* `src/server/orchestrator/chat-card-persistence.ts` — `persistTurnInProgress` marks what it wrote
* `src/server/orchestrator/services/sub-agent.ts` — the consult card: persist whole, emit projected (planning#299)
* `src/client/components/MessageList/cards/SubAgentCards.tsx` — fetch-on-open for the consult output
* `src/server/orchestrator/chat-history.ts` — `PersistedMessage`, `fromRow` (do not slice here)
* `src/server/orchestrator/ws-handlers/agent-event-normalizer.ts` — `extractToolResults`, the uncapped persist path
* `src/server/orchestrator/ws-handlers/send-message.ts` — the `message_steered` echo, projected in place (planning#299)
* `src/server/orchestrator/api-routes-session-spawn.ts:85` — `GET /api/sessions/:id/history`
* `src/client/components/ToolResult.tsx` — the four preview/expand render paths
* `src/client/components/DiffBlock.tsx` — the `+N -M` summary and the diff modal
* `src/client/components/message-media.tsx` — user-row image thumbnails
* `src/client/components/message-tools.tsx` — the constraint consumers
* `src/client/components/SubagentCall.tsx` — final report (exempt), nested tool results, the lazy prompt disclosure
* `src/client/components/MessageList/MessageList.tsx` — `findPlanContent`, the one inline reader of a `Write` body
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
  backfill, and no new disk surface for the janitor (planning#198) to own.

The through-line: each of the three resolutions removes mechanism rather than
adding it. The first replaced an arbitrary byte budget with a number derived
from what the UI drew *at the time*; the second and third delete a thumbnail
pipeline, a native dependency, and a storage decision by observing that the
requirement they were meant to serve is already met by not inlining the bytes.

The first of those has since expired — the UI it was derived from no longer
exists, so 40 is now a provisional number awaiting the redesign described under
*Requirement 1 is not met*. The second and third still hold.
