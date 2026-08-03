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
- [x] One resolver for host and container (`sessionStateDirForWorkspace`), so the mount and every host-side writer can't disagree; `SHIPIT_SESSION_STATE_DIR` points the worker at the mount
- [x] Legacy flat-layout fallback deleted (SHI-286) — see below
- [x] Full suite green (one pre-existing, environment-only failure in `mcp-bridge-bundle.test.ts` — reproduces on clean `main`)
- [x] Fresh-context adversarial review (Codex) against the requirements — 6 findings, 4 fixed here, 2 recorded as known gaps below

## Fixed from the review

- [x] **Flat-layout sessions shared one state dir.** The runner factory passes `sessionDir = dirname(session.workspaceDir)` (`app-lifecycle.ts:555`), so a flat session resolved to `<sessionsRoot>/state` — outside its own clone (so the containment check passed) but shared by every flat session, while host callers looked elsewhere. `resolveContainerStateDir()` now derives from the clone path via the same contract the host uses, so the two sides cannot disagree.
- [x] **The marker outlived the clone it describes.** `REGENERABLE_SESSION_SUBDIRS` reclaimed `workspace/` + `overlay/` but preserved `state/`, so after an eviction/restore the marker still matched a checkout whose deps were gone → `{ skipped: true }` → dep-less session. `state` is now reclaimed with them.
- [x] **`.env.agent` was not actually orchestrator-only.** The whole state dir was mounted, so it and the compose override sat in the container namespace. Only `state/shared/` (marker + CI logs) is mounted now; the orchestrator-only artifacts are unreachable by layout rather than by claim.
- [x] **The sweep deleted by filename alone.** A repo may legitimately track `.shipit/ci-logs/` or its own `compose.override.yml`; deletion was silent and would land in the next auto-commit. `git ls-files` is now the provenance check, and an unknown answer counts as tracked.
- [x] **The guard test was defeatable.** It enumerated the four artifact names and required them in the same expression as `.shipit`, so a future artifact was invisible and `service-manager.ts` already defeated it by splitting the path across two lines. It now matches the directory join itself.

## Known gaps

- **Grandfathered containers (review finding 1).** `deploy.sh` deliberately preserves session containers across an upgrade (docs/113), and boot rotation only replaces a worker when no turn is active. Such a container keeps the OLD worker: it writes the marker in the clone, never runs the sweep, and — the real regression — the new CI-fix code hands its agent `/session-state/ci-logs/...`, a path that container has no mount for, so a full-log read fails. The log excerpt and error lines are inline in the prompt regardless, and the container self-heals on next recreate. Closing it properly means gating reuse on mount compatibility, which is a container-lifecycle change beyond this feature.
- ~~**Docker-secrets entrypoint.**~~ **Closed by SHI-285.** The wrapper is now staged at `<SHIPIT_SECRETS_INTERNAL_DIR>/_entrypoint/secrets-entrypoint.sh` and bind-mounted into service containers by absolute path, so the mount no longer rides the workspace volume and nothing is written into the clone. It went to the secrets root rather than the state dir because the mount source is resolved by the Docker **daemon**: the secrets root is the one directory this mode already maps daemon-side (`SHIPIT_SECRETS_HOST_DIR`, used by every `secrets: file:` reference), while the state dir has no daemon-side path when the orchestrator is containerized and sessions live on a named volume. The wrapper is also a static baked asset, identical for every session — not session state. The `service-secrets-resolver.ts` entry is gone from `ALLOWED` in `no-clone-writes.test.ts`, so req 1 is now mechanically enforced for this mode too. `secrets-entrypoint.sh` joined `LEGACY_CLONE_ARTIFACTS` so an upgraded session loses the copy an earlier version left in its clone (req 6).
- ~~**Legacy flat-layout sessions.**~~ **Closed by SHI-286.** A census of the
  production database answered the open question — `flat == 0` of 307 rows,
  archived included — so the fallback was dead weight and is gone.
  `sessionStateDirForWorkspace()` now **throws** for a clone that isn't
  `<sessionDir>/workspace` instead of returning `null`, and the in-clone
  defaults that existed to serve that `null` (`compose-cli.ts`,
  `service-manager.ts`, `overlay-session.ts`, `secret-resolver.ts`) are deleted
  along with `resolveContainerStateDir` (a pure alias once its containment check
  became structurally redundant) and the two dependent branches it kept alive:
  the sweep's gate on having a state dir, and `buildEnv`'s
  `SHIPIT_SESSION_STATE_DIR` fallback to `${workspaceDir}/.shipit` — which the
  guard test never saw, because a template literal doesn't match its pattern.
  `ContainerConfig.workspaceDir` / `.sessionStateDir` are required now, so
  "session with no state dir" is unrepresentable rather than merely unreached.
  **The consequence is accepted, not overlooked**: a restored old backup, or
  another deployment carrying flat-layout rows, is now *unserviceable* rather
  than degraded (human decision recorded on SHI-286).

  Requirement 1 is unconditional as a result — `ALLOWED` in
  `no-clone-writes.test.ts` no longer holds a single site that writes a docs/246
  artifact into a clone.

## Out of scope, surfaced by SHI-286

- **docs/183's in-clone per-service env fallback.** `writePerServiceEnvFiles`
  (`secret-resolver.ts`) still writes `.shipit/.env.<svc>` into the clone when
  neither Docker-secrets mode nor `serviceEnvDir` is configured. That is not a
  docs/246 artifact and has its own migration story
  (`writeServiceEnvFilesToRoot` sweeps the leftovers), and it is unreachable in
  production — `serviceEnvDir` defaults to `<stateDir>/service-env`
  (`bootstrap-managers.ts`), so only tests and non-container setups take it. It
  is why `secret-resolver.ts` keeps its `ALLOWED` entry; recorded here rather
  than allowlisted silently.
