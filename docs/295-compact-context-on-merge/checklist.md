# 295 — Implementation checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## First — settle the one unproven thing

- [ ] Establish in code whether a compaction spawn can run in a turn's pre-spawn
      phase without the executor treating its completion as the user's turn
      finishing (`agent_result`, the `done` path, the post-turn commit
      sequence). Everything below assumes an answer to this.

## The shared step

- [ ] New `orchestrator/pre-turn-compact-hook.ts` — decide, run one compaction
      spawn (`run({ compact: true })` semantics), await it, return an outcome.
- [ ] Return an **outcome**, never bare completion: errored, compacted, or
      produced no compaction event at all.
- [ ] Give Claude the post-merge instructions in the compaction prompt; leave
      the other harnesses to ignore them.
- [ ] Do not persist a user row or echo a `/compact` bubble for the step.
- [ ] Never let the outcome gate the turn that follows (req 9).

## Wiring both transports (req 13)

- [ ] Call it from `ws-handlers/agent-execution.ts`, before `applyPreTurnReset`.
- [ ] Call it from `dispatched-turn.ts`, before `deps.preTurnReset` — once per
      dispatched message, **outside `runOnce`**, so a no-result retry does not
      compact twice.
- [ ] Apply the same `postTurn: "none"` exclusion the reset uses, so a
      rebase-conflict resolution step never compacts.
- [ ] Wire it into `SystemTurnDeps` in `runner-registry-factory.ts`, beside
      `preTurnReset`.

## Wire path for the per-send intent

- [ ] `compactContext?: boolean` on `WsSendMessage`
      (`shared/types/ws-client-messages.ts`), documented as non-sticky.
- [ ] Carry it through `ws-handlers/send-message.ts` into the turn options.
- [ ] Suppress the step when the send is already an `isCompactRequest` (req 12).

## Composer control

- [ ] `showCompactControl = showResetControl && supportsCompaction` in
      `MessageInput.tsx` — reads no usage or occupancy state (req 3, req 10).
- [ ] Checked by default, non-sticky, re-checked whenever the control reappears
      (req 2, req 5), mirroring `resetChecked`.
- [ ] Render as a subordinate line inside the existing control block, not an
      equal-weight second row.
- [ ] Put the flag on the send payload only when the control was shown.

## Setting

- [ ] Update the description of the existing "Start from the latest base after a
      merge" row in `Settings/tabs/AdvancedTab.tsx` to name both actions. No new
      setting (req 11).

## Tests

- [ ] The compaction runs before the reset, and the turn still carries the
      docs/218 merge prefix afterwards (req 7).
- [ ] A dispatched continuation compacts under the global setting, with no
      checkbox involved (req 13).
- [ ] A retried dispatched turn compacts once, not twice.
- [ ] A `postTurn: "none"` turn never compacts.
- [ ] A `/compact` send with the control visible compacts exactly once and does
      not reset the branch (req 12).
- [ ] A failed compaction still runs the turn **and** leaves a notice (req 9).
- [ ] A compaction that reports no event is not reported as a success.
- [ ] The two checkboxes are independent (req 6).
- [ ] The control is hidden when the harness cannot compact (req 10) and when
      the global setting is off (req 11).
- [ ] The control's visibility does not change with context occupancy (req 3).
- [ ] Delete each guard singly and watch it fail, so no test passes with the
      defect present.

## Close-out

- [ ] `npm run lint:dev` and `npm run typecheck` clean.
- [ ] Independent review against every numbered requirement
      (`shipit agent run --role reviewer`), review-only.
- [ ] Comment the outcome on `planning#522`.
