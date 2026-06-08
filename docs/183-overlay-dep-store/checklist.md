# Checklist — canonical dependency volume vs. copy-based nm-store

This doc is a design evaluation. Decision: **overlay is the primary unified mechanism;
hardlink is a fallback only.** Remaining work to move from proposal to implementation:

- [ ] Spike the orchestrator host-side overlay mount subsystem (mount on activate,
      unmount + workdir cleanup on dispose) and size its real cost
- [ ] Confirm host kernel/fs support overlayfs lowerdir sharing on the prod VPS (ext4)
- [ ] Make `disk-janitor` + archive flows aware of live overlay mounts before teardown
- [ ] Verify the host-mount route stays within the containment model (docs/172)
- [ ] Confirm `runtimeKey` covers compiled wheels (arch + libc + python version) so the
      canonical lower layer is never reused across incompatible runtimes
- [ ] Python: validate the "build canonical venv at /workspace/.venv, overlay back at the
      same path" approach end-to-end (pyvenv.cfg + shebangs intact)
- [ ] Fallback prototype: hardlink-from-store materialize ladder behind a flag, for
      hosts without the mount layer; guard in-place mutation; dumb-copy managers only
- [ ] Benchmark cache-hit time: overlay mount vs. hardlink vs. today's `tar`/`cp -a` on a
      large repo (ShipIt itself, ~588 packages)
