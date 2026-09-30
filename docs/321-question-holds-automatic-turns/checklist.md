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
- [x] Tests
- [x] Wiki
