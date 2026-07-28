# Checklist

- [x] `StartSessionButton` split control: caret half + repo menu, gated on `onStartInRepo` + ≥2 repos
- [x] Checkmark the implicit target; disable repos that are still cloning
- [x] Divider that works for both the `cta` and solid `primary` variants
- [x] Thread `repos` / `targetRepoUrl` through `IssuesViewer` (list rows) and `IssueDetail` (footer)
- [x] `IssuesPanel`: select repos, drop hidden ones (keeping the current target), forward the pick
- [x] `App.handleIssueStartSession(issue, pickedRepoUrl?)` — force a fresh session on a repo switch, update `activeRepoUrl`
- [x] Component tests: picker gating, forwarded repo, cloning disabled, hidden-repo filter, unchanged default click
- [x] `mockup.html` visual reference
- [x] `npm run typecheck` + `npm run lint:dev` clean
