# Checklist

Direct agent issue creation via `shipit issue create`, do-then-surface (reuses the docs/177 `IssueWriteCard`/undo stack).

## Decisions to confirm first
- [ ] Undo on Linear: cancel-state vs. archive (leaning cancel)
- [ ] Default tracker when both Linear + GitHub are configured (require `--tracker`?)

## Tracker layer
- [ ] `createIssue` on the `Tracker` interface (`trackers/tracker.ts`)
- [ ] Linear adapter `issueCreate` against the bound team
- [ ] GitHub adapter `createIssue` (POST issues) on the session repo
- [ ] Undo reverse-writes: Linear cancel/archive, GitHub close-as-not_planned

## Brokering
- [ ] `createIssueForTracker()` service (`services/issues.ts`)
- [ ] Extend `undoIssueWrite` for the `create` verb
- [ ] `POST /api/sessions/:id/issue/create` route (`api-routes-issues.ts`)
- [ ] `POST /agent-ops/issue/create` relay (`agent-ops-routes.ts`)

## Shim
- [ ] `shipit issue create` verb (parse `--title`, `--body`/`--body-file`, `--tracker`, `--json`)
- [ ] Remove `"create"` from `REJECTED_ISSUE_SUBCOMMANDS`
- [ ] Unconfigured-tracker refusal message

## Types & persistence
- [ ] `IssueWriteVerb += "create"`
- [ ] `IssueWriteUndo += { kind: "create"; issueId }`
- [ ] Verify chat-history round-trip + rehydration for the `create` verb (mostly inherited)

## Client
- [ ] Issue-write card: `create` verb label + "Canceled" undone state

## Docs / prompt
- [ ] `src/server/shipit-docs/issues.md` — document `create`; drop the "can't create" line
- [ ] `CLAUDE.md` — rewrite the design-doc no-issue branch to direct creation

## Tests
- [ ] Shim: `create` happy path (stdout identifier/url) + unconfigured refusal
- [ ] Linear adapter: create + undo (cancel)
- [ ] GitHub adapter: create + undo (close-as-not_planned)
- [ ] Service: `createIssueForTracker` + `undoIssueWrite` create branch
- [ ] Route relay forwards tracker/title/body
- [ ] History round-trip for a `create` provenance card
