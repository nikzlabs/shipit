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
- [x] Independent review via `shipit agent run --role reviewer`
- [x] Review findings fixed, each verified at the source first:
  - [x] **Critical** — `runner.sessionDir` is the clone, not the session root, so
        every path landed one level deep and the gate was a permanent silent
        no-op. Paths derived canonically; tests rebuilt to the production shape.
  - [x] **High** — the warm-pool pre-install POSTs `/install` directly, bypassing
        `runInstall`. Gated at its own call site; the plan's caller table
        corrected (it claimed those lines were comments).
  - [x] **Medium** — a withheld install still published an overlay base stamped
        with commands that never ran, laundering them into the gate's own
        anchor. `runInstall` now returns `withheld`; the publish is skipped.
  - [x] **Medium** — a throw in the notice hook turned a withhold into a failed
        install and latched dependent services to `error`. Wrapped, with a test.
  - [x] **Low** — `appliedInstallCommands` means "what the config declares", not
        "what ran"; documented at the call site.
- [x] Re-verified the tests fail on today's code after the path fix (3 red)
- [x] Tracker synced (comment on planning#400)
