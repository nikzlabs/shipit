# Checklist — overlay-mounted canonical dependency layer

This doc is a design proposal. Decision: **overlay is the mechanism; hardlink was
considered and rejected.** Remaining work to move from proposal to implementation:

- [ ] Rename `nm-store` → `dep-store` (module `nm-store.ts` → `dep-store.ts`, store path
      `/dep-cache/nm-store/<key>` → `/dep-cache/dep-store/<key>`) — self-contained precursor
- [ ] Spike the orchestrator host-side overlay mount subsystem (mount on activate,
      unmount + workdir cleanup on dispose) and size its real cost
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [ ] Make `disk-janitor` + archive flows aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm `runtimeKey` covers compiled wheels (arch + libc + python version) so the
      canonical lower layer is never reused across incompatible runtimes
- [ ] Keep the existing narrow gate (allowlisted command + single top-level lockfile);
      confirm arbitrary/nested/monorepo installs still fall through to a plain install
- [ ] Make the fast-path gate yield a deterministic mount-target path per manager
      (`node_modules` for Node; a standardized venv path for Python)
- [ ] Prototype warm-base populate (restore nearest layer → run install on top → publish
      merged); measure warm-install time for "nothing changed" / "one dep added" vs. cold
- [ ] Decide base lineage keying (per repo + per lockfile) so concurrent sessions don't
      fork the baseline; reuse the atomic-rename publish to dedupe
- [ ] Decide overlay-stack flatten cadence (depth cap) and periodic clean-rebuild policy
      to bound drift from incremental installs (note `npm ci` wipes — no warm-base gain)
- [ ] Python: validate the "build canonical venv at /workspace/.venv, overlay back at the
      same path" approach end-to-end (pyvenv.cfg + shebangs intact)
- [ ] Benchmark cache-hit time: overlay mount vs. today's `tar`/`cp -a` on a large repo
      (ShipIt itself, ~588 packages)
