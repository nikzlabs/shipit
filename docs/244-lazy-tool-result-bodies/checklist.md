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
- [ ] Req 5 says "tool inputs"; only Edit/Write are projected, other tool inputs ship whole
- [ ] Byte backstop on a single long line removes text that used to render inline, and labels it "Show all 1 lines" (reqs 1/8)
- [ ] A >16 KB free-form AskUserQuestion answer would be sliced (req 4)
- [ ] `message_steered` echoes full base64 images unprojected — safe to fix (row is persisted first), just not done here
- [ ] `sub_agent_consult_card.outputMarkdown` is modal-only content shipped whole
- [ ] Reconnect snapshot resends already-committed tool inputs; tightening needs a committed-prefix marker on the runner

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

Blocked, with the reason:

- [ ] **A screenshot result end-to-end.** Neither local CLI transcript contains
      a single image block, so there is no real-shape data to run against. The
      synthetic coverage is good (including two block shapes that previously
      broke a lexical pre-filter), but "the real MCP screenshot shape" is still
      unconfirmed.
- [ ] **A subagent (`Agent`) turn end-to-end**, and with it docs/109's standing
      question of whether nested subagent activity renders in the UI at all.
      Same reason: no `Task`/`Agent` calls in either local transcript.
- [ ] Both need a live agent turn in the dogfood preview. The inner ShipIt
      starts and serves, but reports **no agent subscription connected** — the
      `dev` service's `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are
      user-supplied secrets (outer Settings → Secrets, `docs/184`). The outer
      orchestrator's `/history` is deliberately closed to session containers, so
      there is no way around it from in here.


## Verification
- [x] `npm run typecheck`
- [x] `npm run lint:dev`
- [x] Feature test files green
- [x] Post-merge live verification (see above): real-CLI shapes, same-tick commit, modal render
- [ ] Independent requirements review by a fresh context (CLAUDE.md step 5) — round 2 found real bugs; needs a clean pass
