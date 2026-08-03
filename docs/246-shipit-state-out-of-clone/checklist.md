# Checklist — ShipIt state out of the session clone

- [x] `<sessionDir>/state/` in `session-dir-factory.ts` + `session-state-dir.ts` owning every artifact path
- [x] Resolve the state dir via the shared `workspace/` contract (`sessionStateDirForWorkspace`), never a bare `dirname` — threaded into `ServiceManager` as `sessionStateDir`
- [x] Container mount point + artifact filenames in `shared/fs-constants.ts` (session code may not import from `orchestrator/`)
- [x] `/session-state` mount in `container-lifecycle.ts`; entrypoint chown coverage
- [x] `compose.override.yml` → state dir, absolute `-f` via `ComposeCli.overrideFile`; docs/150 chown handoff dropped
- [x] `.env.agent` → state dir, orchestrator-side only (restores docs/087 §403)
- [x] `.install-done` → `/session-state` (install-controller, `preStampInstallMarker`, claim-session)
- [x] `ci-logs/` → state dir; CI-fix prompt cites the absolute container path; `ensureShipitGitignored` deleted (req 2 forbids editing the user's tracked `.gitignore`)
- [x] `sweepLegacyCloneArtifacts()` wired into container create — working tree only, keeps user files, idempotent
- [x] Guard test: no generated artifact name composed with an in-clone `.shipit` path (`no-clone-writes.test.ts`)
- [x] `shipit-docs/shipit-yaml.md` + `secrets.md` updated for the new paths; the "add `.shipit` to your `.gitignore`" onboarding step is gone
- [x] Worker state dir injected (`SessionWorkerDeps.stateDir`) rather than hardcoded to the mount — the first CI run caught the in-process case
- [x] Containment check (`resolveContainerStateDir`) — never mount a state dir inside the clone; `SHIPIT_SESSION_STATE_DIR` tells the worker where to write when there is no mount
- [x] Sweep gated on having a state dir, so a live in-clone marker isn't deleted every boot
- [x] Full suite green (one pre-existing, environment-only failure in `mcp-bridge-bundle.test.ts` — reproduces on clean `main`)
- [ ] Fresh-context review of the branch diff against every numbered requirement — running via `shipit agent run --agent codex`

## Known gap

- Legacy flat-layout sessions (`sessionDir === workspaceDir`) keep the in-clone
  placement: the session dir can't be identified from the clone path, and
  guessing would collide every session's state in `sessionsRoot`. The durable
  fix is a `stateDir` column on the session record. No session created by the
  current `createSessionDirFactory` is affected, and the boot sweep still
  removes leftovers from those clones.
