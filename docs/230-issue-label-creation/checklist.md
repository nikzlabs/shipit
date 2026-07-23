# Issue label creation — checklist

- [x] `Tracker.createLabel` / `Tracker.deleteUnusedLabel` + Linear and GitHub adapter implementations
- [x] `IssueWriteVerb` `"label"` + `IssueWriteUndo` `{ kind: "label" }`
- [x] `createLabelForTracker` service (409 on duplicate) + `createMissingLabels` helper + undo branch
- [x] Unknown-label rejection now suggests `label create` / `--create-missing-labels`
- [x] `POST /api/sessions/:sessionId/issue/label/create` route + per-label provenance cards + SHI-112 dedup
- [x] `/agent-ops/issue/label/create` worker relay
- [x] Shim: `shipit issue label create` + `--create-missing-labels` on create/edit + help text
- [x] Client `IssueWriteCard` renders the `label` verb (non-navigable)
- [x] Tests: adapters, services, shim, integration slice
- [x] Agent-facing docs (`src/server/shipit-docs/issues.md`)
