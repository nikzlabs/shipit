# User bug filing — checklist

## Redaction pipeline
- [x] `redaction.ts` Stage 1 — heuristic content scrubbers (`sk-`/`ghp_`/`Bearer`/long-token, emails, git URLs via `stripUrlCredentials`, workspace paths) replacing inline substrings with `[REDACTED]`; reuse `shipit-source.ts` path matchers only for path exclusion, not content
- [x] `redaction.ts` Stage 2 — LLM pass on the Stage-1 output via a one-shot agent-CLI invocation (the `session-namer.ts` pattern: shell out to `claude -p …` / `codex exec --skip-git-repo-check …` with `HOME` at the shared credentials mount), reusing the session's own model/credentials — provider-agnostic, no new key, no `OPENAI_API_KEY`/OAuth-header plumbing
- [x] Model returns sensitive **spans** (parse CLI output as the namer does), orchestrator code applies redaction (verify deletion-only, no rewrite/inject); sanity token ceiling on the body
- [x] CLI error / timeout / unparseable output → degrade to Stage-1 floor + card flag; never blocks filing
- [x] Fail-safe: Stage-2 error/timeout degrades to the Stage-1 floor and sets a "deep privacy check didn't run" flag on the card (never silently ships)
- [x] `redaction.test.ts` — Stage 1 scrubs inline `ghp_…`/email/workspace path in *free text*; Stage 2 (stubbed model) applies returned spans and rejects non-deletion output; Stage-2 failure degrades to floor + flag

## Producers (regular + ops)
- [x] Regular session: agent recognizes intent, attaches redacted transcript + platform version + browser/env (no Docker/journal)
- [ ] Ops session (`docs/128`): re-point the `--shipit-source` no-write 403 fallback (`api-routes-session.ts`: "produce a structured incident report instead") into this flow, attaching Docker/journal evidence — same draft→redact→confirm→file path
- [ ] Update `src/server/shipit-docs/ops-session.md` so the ops agent files an issue (instead of a text-only report) when it lacks push access

## GitHub issue filing (user's own identity)
- [x] `GitHubAuthManager.createIssue(repo, { title, body })` against the hard-coded `nicolasalt/shipit` (no env override), using the user's existing token
- [x] No scope pre-check — attempt create, surface a GitHub 403/scope error as a "reconnect with a token that can file issues on the ShipIt repo" prompt
- [x] No service credential, no Linear, no pluggable backend (single fixed destination)
- [x] Labels via body marker — encode `user-reported` + producer marker (`source:ops` / `source:session`) as a footer line + parseable HTML comment in the body (GitHub drops API labels from non-push filers); pass API labels on the create call too (no-op for non-push filers, applied for developers)

## Server flow
- [x] `bug-report.ts` service: compile draft → redact → stamp platform version → (on confirm) `createIssue`
- [x] `report_shipit_bug` agent tool → `/bug-report` route emits the card, no issue created
- [x] WS handler `submit_bug_report` (confirm → create issue → emit result)
- [x] WS message types: `bug_report_card`, `bug_report_filed`, `bug_report_failed`, `submit_bug_report`
- [x] Server stamps the bare `SHIPIT_BUILD_ID` commit SHA (or `unknown` if unset); not from session container, no checkout cross-reference
- [x] No custom rate-limiting — rely on GitHub's native abuse handling

## Agent
- [x] `agent-instructions.ts`: bug-filing capability + when to offer it
- [x] `report_shipit_bug` tool wired (mcp-bug-bridge → worker `/agent-ops/bug/report` → orchestrator); agent proposes, never files directly

## Client
- [x] `BugReportCard.tsx` — editable Title + a single editable Body that IS the entire payload (redacted draft + build/source footer in one field; WYSIWYG, nothing sent outside it); Submit/Cancel
- [x] Show author identity (`@you`) as transparency (not in the editable body); show the Stage-2 "deep privacy check didn't run" flag when set; state the issue is public + attributed
- [x] Filed state with secondary "View on GitHub" escape hatch

## Tests & docs
- [x] `user-bug-filing.test.ts` integration: redaction applied, issue only after confirm, scope-missing path, empty-body rejected
- [x] `BugReportCard.test.tsx` component test: consent gate, Stage-2 flag, filed state, scope-error banner, Cancel, unknown-card no-op
- [x] `shipit-docs/bug-filing.md` agent-facing doc + README index entry
- [ ] Update `docs/023` (redaction engine now exists) cross-ref

## Follow-ups (not blockers for the in-product flow)
- [ ] Maintainer-side GitHub Action on `nicolasalt/shipit` to apply real `user-reported` / `source:*` labels from the `<!-- shipit-report … -->` body marker (lives in the upstream repo, not this codebase)
- [ ] docs/023 full session export consumes the shared Stage-1 redactor (un-pause that doc when picked up)
- [ ] Optional: persist the card payload to chat history so it survives a mid-review reload (currently store-backed and transient)
