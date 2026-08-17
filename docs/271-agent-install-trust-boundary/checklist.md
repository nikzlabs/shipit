# Checklist — `agent.install` trust boundary

- [x] `requirements.md` written from the issue before any design
- [x] Open questions put to the requester; answers recorded as dated receipts,
      questions removed, and reqs 6/7/8 changed in the same diff
- [x] Route verified at the source (both mounts, both execution paths, the uid
      equality that rules out writer attribution)
- [x] `plan.md` citing requirements
- [x] Gate module (`agent-install-gate.ts`) — plugin-bearing predicate, marker
      anchor, withheld record, notice text
- [x] Gate call at `ContainerSessionRunner.runInstall`, covering the live delta
      and the restart path (req 5)
- [x] Transcript notice wired via `emitNoticeInTurn` in `runner-registry-factory`
- [x] Unit tests for the decision logic (19)
- [x] Runner-level tests that fail on today's code (verified by disabling the
      gate: both go red)
- [x] `npm run lint:dev`, `npm run typecheck`, `npm run test:dev` green
- [x] Independent review requested via `shipit agent run --role reviewer`
- [x] Tracker synced (comment on planning#400)
