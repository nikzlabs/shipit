# ShipIt private planning — checklist

## Blocked on the human

- [ ] Create the private planning repository and confirm the deployment's GitHub credential reaches it (requirement 3; open question 1).
- [ ] Confirm whether "fully retire Linear" is scoped to ShipIt's own planning or extends to removing Linear support from the product (open question 2).

## Migration

- [ ] Release and deploy the merged `--repo` support; re-probe from a fresh session to confirm the shim has it.
- [ ] Export all Linear issues with comments by walking `SHI-1…SHI-316`, outside the git workspace.
- [ ] Land alias support ([248](../248-declared-issue-trackers/checklist.md)) before the reference rewrite, so the rewrite does not hard-code a repository slug into ~620 files.
- [ ] Add an `issues.default` requirements doc and implement it, so a bare `shipit issue create` does not file into a retired tracker.
- [ ] Copy every issue into the planning repository, preserving comment authors and dates, and emit the `SHI-N → planning#M` mapping as a durable artifact.
- [ ] Rewrite every reference from the mapping, in one PR, when nothing else is in flight.
- [ ] Declare the planning tracker in `shipit.yaml` and verify the tab, a full write round-trip, and Undo.
- [ ] Retire Linear for ShipIt's own planning and rewrite `CLAUDE.md`'s tracker-sync section.
