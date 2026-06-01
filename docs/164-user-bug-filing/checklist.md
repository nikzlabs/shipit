# User bug filing — checklist

## Shared infrastructure
- [ ] `redaction.ts` — generalize `REDACTED_PATTERNS`, add secret/email/URL/path scrubbers
- [ ] `redaction.test.ts` — secrets, emails, repo URLs, workspace paths all redacted; non-sensitive text preserved
- [ ] `IssueTrackerProvider.createIssue(report)` added to the tracker abstraction (coordinate with docs/156)
- [ ] `CredentialStore`: ShipIt service credential (`SHIPIT_BUGREPORT_TOKEN`/`_TARGET`) + per-account rate-limit store (SQLite-backed, survives restarts)

## Server flow
- [ ] `bug-report.ts` service: compile draft → redact → (on confirm) rate-limit → `createIssue`
- [ ] WS handler `report_shipit_bug` (draft → emit card, no issue created)
- [ ] WS handler `submit_bug_report` (rate-limit check → create issue → emit result)
- [ ] WS message types: `bug_report_card`, `bug_report_filed`, `bug_report_rejected`, `submit_bug_report`
- [ ] Server stamps platform build/version (not from session container)
- [ ] Rate limit enforced before `createIssue`; rejection surfaces in the card

## Provider backends
- [ ] GitHub Issues on ShipIt repo (default) — bot/App token, `user-reported` label
- [ ] Linear intake team (alternative) — server-held API key, dedicated team
- [ ] Backend selected by deploy config, no code fork

## Agent
- [ ] `agent-instructions.ts`: bug-filing capability + when to offer it
- [ ] `report_shipit_bug` tool wired; agent proposes, never files directly

## Client
- [ ] `BugReportCard.tsx` — editable title/body, exact redacted payload preview, Submit/Cancel
- [ ] Filed state with secondary "View on tracker" escape hatch (overflow)

## Tests & docs
- [ ] `user-bug-filing.test.ts` integration: redaction applied, rate limit enforced, issue only after confirm
- [ ] Update `docs/023` (redaction engine now exists) and `docs/156` (outbound createIssue) cross-refs
- [ ] Update `src/server/shipit-docs/` if any agent-facing behavior changes

## Open questions
- [ ] Final default backend: GitHub Issues on ShipIt repo vs Linear intake team
- [ ] Rate-limit numbers (N/day, cooldown)
- [ ] How "ShipIt build/version" is exposed to the orchestrator in a non-dogfood deployment
