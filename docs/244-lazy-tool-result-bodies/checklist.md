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
- [x] Confirm slice size → 40 lines, capped at 16 KB (derived from Bash's 30)
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
- [x] Regression guard: a `fromRow` read-modify-write round-trip does **not** persist a sliced body
- [x] Endpoints: hit, subagent-nested hit, 404 on unknown id
- [x] Same image in two rows resolves to one hash (dedupe)
- [x] Constraint consumers still resolve from a sliced result (req 4)
- [x] Rewind invariant: after a chat rewind the client holds no row whose body was deleted
- [x] Req 1 assertion: a synthetic 1 MB-result transcript transfers nothing that isn't visible without a click

## Review fixes (round 1)
- [x] Project the reconnect `turn_snapshot` — third browser-facing path, was bypassing the projection entirely (req 6)
- [x] Stop stripping Edit/Write bodies on the live path; their row isn't committed until the next tool-result boundary, so the diff modal could 404 (req 2)
- [x] Correct the same-tick persistence claim in code comment, `plan.md`, and the PR body — it holds for tool results only
- [x] Tests pinning both: snapshot strips results/images but not inputs, history strips inputs, live assistant event untouched

## Known gaps from the independent review (not yet addressed)
- [ ] Client 1 MB cap clips without setting `truncated`, so an exempt subagent report over 1 MB is cut with no expand affordance (req 3/4)
- [ ] Req 5 says "tool inputs"; only Edit/Write are projected, other tool inputs ship whole
- [ ] A one-line result cut by the byte backstop renders "Show all 1 lines"
- [ ] A >16 KB free-form AskUserQuestion answer would be sliced (req 4)

## Verification
- [x] `npm run typecheck`
- [x] Feature test files green (53 tests across 5 files)
- [x] `npm run lint:dev`
- [ ] Independent requirements review by a fresh context (CLAUDE.md step 5)
