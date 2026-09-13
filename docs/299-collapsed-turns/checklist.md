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
- [x] Second review, of this feature alone.
- [x] Correct the design against it: drop the per-row flags from the classifier,
      keep the rollback notice, suppress tools on a kept prose row, delete the
      issue-write undo exception, and restore the `lastProse` exclusions.
- [x] Answer the open question about action-checklist resolution state: add and
      store a submitted flag.

## Checklist submitted state

- [ ] Add `submittedAt` to `ActionChecklistCard`; it rides inside the existing
      `action_checklist` JSON column, so no migration.
- [ ] Send `action_checklist_submitted` from the card once the message is
      delivered.
- [ ] Add `updateActionChecklistCard` to `ChatHistoryManager`, mirroring
      `updateIssueWriteCard`.
- [ ] Emit `action_checklist_update` to every attached viewer, and register the
      type in `TRANSCRIPT_SCOPED_MESSAGES`.
- [ ] Test the round trip: submit, reload, and the flag survives.

## Implementation

- [ ] Add the display-turn split and the keep/hide rule beside the code it
      replaces, in the client.
- [ ] Rewrite `useCompactConversation`: newest display turn always full, no
      `activeFrom` boundary, no per-row flags; keep the focus/selection
      protection, the reading anchor and search reveal.
- [ ] Hide every tool group, including one whose tool failed.
- [ ] Render a kept prose row with `hideTools`, so a standalone tool sharing
      its row does not appear.
- [ ] Keep the `lastProse` exclusions, so an appended error row cannot displace
      the reply.
- [ ] Render a code-rollback notice even when its row is hidden.
- [ ] Hide all cards except those that still need the user, reading bug-report
      state from its store rather than from the message row.
- [ ] Keep user rows, error rows and notices.
- [ ] Keep hidden rows mounted and counted, so no card remounts.
- [ ] Rebuild the expand control as a real button.
- [ ] Update the Settings help text, which promises "all cards" today.
- [ ] Component tests, including one that goes red without each new guard.
- [ ] Test that an unsent bug-report draft survives collapsing and expanding.
- [ ] Test that a watching viewer and a reconnecting viewer see the same turns
      collapsed during a steered execution.

## Stale flags (separate bug, not a dependency)

- [ ] Clear the per-row `inProgress` and `streaming` flags on every turn-end
      path, not only `agent_result`.

## Before shipping

- [ ] `lint:dev`, `typecheck`, affected tests.
- [ ] Browser checks in a light and a dark theme, narrow and wide.
- [ ] Independent review of the implementation.
