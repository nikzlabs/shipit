# Checklist

Direct agent issue creation via `shipit issue create`, do-then-surface (reuses the docs/177 `IssueWriteCard`/undo stack). **Implemented.**

## Decisions (resolved)
- [x] Undo on Linear: **cancel** (Linear canceled state / GitHub close-as-not_planned)
- [x] Default tracker: **Linear**, with `--tracker github` to override

## Tracker layer
- [x] `createIssue` on the `Tracker` interface (`trackers/tracker.ts`)
- [x] Linear adapter `issueCreate` against the bound team
- [x] GitHub adapter `createIssue` (POST issues) on the session repo
- [x] Undo reverse-write: `setStatus(issueId, "canceled")` (Linear cancel / GitHub not_planned)

## Brokering
- [x] `createIssueForTracker()` service (`services/issues.ts`)
- [x] Extend `undoIssueWrite` for the `create` verb
- [x] `POST /api/sessions/:id/issue/create` route (`api-routes-issues.ts`)
- [x] `POST /agent-ops/issue/create` relay (`agent-ops-routes.ts`)

## Shim
- [x] `shipit issue create` verb (parse `--title`, `--body`/`--body-file`, `--tracker`, `--json`)
- [x] Remove `"create"`/`"new"` from `REJECTED_ISSUE_SUBCOMMANDS`
- [x] Unconfigured-tracker refusal (orchestrator 409/connect message surfaced)

## Types & persistence
- [x] `IssueWriteVerb += "create"`
- [x] `IssueWriteUndo += { kind: "create" }`
- [x] Persistence/client inherited (card stored as JSON; rendered generically — no migration)

## Docs / prompt
- [x] `src/server/shipit-docs/issues.md` — document `create`; drop the "can't create" line
- [x] `CLAUDE.md` — no-issue branch now creates + cross-links directly

## Tests
- [x] Shim: `create` defaults to Linear + posts; `--tracker github`; requires title; `close` still rejected
- [x] Linear adapter: create (+ no-team guard)
- [x] GitHub adapter: create (POST issues)
- [x] Service: `createIssueForTracker` + `undoIssueWrite` create branch (cancel)
- [x] Integration: `issue create` no longer gated, reaches the create route
