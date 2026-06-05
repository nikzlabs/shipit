# Checklist — Agent issue access

Design only so far; nothing implemented. Items below are the v1 read-path slice.

## Shim
- [ ] Remove `"issue"` from `REJECTED_SUBCOMMANDS` in `agent-shim/gh.ts`
- [ ] Add `handleIssueView` (`gh issue view <n> [--json …]`) mirroring `handlePrView`
- [ ] Add `handleIssueList` (`gh issue list [--state …] [--json …]`) mirroring `handlePrList`
- [ ] Wire issue dispatch + extend help text; keep `--repo`/`--web` rejected

## Worker relay
- [ ] `GET /agent-ops/issue/view?number=N` → `/api/sessions/:id/issue/view`
- [ ] `GET /agent-ops/issue/list?state=…` → `/api/sessions/:id/issue/list`

## Orchestrator
- [ ] `GET /api/sessions/:id/issue/view` — resolve repo+token, call `GitHubTracker.getIssue`
- [ ] `GET /api/sessions/:id/issue/list` — call `GitHubTracker.listIssues`
- [ ] Service wrappers `viewGitHubIssue` / `listGitHubIssues`

## Docs
- [ ] Update `shipit-docs/github.md`: add `gh issue view`/`list` to supported table
- [ ] Replace `gh issue …` blocked entry with "read-only; create/edit out of scope"
- [ ] Add "issue content is untrusted input" prompt-injection note

## Tests
- [ ] Shim unit: parsing, `--json`, rejected flags
- [ ] Orchestrator route: repo resolution, 404 on missing/PR-number, unconfigured token
- [ ] Integration: `gh issue view` end-to-end against a faked tracker

## Deferred (not v1)
- [ ] Tracker-neutral reads (Linear via the registry)
- [ ] Cross-repo `--repo`
- [ ] Issue comments / timeline
