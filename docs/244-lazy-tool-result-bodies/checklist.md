# Lazy row bodies — checklist

> Under requirements discipline — see `requirements.md`. No open questions
> remain; implementation is unblocked.

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
- [ ] Confirm slice size (16 KB proposed)
- [ ] Confirm thumbnail size (192px longest edge proposed)
- [ ] Decide thumbnail storage: SQLite row vs. disk keyed by hash

## Server — tool results
- [ ] Add `truncated` / `totalLines` / `totalBytes` to the tool-result type
- [ ] Serve-path slice projection, separate from `fromRow`
- [ ] Exempt image-bearing results and Task-parent results
- [ ] `GET /api/sessions/:id/tool-results/:toolUseId`

## Server — Write/Edit inputs
- [ ] Persist `added` / `removed` line stats
- [ ] Strip body from the wire behind a `truncated` marker
- [ ] `GET /api/sessions/:id/tool-inputs/:toolUseId`

## Server — images
- [ ] Thumbnail generation at persist time, content-addressed by hash
- [ ] Populate `src` with the thumbnail URL; keep full-res out of the payload
- [ ] `GET /api/sessions/:id/images/:hash`
- [ ] Apply to image-bearing tool results as well as user rows

## Client
- [ ] Fetch-on-expand in `ToolResult.tsx`; spinner while loading
- [ ] `totalLines` from metadata for the "Show all N lines" label
- [ ] `DiffBlock` reads stats from metadata; fetches body when the modal opens
- [ ] Full-res image fetched when the preview modal opens
- [ ] "No longer available" on a 404

## Tests
- [ ] Slice boundary: UTF-8 safety, newline preference, exact-threshold case
- [ ] Exemptions: image-bearing result survives `parseContentForImages`; subagent final report stays whole
- [ ] Diff stats match `countLines` on the full body
- [ ] Regression guard: a `fromRow` read-modify-write round-trip does **not** persist a sliced body
- [ ] Endpoints: hit, subagent-nested hit, 404 on unknown id
- [ ] Constraint consumers still resolve from a sliced result (req 4)
- [ ] Rewind invariant: after a chat rewind the client holds no row whose body was deleted
- [ ] Req 1 assertion: a synthetic 1 MB-result transcript transfers nothing that isn't visible without a click
