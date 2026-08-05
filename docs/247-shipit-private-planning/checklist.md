# ShipIt private planning — checklist

## Blocked on the human

- [ ] Create `nikzlabs/shipit-planning` and confirm the deployment's GitHub credential reaches it (req 5).
- [x] Settle the repository and the tracker name. *(`nikzlabs/shipit-planning`, declared as `planning` — req 1.)*
- [x] Confirm whether "fully retire Linear" is scoped to ShipIt's own planning or extends to removing Linear support from the product. *(Answered by 248 req 3: `linear` is a declared kind, so support stays in the product and ShipIt retires it for itself by not declaring it.)*

## Migration

- [ ] Land, release and **deploy** [248](../248-declared-issue-trackers/checklist.md)'s rework, then re-probe from a fresh session to confirm the shim addresses trackers by name. A merge is not enough — the shim in a container comes from the deployed orchestrator.
- [ ] Export all Linear issues with comments by walking `SHI-1…SHI-316`, outside the git workspace.
- [ ] Copy every issue into the planning repository, preserving each comment's original date, and emit the `SHI-N → planning#M` mapping as a durable artifact.
- [ ] Declare the planning tracker in `shipit.yaml` and verify the tab, a full write round-trip, and Undo.
- [ ] Rewrite every reference from the mapping, in one PR, when nothing else is in flight. This must come after 248's name support ships, so the references are written `planning#123` the first time — the name is written into every reference, so changing it afterwards means sweeping ~620 files again. (The repository slug stays a one-line edit either way.)
- [ ] Retire Linear for ShipIt's own planning and rewrite `CLAUDE.md`'s tracker-sync section.
