# Issue → Session — checklist

## Phase 1 — GitHub Issues

- [ ] `IssueRef` type in `domain-types.ts`, threaded through `SessionInfo`
- [ ] `GitHubAuthManager.listIssues()` + `getIssue()` in new `github-auth-issues.ts`
- [ ] `GET /api/github/issues?repoUrl=&filter=assigned` route + service
- [ ] `createHeadlessSession` accepts `issueRef`, derives branch + initial prompt
- [ ] Branch slug helper (`gh-<n>-<slug>`), title fallback, collision handling
- [ ] PR body templating: append `Closes #N` in `services/pr-lifecycle.ts`, skip if already present
- [ ] `POST /api/sessions/headless` extended with optional `issueRef`
- [ ] `IssuesPanel.tsx` + `useIssues()` hook
- [ ] Home screen tab for Issues
- [ ] Session header chip rendering `issueRef` (with escape-hatch link to tracker)
- [ ] Resume-existing-session match by `issueRef.identifier`
- [ ] Integration test: pick a GitHub issue → session created on derived branch → PR body has `Closes #N`
- [ ] Update `src/server/shipit-docs/` if any agent-facing behavior changes

## Phase 2 — Linear

- [ ] `LinearAuthManager` (orchestrator-side OAuth, not the MCP container-side flow)
- [ ] `CredentialStore.setLinearToken` / `getLinearToken`
- [ ] `GET /api/linear/issues?filter=assigned` route + service
- [ ] "Connect Linear" UI in settings, modeled on GitHub connect
- [ ] Repo-resolution UI: pick-the-repo step before session creation (Phase 2a)
- [ ] Optional team→repo mapping in settings (Phase 2b)
- [ ] Linear-flavored PR body line (`Fixes ENG-123`)
- [ ] Integration test: pick a Linear issue → repo prompt → session on `lin-eng-NNN-slug` → PR has `Fixes`

## Decisions to revisit after Phase 1 lands

- [ ] Whether to expose label/status/sprint filters in the picker
- [ ] Webhook-driven invalidation vs current polling
- [ ] Multiple GitHub accounts: confirm `accountId` API shape is forward-compatible
