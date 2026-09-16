# Collapsed turns

## Design

- [x] Record the user's requirements and the four reported problems.
- [x] Verify the storage, wire and caching facts the design depends on.
- [x] Write the design.
- [x] Answer the open question about action-checklist resolution state: add and
      store a submitted flag.
- [x] Split loading speed into
      [docs/300-transcript-load-speed](../300-transcript-load-speed/plan.md).
- [x] Three independent reviews, each verified against the source before the
      design was changed.

## Checklist submitted state

- [x] Add `submittedAt` to `ActionChecklistCard`; it rides inside the existing
      `action_checklist` JSON column, so no migration.
- [x] Carry the card id on the action message the card already sends, and set
      `submittedAt` when the server accepts it. No separate client frame.
- [x] Persist through `persistCardTransition`, so a running turn's rebuild
      cannot undo it.
- [x] Test submission during an active execution, and the reload.
- [x] Record the submission at each acceptance point in `handleSendMessage`,
      never before a refusal. Enforced by placement, not by a test — the reason
      is in `send-message.test.ts`.

## Display rules

- [x] Add the display-turn split and the keep/hide rule beside the code it
      replaces, in the client.
- [x] Rewrite `useCompactConversation`: newest display turn always full, no
      `activeFrom` boundary, no per-row flags.
- [x] Hide every tool group, including one whose tool failed.
- [x] Hide a tool subtree inside a retained row with the `hidden` attribute,
      never by unmounting it.
- [x] Widen the last-reply rule to a message with text, images or files.
- [x] Keep the `isError` and `rolledBack` exclusions, so an appended error row
      cannot displace the reply.
- [x] Render a code-rollback notice even when its row is hidden.
- [x] Keep the five pending-card cases in the plan's table, each reading its
      named source. The sixth, an unanswered question, was dropped after review
      found its signal does not exist on the Codex path.
- [x] Keep user rows, error rows and notices.
- [x] Keep hidden rows mounted and counted, so nothing remounts.
- [x] Make the protection guard one-way, so no row hides under a pointer that is
      already down (planning#540), and extend it to tool subtrees.
- [x] Carry the tool-collapse state into the reading-anchor signal, so expanding
      a turn whose only hidden content is a tool subtree restores the position.
- [x] Rebuild the expand control as a real button.
- [x] Narrow the "Turn ended without an agent reply." note to a turn that keeps
      nothing, so it cannot contradict what the collapsed turn shows.
- [x] Update the Settings help text, which promises "all cards" today.

## Iteration on the expand control

- [x] Hoist the run's rewind anchor above the control, and suppress the row's
      own copy in the collapsed and the expanded path (req 14).
- [x] Keep an action card in a collapsed turn whether or not it was sent, and
      take the checklist's submitted flag out of the visibility rule (req 12).
- [x] Add a fixture turn with hidden work *and* an action card, so the control
      and a kept card can be looked at together.
- [x] Make the control a chevron on a ghost button with no visible text, keeping
      its accessible name and adding it as the tooltip (req 8).

## Tests

- [x] Component tests, including one that goes red without each new guard.
- [x] An unfinished question's typed answer survives collapsing and expanding.
- [x] An unsent bug-report draft survives collapsing and expanding.
- [x] Pressing a control in a transcript with a protected turn performs the
      action.
- [x] A watching viewer and a reconnecting viewer agree on which turns are
      collapsed, with the steered case asserted as the known difference.

## Before shipping

- [x] `lint:dev`, `typecheck`, affected tests.
- [x] Browser checks in a light and a dark theme, narrow and wide.
- [x] Independent review of the implementation. Six findings; the three that
      survived verification are fixed (the question exception, the recording
      point, the reading anchor), and the tests it named as weak now exercise
      production code.
