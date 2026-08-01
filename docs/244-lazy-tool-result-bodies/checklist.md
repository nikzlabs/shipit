# Lazy row bodies — checklist

> Under requirements discipline — see `requirements.md`. Implementation is
> blocked while its `## Open questions` section is non-empty.

## Requirements
- [x] Draft `requirements.md` from the issue and the chat
- [ ] Resolve: is zero visible change a hard requirement?
- [ ] Resolve: may images display at reduced resolution until clicked?
- [ ] Resolve: what shows when a body is no longer fetchable?
- [ ] Resolve: is there a target transferred size?

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
- [ ] Endpoints: hit, subagent-nested hit, 404 after rewind
- [ ] Constraint consumers still resolve from a sliced result
- [ ] Payload-size assertion: a synthetic 1 MB-result transcript loads under a byte budget
