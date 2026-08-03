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
- [x] Confirm slice size → 40 lines, capped at 16 KB (derived from Bash's 30 — **that derivation has since expired**, see *Requirement 1 is not met* below)
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
- [x] Fetch-on-expand in `ToolResult.tsx`; spinner while loading
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
- [x] Req 1: a >1 MB stored transcript serves a small fraction of its size, with none of the three heavy bodies present beyond their slice

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

## Requirement 1 is not met — deferred, not fixed
- [ ] **The transcript no longer previews tool output at all**, so the 40 lines this ships are invisible until the modal opens — exactly what req 1 forbids. `<ToolResult>` renders only inside the click-opened modal (`message-tools.tsx:500`); the transcript line is built from the tool's *input*. The fix is to carry no result content outside the consumers req 4 names (`Task` final report, AskUserQuestion, Present; ExitPlanMode reads existence only) and fetch on modal open — a redesign of the projection, deliberately deferred. Full analysis in `plan.md` → *Requirement 1 is not met*.
- [ ] Once that lands, the 16 KB byte backstop and the `TRANSCRIPT_SLICE_LINES` ≥ `*_MAX_LINES` guard become moot for ordinary results, and the fetch endpoint needs to substitute image URLs so the modal fetch isn't the new heavy payload.
- [ ] **`Skill` and `Agent` are exempt from every size bound while rendering no result content at all** — only `Task` routes to `SubagentCall` (`MessageToolUse.tsx:41`); the other two draw a label + prompt and never read the result (`:52`). So they transfer arbitrarily large bodies that are never shown — a worse req-1 violation than the 40-line slice. Fixing it means splitting `SUBAGENT_TOOL_NAMES`'s two jobs ("renders as its own element" vs "is a final report"), which belongs with the redesign.

## Known gaps (recorded, not addressed in this PR)
- [ ] Req 5 says "tool inputs"; only Edit/Write are projected, other tool inputs ship whole
- [ ] Byte backstop on a single long line removes text that used to render inline, and labels it "Show all 1 lines" (reqs 1/8)
- [ ] A >16 KB free-form AskUserQuestion answer would be sliced (req 4)
- [ ] `message_steered` echoes full base64 images unprojected — safe to fix (row is persisted first), just not done here
- [ ] `sub_agent_consult_card.outputMarkdown` is modal-only content shipped whole
- [ ] Reconnect snapshot resends already-committed tool inputs; tightening needs a committed-prefix marker on the runner

## Follow-up work (separate from this PR)
- [ ] **File the Linear issue for the req-1 redesign above.** Attempted during this PR; Linear returned `usage limit exceeded` twice. The full write-up is in `plan.md` → *Requirement 1 is not met*, so nothing is lost — but the tracker item still needs creating.
- [ ] Subagent activity does not appear in the UI in practice (docs/109) — plumbing is complete and tested with synthetic events, but never verified against a live CLI, and both attach points silently no-op when the parent group isn't found. Investigate after this merges.

## Verification
- [x] `npm run typecheck`
- [x] `npm run lint:dev`
- [x] Feature test files green (77 tests across 6 files)
- [ ] Independent requirements review by a fresh context (CLAUDE.md step 5) — round 2 found real bugs; needs a clean pass
