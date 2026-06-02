# User bug filing — checklist

## Shared infrastructure
- [ ] `redaction.ts` — content scrubbers (`sk-`/`ghp_`/`Bearer`/long-token, emails, git URLs via `stripUrlCredentials`, workspace paths) replacing inline substrings with `[REDACTED]`; reuse `shipit-source.ts` path matchers only for path exclusion, not content
- [ ] `redaction.test.ts` — prove an inline `ghp_…`/email/workspace path in *free text* is scrubbed (not just sensitive filenames excluded); non-sensitive text preserved

## GitHub issue filing (user's own identity)
- [ ] `GitHubAuthManager.createIssue(repo, { title, body })` against the fixed upstream ShipIt repo, using the user's existing token
- [ ] No scope pre-check — attempt create, surface a GitHub 403/scope error as a "reconnect with a token that can file issues on the ShipIt repo" prompt
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

## Ops-session producer (docs/128 connection)
- [ ] Re-point the `--shipit-source` no-write 403 fallback (`api-routes-session.ts`: "produce a structured incident report instead") at this filing flow
- [ ] Update `src/server/shipit-docs/ops-session.md` so the ops agent files an issue (instead of a text-only report) when it lacks push access

## Tests & docs
- [ ] `user-bug-filing.test.ts` integration: redaction applied, issue only after confirm, scope-missing path
- [ ] Update `docs/023` (redaction engine now exists) cross-ref

## Open questions
- [ ] How "ShipIt build/version" is exposed to the orchestrator in a non-dogfood deployment
- [ ] Exact upstream repo + label convention for incoming user reports
