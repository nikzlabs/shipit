# Lazy row bodies — checklist

> Under requirements discipline — see `requirements.md`. No open questions and
> no open design decisions remain; implementation is unblocked.

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
- [ ] Add `truncated` / `totalLines` / `totalBytes` to the tool-result type
- [ ] Shared `SLICE_LINES` constant (40) + 16 KB byte backstop, UTF-8 safe
- [ ] Serve-path slice projection, separate from `fromRow`
- [ ] Exempt Task-parent results (final report)
- [ ] Substitute image blocks *before* slicing, so image results need no exemption
- [ ] `GET /api/sessions/:id/tool-results/:toolUseId`

## Server — Write/Edit inputs
- [ ] Persist `added` / `removed` line stats
- [ ] Strip body from the wire behind a `truncated` marker
- [ ] `GET /api/sessions/:id/tool-inputs/:toolUseId`

## Server — images
- [ ] Hash + strip base64 in the projection; populate `src` with the URL
- [ ] `GET /api/sessions/:id/images/:hash`, `Cache-Control: immutable` + `ETag`
- [ ] Apply to image-bearing tool results as well as user rows

## Client
- [ ] Fetch-on-expand in `ToolResult.tsx`; spinner while loading
- [ ] `totalLines` from metadata for the "Show all N lines" label
- [ ] `DiffBlock` reads stats from metadata; fetches body when the modal opens
- [ ] `data` optional on `ChatMessageImage`; `src` added to `ToolResultImage`
- [ ] `loading="lazy"` on both image render paths
- [ ] Ordinary error surfaced on a 404

## Tests
- [ ] Slice boundary: UTF-8 safety, 40-line cut, 16 KB backstop on a long line
- [ ] Guard: `SLICE_LINES` ≥ every `*_MAX_LINES` in `ToolResult.tsx`
- [ ] Image-bearing result still parses via `parseContentForImages` after substitution
- [ ] Exemption: subagent final report stays whole
- [ ] Diff stats match `countLines` on the full body
- [ ] Regression guard: a `fromRow` read-modify-write round-trip does **not** persist a sliced body
- [ ] Endpoints: hit, subagent-nested hit, 404 on unknown id
- [ ] Same image in two rows resolves to one hash (dedupe)
- [ ] Constraint consumers still resolve from a sliced result (req 4)
- [ ] Rewind invariant: after a chat rewind the client holds no row whose body was deleted
- [ ] Req 1 assertion: a synthetic 1 MB-result transcript transfers nothing that isn't visible without a click
