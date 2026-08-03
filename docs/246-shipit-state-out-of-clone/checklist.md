# Checklist — ShipIt state out of the session clone

## Landed

- [x] `<sessionDir>/state/` in `session-dir-factory.ts` + `session-state-dir.ts` owning every artifact path
- [x] Resolve the state dir via the shared `workspace/` contract (`sessionStateDirForWorkspace`), never a bare `dirname` — threaded into `ServiceManager` as `sessionStateDir`
- [x] `compose.override.yml` → state dir, absolute `-f` via `ComposeCli.overrideFile`; docs/150 chown handoff dropped (nothing in-container reads it now)
- [x] `.env.agent` → state dir, orchestrator-side only (restores docs/087 §403), sweeping any pre-246 in-clone copy
- [x] `sweepLegacyCloneArtifacts()` implemented + tested (working tree only, keeps user files, idempotent)

## Remaining

- [ ] `/session-state` mount in `container-lifecycle.ts`; entrypoint chown coverage
- [ ] `.install-done` → `/session-state` (install-controller, `preStampInstallMarker`, claim-session)
- [ ] `ci-logs/` → state dir; CI-fix prompt cites the in-container path; drop `ensureShipitGitignored` (req 2 forbids editing the user's tracked `.gitignore`)
- [ ] Call `sweepLegacyCloneArtifacts()` on session boot — implemented but not yet wired to a caller
- [ ] Guard test: no writer composes `path.join(workspaceDir, ".shipit", …)`
- [ ] Update `shipit-docs/secrets.md` (says `.env.agent` "lives in the workspace") + `shipit-yaml.md` (cites `.shipit/.install-done`)
- [ ] Fresh-context review of the branch diff against every numbered requirement

## Known gap

- Legacy flat-layout sessions (`sessionDir === workspaceDir`) keep the in-clone
  placement: the session dir can't be identified from the clone path, and
  guessing would collide every session's state in `sessionsRoot`. The durable
  fix is a `stateDir` column on the session record. No session created by the
  current `createSessionDirFactory` is affected.
