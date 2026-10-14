# 331 — checklist

- [ ] `persist-volume.ts`: volume name and labels, `persistLayout`, the helper runner and its four scripts
- [ ] `ensurePersistVolume`: single-flight, the container check, the copy with its record, the fallback on failure
- [ ] Agent container: volume mount for the volume layout, no `scratch/` creation, the `/shipit-replay` mount
- [ ] Compose: the `persist` rewrite to the `external` volume, preparation through the helper, `dockerDesktopRefusal` limited to the scratch layout
- [ ] Compose helper: mount the volume at the scratch path
- [ ] Replay writer: `sessions/<id>/replay` for the volume layout, empty instead of replace
- [ ] Retention sweep: measure, list and empty through the helper; empty `replay/`
- [ ] Full reset: remove or empty every persist volume
- [ ] Orphan volume sweep in `steady-state-reclaim.ts`
- [ ] Boot log: the number of sessions on the old layout that have a container
- [ ] Tests, including the label guard, and a mutation pass
- [ ] Agent docs: `environment.md`, `compose.md`; wiki: `installing-and-updating.md` (req 6), `troubleshooting.md`, `how-shipit-works.md`, `sessions.md`
- [ ] docs/317 plan: mechanism, "Docker Desktop", lifecycle table and known limits; docs/323 plan: the delete step
