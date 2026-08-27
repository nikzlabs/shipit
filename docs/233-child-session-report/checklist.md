# Checklist — child → parent session reports

- [x] `SessionReportCard` + `SessionReportSeverity` domain types
- [x] `messages.session_report` column + migration
- [x] `sessionReport` persisted card: `PersistedMessage` field + `toRow`/`fromRow`
- [x] Extract `wakeSessionWithTurn` (`wake-session.ts`) from `merge-watch.ts`
- [x] `session-report.ts` service — validation, recipient resolution, rate limit, card + wake fan-out
- [x] `resolveSessionCohort` (self / parent / siblings / children) for `whoami`
- [x] Orchestrator routes (`/cohort`, `/report`) + golden container-route table entry
- [x] Worker broker relays + shim `report` / `whoami` + bare `view` → whoami
- [x] `WsSessionReportCard` type + union + transcript scoping
- [x] Client: `SessionReportCard`, live handler, `CARD_MESSAGE_FIELDS`, MessageList render
- [x] Agent-facing docs (`shipit-docs/sessions.md`) + both agent system prompts
- [x] Service unit tests, shim tests, integration tests, client tests, guard-test updates
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Design doc + Linear issue comment

## Resolved-child delivery gate

- [x] Human requirements and resolution receipts
- [x] Implementation design traced against the existing UI/server lifecycle predicate
- [x] Independent design reviews addressed
- [x] Single shared resolved-session classifier + client/server consumer migration + tests
- [x] Every turn start updates `lastUsedAt`, including abnormal-exit coverage
- [x] Direct parent-message resolved-child guard + service tests
- [x] ~~Cohort resolved-sibling skip result + service tests~~ — superseded by parent-only reports
- [x] Agent-facing docs updated for resolved-child command outcomes and `whoami` visibility
- [x] Independent implementation review findings addressed
- [x] `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck` clean

## Parent-mediated coordination

- [x] Remove sibling/cohort recipients from the report service
- [x] Reject `--cohort` and non-parent targets in the shim and server
- [x] Keep sibling visibility as read-only topology
- [x] Update all agent prompts and agent-facing command documentation
- [x] Add service, integration, and shim regression coverage for no lateral delivery
- [x] Address Grok review findings; final Grok pass reports no remaining findings
- [x] `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck` clean
