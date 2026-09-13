# Collapsed turns

## Design

- [x] Record the user's requirements and the four reported problems.
- [x] Verify the storage, wire and caching facts the design depends on.
- [x] Write the design.
- [x] Answer the open question about cards that still need the user.
- [x] Get an independent review of the design.
- [x] Correct the design against the review.
- [x] Split loading speed into
      [docs/300-transcript-load-speed](../300-transcript-load-speed/plan.md).

## Implementation

- [ ] Add the display-turn split and the keep/hide rule in
      `src/server/shared/collapsed-turns.ts`.
- [ ] Rewrite `useCompactConversation`: newest turn always full, no `activeFrom`
      boundary; keep the focus/selection protection and the reading anchor.
- [ ] Hide every tool group, including one whose tool failed, and every message
      that carries an unfolded tool.
- [ ] Hide all cards except those that still need the user.
- [ ] Keep user rows, error rows and notices.
- [ ] Keep hidden rows mounted and counted, so no card remounts.
- [ ] Rebuild the expand control as a real button.
- [ ] Component tests, including one that goes red without each new guard.
- [ ] Test that an unsent bug-report draft survives collapsing and expanding.

## Stale flags (separate change)

- [ ] Clear the per-row `inProgress` and `streaming` flags on every turn-end
      path, not only `agent_result`.

## Before shipping

- [ ] `lint:dev`, `typecheck`, affected tests.
- [ ] Browser checks in a light and a dark theme, narrow and wide.
- [ ] Independent review of the implementation.
