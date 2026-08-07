# 256 — checklist

Tracking lives here, not in Linear: ShipIt is mid-migration off Linear
(docs/247) and this branch deliberately files no new issues.

## Landed

- [x] Verify the current reclamation map at the source → `investigation.md`
- [x] Write `requirements.md` from what Nik asked for, with the invented parts
      under `## Open questions`
- [x] **Bug fix (independent of the open questions):** `canAutoDescend` now
      skips a session with an always-on preview reservation, so the disk ladder
      stops destroying the container docs/241 promises to keep up
      (`tier-escalation.ts`, guard test in `disk-tier-escalation.test.ts`)

## Blocked on Nik's answers

- [ ] Resolve the four open questions in `requirements.md` (asked as one
      batched question; each answer gets a dated receipt under
      `## Resolved questions` and edits the numbered requirements in the same
      diff)
- [ ] `plan.md` — design, citing requirements as `(req N)`
- [ ] Decide whether `pinnedAt` should also gate idle disposal, or whether
      requirement 5 is satisfied some other way
- [ ] Implementation + tests
- [ ] Update `src/server/shipit-docs/environment.md` — it currently tells the
      agent, correctly, that runtime background work has no durability
      guarantee. Whatever ships here changes that promise and the agent-facing
      copy has to change with it.
- [ ] Independent cross-backend review of the branch against every numbered
      requirement (`shipit agent run --agent codex`)
