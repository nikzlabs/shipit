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
- [x] Ops session (`docs/128`): re-point the `--shipit-source` no-write 403 fallback (`api-routes-session.ts`) into this flow — the message now directs the agent to `report_shipit_bug` with redacted Docker/journal evidence; producer is derived server-side from `session.kind === "ops"` so the existing draft→redact→confirm→file path already marks it `source:ops`
- [x] Update `src/server/shipit-docs/ops-session.md` so the ops agent files an issue (instead of a text-only report) when it lacks push access

## GitHub issue filing (user's own identity)
- [x] `GitHubAuthManager.createIssue(repo, { title, body })` against the hard-coded `nikzlabs/shipit` (no env override), using the user's existing token
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
- [x] Update `docs/023` (redaction engine now exists) cross-ref

## Outcome signal back to the agent (nikzlabs/shipit#2350)
- [x] `submit_bug_report` success wakes the session with a self-describing system turn carrying the title, issue **number and URL** (`wakeSessionWithTurn`, the docs/196 / docs/233 primitive — enqueues behind a running turn, starts one when idle)
- [x] Filing **failure** deliberately sends no signal: the report is still pending, which is the state the agent already believes; silence is therefore meaningful
- [x] Cancel is a server round-trip (`dismiss_bug_report`), not local component state — persists terminal `phase: "dismissed"` via `persistCardTransition` (clobber-free while the proposing turn is in flight) and echoes `bug_report_dismissed` to every viewer
- [x] Declined card wakes the agent with "declined; nothing filed", and states the card is resolved so an unrelated second report isn't held back
- [x] A Cancel arriving after a successful filing is ignored, never rewriting a terminal success
- [x] `ChatHistoryManager.getBugReportCard` — read-side lookup so the dismiss handler can name the card in the wake prompt; checks `runner.recordedCards` first for a card whose turn hasn't finalized
- [x] Agent-facing copy updated so silence is learnable: `prompts/skeleton.md`, `shipit-docs/bug-filing.md`, the `report_shipit_bug` tool description, and the relay's return message
- [x] Tests: filed signal carries #N + URL, decline persists + signals, failure signals nothing, post-filing Cancel ignored (`user-bug-filing.test.ts`); store terminal-dismissed guard; card reports Cancel to the server and stays collapsed after a reload

## Follow-ups (not blockers for the in-product flow)
- [ ] Maintainer-side GitHub Action on `nikzlabs/shipit` to apply real `user-reported` / `source:*` labels from the `<!-- shipit-report … -->` body marker (lives in the upstream repo, not this codebase)
- [ ] docs/023 full session export consumes the shared Stage-1 redactor (un-pause that doc when picked up)
- [x] Persist the card payload + lifecycle to chat history so it survives a session switch / full reload (recorded in-band with the proposing turn via `recordBugReportCard` → `buildTurnMessages`, like voice notes; filed/failed patched in place via `ChatHistoryManager.updateBugReportCard`; `loadSessionHistory` seeds the store; client append + store `upsertCard` are idempotent against the reconnect buffer replay)
