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
- [ ] Independent design review addressed; focused re-review pending
- [ ] Single shared resolved-session classifier + client/server consumer migration + tests
- [ ] Durable `lastUserTurnAt` migration, persistence, and interactive-ingress marking
- [ ] Direct parent-message resolved-child guard + service/integration/shim tests
- [ ] Cohort resolved-sibling skip result + service/shim tests
- [ ] Agent-facing docs updated for resolved-child command outcomes and `whoami` visibility
- [ ] `npm run test:dev`, `npm run lint:dev`, and `npm run typecheck` clean
