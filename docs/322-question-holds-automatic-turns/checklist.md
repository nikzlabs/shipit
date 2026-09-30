# Checklist

- [x] Persist the mark on the session row
- [x] Set it at settlement; clear it when a non-automatic turn starts
- [x] `automatic` dispatch option, carried through queue, steer and turn input
- [x] Mark every automatic dispatch site
- [x] Dispatch admission gate, and no steering into a turn ending on a question
- [x] Queue take passes over held automatic entries
- [x] A turn that ends on a question keeps its queued automatic entries
- [x] Remediation managers defer while held
- [x] Rebase flow stops after a resolution turn asks
- [x] Preview auto-fix dispatches as automatic
- [x] Review fixes: queued reply kept, setup-failure take, stale remediation check, Retry by user
- [x] Stop a turn the agent's CLI starts by itself while held (req 7)
- [x] Save held turns in the database; restore at a user turn; wake-ups saved without booting (req 8)
- [x] Second review: save at every busy gate, keep the row until the turn starts, rebind a restarted delivery, user first after restore, cancel forgets the row, user Stop still discards, deferred Retry stays the user's
- [x] Tests
- [x] Wiki
