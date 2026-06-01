# User bug filing — checklist

## Shared infrastructure
- [ ] `redaction.ts` — generalize `REDACTED_PATTERNS`, add secret/email/URL/path scrubbers
- [ ] `redaction.test.ts` — secrets, emails, repo URLs, workspace paths all redacted; non-sensitive text preserved

## GitHub issue filing (user's own identity)
- [ ] `GitHubAuthManager.createIssue(repo, { title, body })` against the fixed upstream ShipIt repo, using the user's existing token
- [ ] Missing-scope (`public_repo`) handling → surface a clear "connect GitHub to file a bug" prompt instead of failing opaquely
- [ ] No service credential, no Linear, no pluggable backend (single fixed destination)

## Server flow
- [ ] `bug-report.ts` service: compile draft → redact → stamp platform version → (on confirm) `createIssue`
- [ ] WS handler `report_shipit_bug` (draft → emit card, no issue created)
- [ ] WS handler `submit_bug_report` (confirm → create issue → emit result)
- [ ] WS message types: `bug_report_card`, `bug_report_filed`, `bug_report_failed`, `submit_bug_report`
- [ ] Server stamps platform build/version (not from session container)
- [ ] No custom rate-limiting — rely on GitHub's native abuse handling

## Agent
- [ ] `agent-instructions.ts`: bug-filing capability + when to offer it
- [ ] `report_shipit_bug` tool wired; agent proposes, never files directly

## Client
- [ ] `BugReportCard.tsx` — editable title/body, exact redacted payload preview, Submit/Cancel
- [ ] Filed state with secondary "View on GitHub" escape hatch (overflow)

## Tests & docs
- [ ] `user-bug-filing.test.ts` integration: redaction applied, issue only after confirm, scope-missing path
- [ ] Update `docs/023` (redaction engine now exists) cross-ref
- [ ] Update `src/server/shipit-docs/` if any agent-facing behavior changes

## Open questions
- [ ] How "ShipIt build/version" is exposed to the orchestrator in a non-dogfood deployment
- [ ] Exact upstream repo + label convention for incoming user reports
- [ ] Whether the existing GitHub OAuth scope already covers `public_repo` issue creation, or needs a scope bump
