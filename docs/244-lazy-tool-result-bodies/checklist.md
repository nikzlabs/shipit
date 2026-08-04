# Lazy row bodies — checklist

> Under requirements discipline — see `requirements.md`. No open questions and
> no open design decisions remain.

## Requirements
- [x] Draft `requirements.md` from the issue and the chat
- [x] Resolve: is zero visible change a hard requirement? → req 8
- [x] Resolve: may images display at reduced resolution until clicked? → req 9
- [x] Resolve: what shows when a body is no longer fetchable? → false premise, no requirement
- [x] Resolve: is there a target transferred size? → folded into req 1

## Design
- [x] Verify what each column actually draws inline vs. behind a click
- [x] Confirm the constraint consumers (AskUserQuestion, ExitPlanMode, Present, subagent report)
- [x] Confirm persist path is uncapped and the 1 MB cap is client-only
- [x] Determine whether the SHI-266 / `rowId` dependency is real (it isn't)
- [x] Decide: project the live WS path as well as history
- [x] Confirm slice size → 40 lines, capped at 16 KB (derived from Bash's 30). That derivation expired when the previews moved into the modal; the slice now governs only the unknown-tool fallback and image-result text — see *Requirement 1 — met* below.
- [x] Confirm thumbnail size → no thumbnail; serve at stored resolution
- [x] Decide thumbnail storage → no new store; bytes stay in SQLite

## Server — tool results
- [x] Add `truncated` / `totalLines` / `totalBytes` to the tool-result type
- [x] Shared `SLICE_LINES` constant (40) + 16 KB byte backstop, UTF-8 safe
- [x] Serve-path slice projection, separate from `fromRow`
- [x] Exempt Task-parent results (final report)
- [x] Substitute image blocks *before* slicing, so image results need no exemption
- [x] `GET /api/sessions/:id/tool-results/:toolUseId`

## Server — Write/Edit inputs
- [x] Persist `added` / `removed` line stats
- [x] Strip body from the wire behind a `truncated` marker
- [x] `GET /api/sessions/:id/tool-inputs/:toolUseId`

## Server — every other tool input (SHI-296)
- [x] Per-tool, per-key policy (`inputKeyTreatment`, `shared/transcript-input-policy.ts`) rather than a second hardcoded tool set — the input-side counterpart of `rendersResultContentInline`
- [x] `keep` for the keys the one-line summary draws (`file_path`, `pattern`, `query`, `url`), for the tools that render their whole input as the card itself (`AskUserQuestion`, `TodoWrite`, `apply_patch`), for a subagent's `description`/`subagent_type`/`skill`/`args`, and for a `present` card's `title`
- [x] `head` for `command` — 80 characters, the number `message-tools.tsx` slices to. Imported, not restated, so the deletion is provably invisible
- [x] `drop` for everything else, which is exactly what the tool-call modal alone displays
- [x] **`keep` for a plan document's `content`** — `findPlanContent` renders a `.claude/plans/` Write body inline via `PlanApproval`, with no click and no fetch path, so the blanket Edit/Write strip had been blanking the plan card on every history load. `isPlanDocumentWrite` is shared with the reader
- [x] `inputChars` — the original length of each shortened/removed string key, so `SubagentCall`'s `Prompt (N chars)` toggle keeps its label
- [x] 200-byte floor, same reasoning as the result floor. Consequence: a small Edit now keeps its strings; `DiffBlock` recomputes identical stats from them
- [x] `GET …/tool-inputs/:toolUseId` returns the input verbatim (`{ input }`) rather than the three Edit/Write fields — what a caller needs back depends on the tool
- [x] Unchanged: *when* the projection may run. An input still only leaves the wire once its row is committed — always on the history path, and on the reconnect snapshot for the ids SHI-297's `committedBodyIds.toolInputs` records. The live emit still ships inputs whole, because an `agent_assistant` row is not committed until the next tool-result boundary. `projectToolUse` sits behind those gates and knows nothing about them

## Client — every other tool input (SHI-296)
- [x] `useLazyToolInput` — one keyed fetch shared by the diff modal, the tool-call modal and the subagent prompt; `DiffBlock` migrated onto it
- [x] Tool-call modal fetches on mount and renders the recovered keys; keeps the fields it already has and shows "Loading input…" rather than blanking, and surfaces a failed fetch
- [x] Subagent prompt disclosure renders from `inputChars` while collapsed and fetches on expand (the expand is the click req 8 licenses a loading state for)
- [x] `message-tools.tsx` imports `COMMAND_SUMMARY_CHARS` instead of its literal `80`; `findPlanContent` imports `isPlanDocumentWrite`

## Server — images
- [x] Hash + strip base64 in the projection; populate `src` with the URL
- [x] `GET /api/sessions/:id/images/:hash`, `Cache-Control: immutable` + `ETag`
- [x] Apply to image-bearing tool results as well as user rows

## Client
- [x] Fetch-on-mount in `ToolResult.tsx` (the modal open is the click); "Loading output…" while in flight, error line on failure
- [x] `totalLines` from metadata for the "Show all N lines" label
- [x] `DiffBlock` reads stats from metadata; fetches body when the modal opens
- [x] `data` optional on `ChatMessageImage`; `src` added to `ToolResultImage`
- [x] `loading="lazy"` on both image render paths
- [x] Ordinary error surfaced on a 404

## Tests
- [x] Slice boundary: UTF-8 safety, 40-line cut, 16 KB backstop on a long line
- [x] Guard: `SLICE_LINES` ≥ every `*_MAX_LINES` in `ToolResult.tsx`
- [x] Image-bearing result still parses via `parseContentForImages` after substitution
- [x] Exemption: subagent final report stays whole
- [x] Diff stats match `countLines` on the full body
- [x] Regression guard: `updateLastMessage` (a real `fromRow` read-modify-write updater) does **not** write back a sliced body
- [x] Endpoints: hit, subagent-nested hit, 404 on unknown id
- [x] Same image in two rows resolves to one hash (dedupe)
- [x] Constraint consumers still resolve from a sliced result (req 4)
- [x] Rewind invariant: after a chat rewind the client holds no row whose body was deleted
- [x] Req 1: a >1 MB stored transcript serves a small fraction of its size, with none of the three heavy bodies present *at all* — while the exempt subagent report still ships whole (distinct fixture bodies, so the assertion discriminates)
- [x] Drift guard: `rendersResultContentInline` pinned per call site — the three inline readers true, ordinary tools / `ExitPlanMode` / `Skill` false, unknown name true

## Review fixes (round 1)
- [x] Project the reconnect `turn_snapshot` — third browser-facing path, was bypassing the projection entirely (req 6)
- [x] Stop stripping Edit/Write bodies on the live path; their row isn't committed until the next tool-result boundary, so the diff modal could 404 (req 2)
- [x] Correct the same-tick persistence claim in code comment, `plan.md`, and the PR body — it holds for tool results only

## Review fixes (round 2)
- [x] Stop stripping **nested subagent results** on the live emit and the snapshot — their handler branch returns before `replaceInProgress`, so they reach disk only at the next top-level boundary (req 2)
- [x] Collapse both exceptions into one `allRowsPersisted` flag expressing the actual invariant, rather than two ad-hoc opt-outs
- [x] Image endpoint: check the hash resolves *before* honouring `If-None-Match`, so a nonexistent image 404s instead of 304-ing
- [x] Add the read-modify-write guard that the checklist previously claimed but no test performed
- [x] Correct the module header ("two places" → three) and document the two knowingly-unprojected paths (`message_steered`, `sub_agent_consult_card`)

## Review fixes (round 3)
- [x] Client 1 MB cap sets `truncated` + the true `totalLines` for an **ordinary** result, so a capped body gets the expand-and-fetch affordance instead of being silently cut (req 3/4). Cut is surrogate-safe; `totalBytes` deliberately left to the server, which measures UTF-8 rather than UTF-16 units.
- [x] **Correction to the line above, from round 3's review:** the first version of that fix applied to *every* result, which was wrong twice over — it still clipped subagent final reports (which `SubagentCall` renders whole, with no expand affordance, so the marker did nothing), and it advertised a fetch for nested results whose row is not committed yet. Now: a final report is never capped; a nested result is capped but not marked; only an ordinary result is capped and marked. The test for the original fix used a `Task` tool, so it had codified the very violation it should have caught.
- [x] Image lookup pre-filtered on the literal text `"base64"`, which the projection never requires — an MCP image block carrying `source.data` without `source.type` got an `/images/:hash` URL that then 404'd forever. Keyed on the block type instead.

## Review fixes (round 4)
- [x] **Inner Task final reports were still being capped.** A subagent can spawn a subagent, and the inner `Task`'s `tool_use` lands in `subagentEvents`, not `message.toolUse` — so `toolNameForResult` returned `undefined` and its final report took the ordinary nested branch and got clipped. The round-3 nested test never recorded an inner tool use, so it passed the whole time. Lookup now searches nested assistant events; both the inner-Task and inner-ordinary cases are pinned.
- [x] **Image lookup pre-filter removed entirely.** Two lexical filters have now been wrong (`includes("base64")`, then `includes("\"image\"")` — which misses `"image"`, valid JSON parsing to the same block). A lexical test can never equal the projection's semantic one, so there is no content pre-filter left: only the structural `startsWith("[")`, then parse and ask the same question.
- [x] Fixed a test asserting against `message.content` on a live assistant event — the adapter normalizes that to `content` on the event itself, so the test asserted "unchanged" about a shape the projection never reads.
- [x] Doc corrections: `plan.md` no longer calls 40 "derived" in one place while calling it provisional in another; the modal is described as showing a slice then the full body behind its own expand, not "the whole body".

## Requirement 1 — met
- [x] **Carry no result content for anything the transcript doesn't draw.** `rendersResultContentInline` is the predicate; a modal-only result now ships `content: ""` plus the metadata req 3 names, and `ToolResult` fetches the body when the modal mounts (the mount IS the click req 8 licenses a loading state for).
- [x] The three inline readers keep their bodies, each pinned to its call site by a guard test: `SUBAGENT_REPORT_TOOL_NAMES` (exempt), `AskUserQuestion` (chosen answer), the `present` tool (artifact id). `ExitPlanMode` reads existence only, so it needs nothing.
- [x] **Floor at 200 bytes** (`RESULT_STRIP_FLOOR_BYTES`) — below it, stripping costs more markers than it saves and buys a round-trip for a few characters.
- [x] Image-bearing results keep their substituted URLs and lose only their text, so the screenshot paints on modal open instead of blanking until the fetch lands.
- [x] The 16 KB backstop and the `TRANSCRIPT_SLICE_LINES` ≥ `*_MAX_LINES` guard stay meaningful: they now bound the unknown-tool fallback and image-result text rather than ordinary results.
- [x] **`Skill` and `Agent`** — resolved. `SUBAGENT_REPORT_TOOL_NAMES` (`Task`, `Agent`) is the exemption and `SUBAGENT_TOOL_NAMES` stays the layout set; `Skill` renders no result content, so it now ships none.

## Known gaps (recorded, not addressed in this PR)

> Requirement attributions below were corrected by the independent review — see
> *Independent requirements review* at the end. Several gaps were filed against
> one requirement while breaking others, and one entry was stale.

- [x] ~~Req 5 says "tool inputs"; only Edit/Write are projected, other tool inputs ship whole. **Also req 1**: a 1 MB Bash command ships whole while the transcript shows its first 80 characters, and a `Task` prompt ships whole while sitting behind a collapsed disclosure.~~ — **fixed (SHI-296).** Replaced with a per-tool, per-key policy; see *Server/Client — every other tool input* above and `plan.md` → *2. Tool inputs*. Fixing it also surfaced a live regression the original gap had not named: a `.claude/plans/` `Write` body **is** drawn inline (`findPlanContent` → `PlanApproval`), so the blanket Edit/Write strip had been blanking the plan card on every history load.
- [ ] `apply_patch`'s `changes` still ships whole (reqs 1/5). Its inline `+N -M` is derived from each change's `diff`, so deferring the bodies needs per-change stats and a per-change fetch key — a second lazy mechanism, for one backend's tool. Kept as a `keep` rather than half-done.
- [ ] `pattern` / `query` / `url` / `AskUserQuestion.questions` are kept whole however long (req 1). They render inline with no bound in code — the one-liner clips them with CSS, whose width depends on the viewport — so any slice would be a guess at what a wide screen shows. Tens of bytes in practice.
- [x] ~~Byte backstop on a single long line removes text that used to render inline, and labels it "Show all 1 lines" (reqs 1/8)~~ — **stale, withdrawn.** Written when the previews were in the transcript. `ToolResult` now renders only inside the click-opened `ToolOutputModal`, where req 8 expressly permits loading, so this is no longer a transcript-level finding.
- [x] ~~A >16 KB free-form AskUserQuestion answer would be sliced (req 4)~~ — **fixed (SHI-291).** It broke reqs 2 and 8 as well as 4: the Ask branch returns before the output modal, so the tail was unreachable rather than deferred, and the Ask card *is* the transcript. `WHOLE_RESULT_TOOL_NAMES` is now the set every bound agrees on — the server's 16 KB backstop and the client's 1 MB cap both read it. That also fixed a second, opposite error the review had not named: the client cap keyed off `SUBAGENT_TOOLS`, the *layout* set, so it spared `Skill` (no report, fetchable) while capping `AskUserQuestion` (no recovery).
- [ ] A modal-only result at or under `RESULT_STRIP_FLOOR_BYTES` (200) ships whole though nothing renders it without a click (req 1) — **undisclosed until the review**. Recorded here as the deviation it is; the floor itself stays deliberate.
- [x] ~~Inline image thumbnails point at the full-resolution URL, so the bytes transfer on viewport entry rather than on click (reqs 1 and 9)~~ — **accepted, not fixed (SHI-292).** Human decision, 2026-08-04: images are infrequent enough that transferring them with the transcript is fine. Requirement 9 amended to say so, with a dated receipt in `requirements.md`. One open question remains there on the wording — whether the stated 256×256 is a bound on transferred pixels (needing server-side downsampling, and a new dependency) or a description of the inline render size.
- [x] ~~`message_steered` echoes full base64 images unprojected~~ — **fixed (SHI-297).**
- [x] ~~`sub_agent_consult_card.outputMarkdown` is modal-only content shipped whole~~ — **fixed (SHI-297).**
- [x] ~~Reconnect snapshot resends already-committed tool inputs~~ — **fixed (SHI-297).** Live nested subagent results stay unprojected, which is correct and is now named as such rather than left implicit.

## The three remaining browser-facing paths (SHI-297)

All three were the same shape — a path reaching the browser without going
through `projectMessagesForWire` / `projectAgentEventForWire` — and all three
turn on the same rule: *a body may only leave the wire once the row holding it
is committed*.

- [x] **`message_steered` images.** The echo now carries the same
      `/images/:hash` URLs the history path builds. Safe by ORDERING, not by
      assumption: `recordSteeredMessage` + `persistTurnInProgress` already run
      before the emit, so the row the URL resolves against is on disk first.
      Pinned end-to-end in `live-steering.test.ts` (echo carries `src` not
      `data`, the endpoint serves the bytes, storage keeps them).
- [x] **`sub_agent_consult_card.outputMarkdown`.** The card face draws one
      140-character preview line and the viewer is a click, so the wire copy is
      the preview plus `outputTruncated`, and `GET
      /api/sessions/:id/sub-agent-consults/:cardId` serves the rest.
      - The preview function is **shared** (`subAgentPreviewLine`), not
        reimplemented: the server now *builds* the line the client used to
        derive, and a byte-different preview would change the card face on
        reload. It is idempotent, so the client applying it to the server's own
        preview is a no-op.
      - `finalizeConsultCard` now **persists before it emits**. The stored card
        stays whole — it is what the endpoint serves and what `shipit agent
        result` reads, so SHI-245's "the agent's copy and the user's copy are one
        artifact" is unaffected; the preview is transport only.
      - The 200-byte floor applies, for the same reason it does to a tool result.
- [x] **Reconnect snapshot: a committed-prefix marker.** `CommittedBodyIds` on
      the runner records what each `replaceInProgress` actually wrote, so the
      snapshot strips the already-committed prefix of the in-flight turn and
      keeps only the genuinely in-memory tail inline.
      - It is an **id set, not the "events up to index N" cursor the issue
        imagined**, because groups are mutated in place: `attachToolResultsToGroup`
        and `attachSubagentToolResults` append to already-persisted groups, and
        the standalone-merge branch pushes a fresh `tool_use` into one. "Group
        index < N" therefore does not imply "every body in it is on disk".
      - Inputs and results are **separate sets under the same id**. A subagent's
        `tool_use` reaches disk at a boundary while its result — which skips
        `replaceInProgress` entirely — may still be memory-only, under that same
        id. One set would strip the result on the strength of the input and
        promise a fetch that 404s. Pinned by its own test.
      - Marked from the list actually written, never from the live groups, so
        the set can only ever UNDER-report: a missed call site costs bytes, never
        correctness. Omitting the argument reproduces the old behavior exactly.
      - **Top-level tool results are deliberately unchanged** — they were
        already stripped unconditionally on this path (same-tick commit), and
        routing them through the marker would have made an existing guarantee
        depend on the new wiring.
- [x] **Live nested subagent results stay unprojected**, and that is correct
      rather than an oversight: their handler branch returns before
      `replaceInProgress`, so nothing has written them at emit time and a
      `truncated` marker would promise a fetch that 404s. Named here because
      earlier sections described it as intentional while the gaps list did not.

## Follow-up work (separate from this PR)

### Live-CLI verification — results

Run after the req-1 fix merged. Two of the five checks are done and are now
**automated** rather than manual; the rest are blocked on credentials.

- [x] **Real CLI event shapes.** The projection was run over this session's own
      Claude CLI transcript — 244 real `tool_result` blocks across 8 tool names,
      not synthetic fixtures. Every tool name resolved (0 fell to the
      unknown-name fallback), `AskUserQuestion` results were kept whole as
      intended, and result bodies on the wire went **282.7 KB → 13.8 KB (95.1%
      removed)**. Results under the 200-byte floor stayed inline, which is the
      floor behaving as designed on real data.
- [x] **The same-tick commit claim, end-to-end** — `lazy-bodies-live-turn.test.ts`.
      Drives a real agent turn through the WS path and fetches the body the
      instant the emit is observable. This was the one load-bearing assumption
      argued from reading the code rather than asserted; it is now a test. It
      also pins the two deliberate exceptions (Edit/Write inputs and nested
      subagent results arrive whole on the live path, because their rows are not
      committed yet) and that the persisted row keeps the full body.
- [x] **The modal actually renders the fetched body** — `ToolResult.test.tsx`.
      Server tests prove the payload is stripped, not that the UI puts the body
      back on screen: loading state instead of a false "(no output)", fetch on
      mount, the body rendered, an error surfaced on 404, and no fetch at all
      for a result that arrived whole.

- [x] **A subagent (`Agent`) turn end-to-end**, driven through a live Claude CLI
      turn in the dogfood. The `Agent` tool ran, the subagent card rendered with
      its nested Bash call under "Subagent's work", and the **final report
      arrived whole** — the `SUBAGENT_REPORT_TOOL_NAMES` exemption holding on
      real CLI data rather than on a fixture. This also answers docs/109's
      standing question: **nested subagent activity does render in the UI**, both
      while running and after completion.

      One defect observed while verifying, and it is *not* caused by this
      feature: the final report renders as the raw block-array JSON
      (`[{"type":"text","text":"…"}]`) instead of the extracted prose. The
      exemption returns the result untouched, so the renderer is receiving
      exactly what it received before docs/244 — `SubagentCall` simply didn't
      parse a block array. Filed as SHI-287 and **since fixed**:
      `parseSubagentReport` (`client/utils/group-events-by-parent.ts`) splits
      the array into report text and the CLI's accounting footer, structurally
      rather than lexically. Written up in docs/109.

Blocked, with the reason:

- [ ] **A screenshot result end-to-end** (blocked on **SHI-298**). Still no real-shape data. Neither local
      CLI transcript contains an image block, and the dogfood cannot produce one
      either — inner sessions have no Playwright MCP server, so the agent has no
      browser tool at all (it said so itself when asked). The synthetic coverage
      is good, including two block shapes that previously broke a lexical
      pre-filter, but "the real MCP screenshot shape" remains unconfirmed.
      Unblocking it means wiring an MCP server into inner sessions (docs/118
      follow-up) or capturing a real image-bearing transcript from a
      containerized session.

## Verification (SHI-296)
- [x] `npm run typecheck`, `npm run lint:dev`
- [x] `transcript-input-policy.test.ts` — the drift guard, one case per enumerated call site (same manual-enumeration caveat as the result-side guard, stated in the file)
- [x] `transcript-projection.test.ts` — head slice, drops, `inputChars`, key-order preservation, the floor, the plan-document exemption and its near-miss
- [x] `useLazyToolInput.test.ts` — enable-is-the-trigger, fetch-once, no stale input when re-pointed, error surfaced, no retry storm
- [x] `SubagentCall.test.tsx` / `message-tools.test.tsx` — the three views actually call it, render what comes back, and degrade visibly when it 404s
- [x] `lazy-transcript-bodies.test.ts` — the whole round-trip through the real orchestrator, including the plan-document body surviving and the command's tail being absent from the payload
- [x] `lazy-body-projection.test.ts` — the client/server `countLines` pin still holds with padded fixtures (the old ones fell below the new floor)

## Verification
- [x] `npm run typecheck`
- [x] `npm run lint:dev`
- [x] Feature test files green
- [x] SHI-297: `transcript-projection.test.ts`, `lazy-transcript-bodies.test.ts`,
      `lazy-bodies-live-turn.test.ts` (mid-turn reconnect), `live-steering.test.ts`
      (steered image), `sub-agent.test.ts` (emit projected / persist whole),
      `chat-card-persistence.test.ts` (the marker is set where the write happens),
      `SubAgentCards.test.tsx` (the UI actually re-fetches and renders)
- [x] Post-merge live verification (see above): real-CLI shapes, same-tick commit, modal render
- [x] Independent requirements review by a fresh context (CLAUDE.md step 5) — see below
- [x] Client half of the lazy Edit/Write path pinned (`DiffBlock.test.tsx`) — the review found it unpinned

## Independent requirements review (2026-08-04)

Run on **Codex** rather than a subagent, so the reviewer shared none of the
implementer's assumptions. It read `requirements.md` and `plan.md`, found the
implementation itself, and reported per-requirement verdicts with `file:line`
evidence. Every claim below was re-verified against the code before being
recorded — the brief warned that earlier rounds on this feature produced both
real bugs and confident false positives.

**Verdicts: 3, 7, 9 met. 1, 2, 4, 5, 6, 8 partially met.** No requirement
unmet. The partials are all payload-completeness shortfalls, not broken
behavior — with one exception (req 2/8, the Ask answer) which loses text.

What the review found that we had not:

- **The >16 KB `AskUserQuestion` answer is worse than filed.** It was recorded
  as a req-4 gap; it also breaks req 2 (nothing displays or fetches the tail —
  it is unreachable, not deferred) and req 8 (the Ask card *is* the transcript).
  Verified: the Ask branch in `message-tools.tsx` returns before the output
  modal. → **SHI-291**.
- **Image thumbnails transfer full-resolution bytes pre-click.** The 96×96
  render points at the same content-addressed URL as the full-size preview, so
  `loading="lazy"` fetches the whole image on viewport entry. Reduced *CSS
  dimensions*, not reduced bytes — req 9's second clause never fires. Verified
  in `message-media.tsx`, which documents the choice but never recorded it as a
  req-1 shortfall. → **SHI-292**.
- **The 200-byte floor is an undisclosed req-1 deviation.** Real, and the
  review is right that the checklist marked it *complete* rather than
  *deviating*. Now recorded as a gap; the floor itself stays.
- **The lazy Edit/Write client path was unpinned.** The integration test proved
  the endpoint, nothing proved the UI calls it. A refactor dropping the fetch
  would have left every diff modal blank with a green suite. **Fixed** — five
  tests in `DiffBlock.test.tsx` covering no-fetch-until-open, the endpoint URL,
  the loading state, a 404 surfacing an error rather than an empty diff, and no
  fetch at all for a whole diff.
- **One recorded gap was stale** ("Show all 1 lines"), because the previews
  moved into the modal after it was written. Withdrawn above.

Two structural criticisms accepted without code changes, because they are about
how the feature was specified rather than what it does:

- The **200-byte floor** and the **live-path relaxation** are mechanisms the
  implementation chose that no requirement asked for — the floor optimizes a
  transferred-size target the human explicitly declined to set, and the live
  relaxation narrows req 6. Under this repo's spec discipline both should have
  been raised as open questions rather than settled in `plan.md`. Recorded here
  rather than re-litigated.
- The **drift guard** for inline result readers is a manual enumeration, so a
  new component reading another tool's result content would not fail the build.
  The review is right that `plan.md` overstated it; the wording is corrected.

Not acted on: the reviewer flagged that `plan.md` asserts session-unique
tool-use ids while nothing enforces it locally, and the endpoints return the
first match. It found no concrete collision in current adapters and labelled it
an unproven assumption, so it stays an assumption — now labelled as one.
