# 331 — checklist

- [ ] `persist-volume.ts`: the volume name, `persistLayout`, the boot id, the per-session gate and its three rules
- [ ] The helper runner and its four scripts (prepare, copy, measure, empty), with labels and capabilities per script
- [ ] `ensurePersistVolume` and the copy: remove a running stack's containers, remove leftover helpers, the container check, flush, the durable record, removal of `scratch/`, the fallback on failure
- [ ] Agent container: the volume mount for the volume layout, the copy before the shared lease in `createContainer`, `restartService` for a kept preview after the copy, no `scratch/` creation
- [ ] The late-bound `serviceManagers` accessor for the runner factory
- [ ] Compose: one shared lease from layout to `up`, the `persist` rewrite to the `external` volume, preparation through the helper, `dockerDesktopRefusal` limited to the scratch layout
- [ ] Compose helper: the volume at the scratch path, and the shared gate around each run
- [ ] Replay writer: `uploads/.shipit-replay`; `deleteUpload` takes one name only
- [ ] Retention sweep: measure (symlinks counted) and empty through the helper, under the gate, only with no container
- [ ] Full reset: stop every service manager, remove each session's containers by label, then its persist volume
- [ ] Orphan volume sweep in `steady-state-reclaim.ts`
- [ ] Tests, including the name-pattern test and the label guard, and a mutation pass
- [ ] Agent docs: `environment.md`, `compose.md`; wiki: `installing-and-updating.md` with the backup and restore scripts (req 6), `troubleshooting.md`, `how-shipit-works.md`, `sessions.md`
- [ ] docs/317 plan: mechanism, "Docker Desktop", lifecycle table and known limits; docs/323 plan: the delete step
