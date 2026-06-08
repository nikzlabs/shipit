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
- [ ] Python: validate the "build canonical venv at /workspace/.venv, overlay back at the
      same path" approach end-to-end (pyvenv.cfg + shebangs intact)
- [ ] Benchmark cache-hit time: overlay mount vs. today's `tar`/`cp -a` on a large repo
      (ShipIt itself, ~588 packages)
