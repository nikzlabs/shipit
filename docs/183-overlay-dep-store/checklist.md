# Checklist — overlay-mounted canonical dependency layer

This doc is a design proposal. Decision: **overlay is the mechanism; a keyless rolling
base per repo (always warm-install on top) is the primary routing, with a keyed skip as an
optional optimization. Hardlink was considered and rejected.** Remaining work:

- [ ] Rename `nm-store` → `dep-store` (module `nm-store.ts` → `dep-store.ts`, store path
      `/dep-cache/nm-store/<key>` → `/dep-cache/dep-store/<base>`) — self-contained precursor
- [ ] Spike the orchestrator host-side overlay mount subsystem (mount on activate,
      unmount + workdir cleanup on dispose) and size its real cost
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [ ] Make `disk-janitor` + archive flows aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm the runtime fingerprint covers compiled wheels (arch + libc + python
      version) so a base is never reused across incompatible runtimes
- [ ] Make the base yield a deterministic mount-target path per manager
      (`node_modules` for Node; a standardized venv path for Python)
- [ ] Prototype the keyless rolling base: mount current base → run real install on top →
      advance via optimistic compare-and-swap (parallel installs, serialized publish)
- [ ] Measure warm-install time: "nothing changed", "one dep added", and "alternating
      divergent branches" (thrash case) vs. cold — confirms the chain holds up
- [ ] Decide overlay-stack flatten cadence (depth cap) and periodic clean-rebuild policy
      to bound drift from incremental installs (note `npm ci` wipes — no warm-base gain)
- [ ] Decide whether to add the optional detection-free manifest fingerprint (glob-hash of
      all manifests, not single-lockfile detection) to skip no-op installs / avoid thrash
- [ ] Python: validate "build venv at /workspace/.venv, overlay back at the same path"
      end-to-end (pyvenv.cfg + shebangs intact)
