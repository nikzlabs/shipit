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
