# 256 — checklist

Tracking lives here, not in Linear: ShipIt is mid-migration off Linear
(docs/247) and this branch deliberately files no new issues.

## Landed

- [x] Verify the current reclamation map at the source → `investigation.md`
- [x] Write `requirements.md` from what Nik asked for, with the invented parts
      under `## Open questions`
- [x] Batch the open questions into one ask; record each answer as a dated
      receipt and fold it into the numbered requirements
- [x] `plan.md` — design against the answered requirements
- [x] **Bug fix (independent of the requirements):** `canAutoDescend` now skips
      a session with an always-on preview reservation, so the disk ladder stops
      destroying the container docs/241 promises to keep up
      (`tier-escalation.ts`, guard test in `disk-tier-escalation.test.ts`)

## Implementation — not started

- [ ] `shipit session keepalive run -- <cmd>` and `keepalive status` in the
      shim, with dispatch, HELP, and the rejected-subcommand gate
- [ ] `/agent-ops/keepalive/*` broker + the session-scoped orchestrator route
- [ ] Hold map + `keepaliveHoldCount` on the runner; fold into `agentBusy`;
      non-forced `dispose()` refusal
- [ ] Persisted transcript card when a forced teardown kills live holds
      (full card recipe — typed field, migration, rehydration,
      `CARD_MESSAGE_FIELDS`, both guard tests)
- [ ] Guard tests: idle enforcer and `canAutoDescend` both skip a held session;
      a held session survives simulated memory pressure; an expired hold does
      not protect
- [ ] Update `src/server/shipit-docs/environment.md` and `sessions.md` — the
      "runtime background work has no durability guarantee" promise changes
      here, including that a hold does not protect against a user restart
- [ ] State the three protections' scopes in the `pinnedAt` /
      `keepPreviewRunning` type comments (req 5); the pin's UI copy was checked
      and needs no change
- [ ] Independent cross-backend review of the branch against every numbered
      requirement (`shipit agent run --agent codex`)
