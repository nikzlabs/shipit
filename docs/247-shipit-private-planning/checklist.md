# ShipIt private planning — checklist

## Blocked on the human

- [ ] Create the private planning repository — recommended slug `nikzlabs/shipit-planning` — and confirm the deployment's GitHub credential reaches it (req 5).
- [ ] Fix the tracker name before the reference rewrite, not after. `planning` (req 1) is written into every reference, so changing it later means sweeping ~620 files again; the repository slug, by contrast, stays a one-line edit.
- [x] Confirm whether "fully retire Linear" is scoped to ShipIt's own planning or extends to removing Linear support from the product. *(Answered by 248 req 3: `linear` becomes a declared kind, so support stays in the product and ShipIt retires it for itself by not declaring it.)*

## Migration

- [ ] Release and deploy the merged `--repo` support; re-probe from a fresh session to confirm the shim has it.
- [ ] Export all Linear issues with comments by walking `SHI-1…SHI-316`, outside the git workspace.
- [ ] Land tracker names ([248](../248-declared-issue-trackers/checklist.md)) before the reference rewrite, so the rewrite does not hard-code a repository slug into ~620 files and have to be repeated on the first rename.
- [ ] Copy every issue into the planning repository, preserving comment authors and dates, and emit the `SHI-N → planning#M` mapping as a durable artifact.
- [ ] Rewrite every reference from the mapping, in one PR, when nothing else is in flight.
- [ ] Declare the planning tracker in `shipit.yaml` and verify the tab, a full write round-trip, and Undo.
- [ ] Retire Linear for ShipIt's own planning and rewrite `CLAUDE.md`'s tracker-sync section.
