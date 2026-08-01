# Lazy tool-result bodies — checklist

## Design
- [x] Verify the issue's "behind a click" premise against the render paths
- [x] Confirm the four constraint consumers (AskUserQuestion, ExitPlanMode, Present, subagent report)
- [x] Confirm persist path is uncapped and the 1 MB cap is client-only
- [x] Determine whether the SHI-266 / `rowId` dependency is real
- [ ] Confirm slice size (16 KB proposed)
- [ ] Decide: project the live WS path too, or history only

## Server
- [ ] Add `truncated` / `totalLines` / `totalBytes` to the tool-result type
- [ ] Add the serve-path slice projection (separate from `fromRow`)
- [ ] Exempt image-bearing results and Task-parent results
- [ ] `GET /api/sessions/:id/tool-results/:toolUseId` (404 when the row is gone)

## Client
- [ ] Fetch-on-expand in `ToolResult.tsx`; spinner while loading
- [ ] Use metadata `totalLines` for the "Show all N lines" label
- [ ] Render "output is no longer available" on a 404

## Tests
- [ ] Slice boundary: UTF-8 safety, newline preference, exact-threshold case
- [ ] Exemptions: image-bearing result survives `parseContentForImages`; subagent final report is whole
- [ ] Regression guard: a `fromRow` read-modify-write round-trip does **not** persist a sliced body
- [ ] Endpoint: hit, subagent-nested hit, 404 after rewind
- [ ] Constraint consumers still resolve from a sliced result
