# 331 — checklist

- [x] `persist-volume.ts`: the volume name, `persistLayout`; the per-session gate and its three rules (`persist-gate.ts`)
- [x] The helper runner and its four scripts (prepare, copy, measure, empty), with labels and capabilities per script
- [x] The copy (`forAgent`): remove a running stack's containers, remove leftover helpers, the container check, flush, the durable record, removal of `scratch/`, the fallback on failure
- [x] Agent container: the volume mount for the volume layout, the copy before the shared lease in `createContainer`, `restartService` for a kept preview after the copy, no `scratch/` creation
- [x] The late-bound restarter over the `serviceManagers` map
- [x] Compose: one shared lease from layout to `up`, the `persist` rewrite to the `external` volume, preparation through the helper, `dockerDesktopRefusal` limited to the scratch layout
- [x] Compose helper: the volume at the scratch path, and the shared gate around each run
- [x] Replay writer: `uploads/.shipit-replay`; `deleteUpload` takes one name only
- [x] Retention sweep: measure (symlinks counted) and empty through the helper, under the gate, only with no container
- [x] Full reset: stop every service manager, remove each session's containers by label, then its persist volume
- [x] Orphan volume sweep in `steady-state-reclaim.ts`
- [x] Fixes from the review: a volume ShipIt did not make is refused (and the Docker proxy reserves the name), the record is final once renamed, removals take this install's containers only, leftover helpers are removed, retention decides again between parts, the backup stops on a failed listing
- [x] Tests, including the name-pattern test and the label guard, and a mutation pass
- [x] Agent docs: `environment.md`, `compose.md`; wiki: `installing-and-updating.md` with the backup and restore scripts (req 6), `troubleshooting.md`, `how-shipit-works.md` (`sessions.md` needed no change)
- [x] docs/317 plan: mechanism, "Docker Desktop", lifecycle table and known limits; docs/323 plan: the delete step
