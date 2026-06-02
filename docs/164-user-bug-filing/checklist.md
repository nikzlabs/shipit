# User bug filing — checklist

## Redaction pipeline
- [ ] `redaction.ts` Stage 1 — heuristic content scrubbers (`sk-`/`ghp_`/`Bearer`/long-token, emails, git URLs via `stripUrlCredentials`, workspace paths) replacing inline substrings with `[REDACTED]`; reuse `shipit-source.ts` path matchers only for path exclusion, not content
- [ ] `redaction.ts` Stage 2 — LLM pass on the Stage-1 output using the session's own model (provider-agnostic, no tier mapping): model returns sensitive **spans**, orchestrator code applies redaction (verify deletion-only, no rewrite/inject); orchestrator-side call using the OAuth token it already owns (`agents/*/auth-manager.ts`) — no container round-trip, no new key; sanity token ceiling on the body
- [ ] Fail-safe: Stage-2 error/timeout degrades to the Stage-1 floor and sets a "deep privacy check didn't run" flag on the card (never silently ships)
- [ ] `redaction.test.ts` — Stage 1 scrubs inline `ghp_…`/email/workspace path in *free text*; Stage 2 (stubbed model) applies returned spans and rejects non-deletion output; Stage-2 failure degrades to floor + flag

## Producers (regular + ops)
- [ ] Regular session: agent recognizes intent, attaches redacted transcript + platform version + browser/env (no Docker/journal)
- [ ] Ops session (`docs/128`): re-point the `--shipit-source` no-write 403 fallback (`api-routes-session.ts`: "produce a structured incident report instead") into this flow, attaching Docker/journal evidence — same draft→redact→confirm→file path
- [ ] Update `src/server/shipit-docs/ops-session.md` so the ops agent files an issue (instead of a text-only report) when it lacks push access

## GitHub issue filing (user's own identity)
- [ ] `GitHubAuthManager.createIssue(repo, { title, body })` against the hard-coded `nicolasalt/shipit` (no env override), using the user's existing token
- [ ] No scope pre-check — attempt create, surface a GitHub 403/scope error as a "reconnect with a token that can file issues on the ShipIt repo" prompt
- [ ] No service credential, no Linear, no pluggable backend (single fixed destination)
- [ ] Labels via body marker — encode `user-reported` + producer marker (`source:ops` / `source:session`) as a footer line + parseable HTML comment in the body (GitHub drops API labels from non-push filers); set API labels directly only when the filer has push access

## Server flow
- [ ] `bug-report.ts` service: compile draft → redact → stamp platform version → (on confirm) `createIssue`
- [ ] WS handler `report_shipit_bug` (draft → emit card, no issue created)
- [ ] WS handler `submit_bug_report` (confirm → create issue → emit result)
- [ ] WS message types: `bug_report_card`, `bug_report_filed`, `bug_report_failed`, `submit_bug_report`
- [ ] Server stamps the bare `SHIPIT_BUILD_ID` commit SHA (or `unknown` if unset); not from session container, no checkout cross-reference
- [ ] No custom rate-limiting — rely on GitHub's native abuse handling

## Agent
- [ ] `agent-instructions.ts`: bug-filing capability + when to offer it
- [ ] `report_shipit_bug` tool wired; agent proposes, never files directly

## Client
- [ ] `BugReportCard.tsx` — editable Title + a single editable Body that IS the entire payload (description + redacted transcript excerpt + ops evidence + build/browser footer all in one field; WYSIWYG, nothing sent outside it); Submit/Cancel
- [ ] Show author identity (`@you`) as transparency (not in the editable body); show the Stage-2 "deep privacy check didn't run" flag when set; state the issue is public + attributed
- [ ] Filed state with secondary "View on GitHub" escape hatch (overflow)

## Tests & docs
- [ ] `user-bug-filing.test.ts` integration: redaction applied, issue only after confirm, scope-missing path
- [ ] Update `docs/023` (redaction engine now exists) cross-ref

## Follow-ups (not blockers)
- [ ] Maintainer-side GitHub Action on `nicolasalt/shipit` to apply real `user-reported` / `source:*` labels from the `<!-- shipit-report … -->` body marker (lives in the upstream repo, not this codebase)
