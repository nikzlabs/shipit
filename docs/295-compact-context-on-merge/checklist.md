# 295 — Implementation checklist

Design: [plan.md](./plan.md). Requirements: [requirements.md](./requirements.md).

## Blocked

- [ ] Answer the open question in `requirements.md`: does a continuation the
      user did not type also compact? Implementation waits for it.

## Wire path

- [ ] Add `compactContext?: boolean` to `WsSendMessage`
      (`shared/types/ws-client-messages.ts`), documented as non-sticky per-send
      intent beside `resetMergedBranch`.
- [ ] Carry it through `ws-handlers/send-message.ts` into the idle send path.

## The compaction pre-step

- [ ] In the idle path of `send-message.ts`, when the intent is set, the backend
      declares `supportsCompaction`, and the send is **not** already an
      `isCompactRequest` (req 12), run the compaction turn before the user's
      turn.
- [ ] Give the compaction turn Claude's post-merge instructions in its prompt;
      leave the other harnesses to ignore them.
- [ ] Do not persist a user row or echo a `/compact` bubble for the synthetic
      turn.
- [ ] Await it, and never let its outcome gate the user's turn (req 9).
- [ ] Report the outcome, not the completion: a notice when the turn errored,
      and a notice when the turn produced no compaction event at all (req 9,
      docs/276 req 2).

## Composer control

- [ ] `showCompactControl = showResetControl && supportsCompaction` in
      `MessageInput.tsx` — no usage or occupancy state read (req 3, req 10).
- [ ] Checked by default, non-sticky, re-checked whenever the control reappears
      (req 2, req 5), mirroring `resetChecked`.
- [ ] Render it as a subordinate line inside the existing control block, not as
      an equal-weight second row.
- [ ] Put the flag on the send payload only when the control was shown.

## Setting

- [ ] Update the description of the existing "Start from the latest base after a
      merge" row in `Settings/tabs/AdvancedTab.tsx` to name both actions. No new
      setting (req 11).

## Tests

- [ ] The compaction turn runs before the user's turn, and the user's turn still
      carries the docs/218 merge prefix (req 7).
- [ ] A `/compact` send with the control visible compacts exactly once and does
      not reset the branch (req 12).
- [ ] A failed compaction still runs the user's turn **and** leaves a notice
      (req 9). Prove the notice case goes red without the fix.
- [ ] A compaction that reports nothing is not reported as a success.
- [ ] The two checkboxes are independent: unticking either does not change what
      the other does (req 6).
- [ ] The control is hidden when the harness declares `supportsCompaction:
      false` (req 10), and hidden when the global setting is off (req 11).
- [ ] The control's visibility does not change with context occupancy (req 3).

## Close-out

- [ ] `npm run lint:dev` and `npm run typecheck` clean.
- [ ] Independent review against every numbered requirement
      (`shipit agent run --role reviewer`), review-only.
- [ ] Comment the outcome on `planning#522`.
