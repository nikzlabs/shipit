# Checklist — ShipIt state out of the session clone

- [x] `<sessionDir>/state/` in `session-dir-factory.ts` + `session-state-dir.ts` owning every artifact path
- [x] Resolve the state dir via the shared `workspace/` contract (`sessionStateDirForWorkspace`), never a bare `dirname` — threaded into `ServiceManager` as `sessionStateDir`
- [x] Container mount point + artifact filenames in `shared/fs-constants.ts` (session code may not import from `orchestrator/`)
- [x] `/session-state` mount in `container-lifecycle.ts`; entrypoint chown coverage
- [x] `compose.override.yml` → state dir, absolute `-f` via `ComposeCli.overrideFile`; docs/150 chown handoff dropped
- [x] `.env.agent` → state dir, orchestrator-side only (restores docs/087 §403)
- [x] `.install-done` → `/session-state` (install-controller, `preStampInstallMarker`, claim-session)
- [x] `ci-logs/` → state dir; CI-fix prompt cites the absolute container path; `ensureShipitGitignored` deleted (req 2 forbids editing the user's tracked `.gitignore`)
- [x] `sweepLegacyCloneArtifacts()` wired into container create — working tree only, keeps user files, idempotent. **Since retired** — see "The migration is done" below
- [x] Guard test: no generated artifact name composed with an in-clone `.shipit` path (`no-clone-writes.test.ts`)
- [x] `shipit-docs/shipit-yaml.md` + `secrets.md` updated for the new paths; the "add `.shipit` to your `.gitignore`" onboarding step is gone
- [x] Worker state dir injected (`SessionWorkerDeps.stateDir`) rather than hardcoded to the mount — the first CI run caught the in-process case
- [x] One resolver for host and container (`sessionStateDirForWorkspace`), so the mount and every host-side writer can't disagree; `SHIPIT_SESSION_STATE_DIR` points the worker at the mount
- [x] Legacy flat-layout fallback deleted (SHI-286) — see below
- [x] Full suite green (one pre-existing, environment-only failure in `mcp-bridge-bundle.test.ts` — reproduces on clean `main`)
- [x] Fresh-context adversarial review (Codex) against the requirements — 6 findings, 4 fixed here, 2 recorded as known gaps below
- [x] One-time migration retired after it had served its purpose — see below

## The migration is done, and the code for it is gone

Requirement 6 — "sessions that already have these files in their clone stop
having them" — has been honoured, and the machinery that honoured it was deleted
once it had nothing left to do. Removed: `sweepLegacyCloneArtifacts()`,
`LEGACY_CLONE_ARTIFACTS` and the `isTrackedByGit()` provenance helper that
existed only to serve the sweep (`session-state-dir.ts`), the sweep's call site
in `container-lifecycle.ts`, and the three pre-246 unlinks that shed an older
ShipIt's leftovers on the paths that touched them (`services/claim-session.ts`,
`session/install-controller.ts`, `secret-resolver.ts`). The placement work — the
state dir, the `/session-state` mount, the artifact constants, and the
`no-clone-writes.test.ts` guard — is untouched. This deletes the migration tail,
not the feature.

**Why it was safe, which is the durable part of this note:**

- **The migration has already run.** The sweep fired on every container create,
  and the three unlinks on every claim / `/install` / `.env.agent` write, for the
  whole period docs/246 has been deployed. On a single-instance deployment that
  is not "will eventually run" — it is "has run", repeatedly, on every session
  that has booted a container since. There is nothing left for it to find.
- The migration only ever removed files an **older** ShipIt wrote. Current code
  writes none of them into a clone — that is exactly what the guard test pins.
- This deployment is a single production instance with a single user, so there
  is no fleet of older orchestrators to wait for before dropping migration code.

**A correction, because the first draft of this note got it wrong.** The
retirement was originally justified with "disk-tier eviction performs the same
cleanup for free — reclaim deletes the clone and the restore re-clones, so a
fresh clone cannot hold untracked leftovers." The fresh-context review checked
that claim against the code and it does not hold. `reclaimToEvicted`
(`tier-escalation.ts:180`) remediates a **dirty** checkout before wiping it: an
untracked leftover makes the tree dirty, so `git add -A` stages it and
`autoCommit` + `push` put it in the user's branch. Eviction therefore *commits*
a leftover rather than discarding it, and the restore clones it back — now
tracked. Eviction is not a migration substitute, and the argument is not
load-bearing for this change; the three bullets above are.

**The accepted residual:** a session that still holds a leftover keeps it, and it
can be committed — by the post-turn `git add -A` on the next turn, or by the
eviction auto-commit above. `GitManager.autoCommit`'s secret scanner is a partial
backstop for the `.env.agent` case only. Accepted by the user rather than
overlooked; the exposure is bounded by the first bullet.

Two **pre-existing, unrelated** bugs the review surfaced while checking that
rationale are recorded in the tracker rather than fixed here (this is a deletion
PR): **SHI-293** — `state/` is listed in `REGENERABLE_SESSION_SUBDIRS` but
`reclaimRegenerableSessionDirs` only removes `workspace/` and `overlay/`
(`disk-utils.ts:128`); and **SHI-294** — `reclaimToEvicted` wipes the workspace
even when `autoCommit` **refused** the commit over a secret finding, losing
uncommitted work (`tier-escalation.ts:192`).

This also retires SHI-289 (below) by deletion: there is no longer a sweep for
local mode to be missing.

## Fixed from the review

- [x] **Flat-layout sessions shared one state dir.** The runner factory passes `sessionDir = dirname(session.workspaceDir)` (`app-lifecycle.ts:555`), so a flat session resolved to `<sessionsRoot>/state` — outside its own clone (so the containment check passed) but shared by every flat session, while host callers looked elsewhere. The fix derived the container side from the clone path via the same contract the host uses, so the two sides cannot disagree. (It landed as `resolveContainerStateDir()`; SHI-286 then deleted that wrapper as a pure alias and left `sessionStateDirForWorkspace()` as the one resolver — see below.)
- [ ] **The marker outlived the clone it describes — STILL OPEN, the fix was incomplete.** `REGENERABLE_SESSION_SUBDIRS` reclaimed `workspace/` + `overlay/` but preserved `state/`, so after an eviction/restore the marker still matched a checkout whose deps were gone → `{ skipped: true }` → dep-less session. `"state"` was added to `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts:86`) — but `reclaimRegenerableSessionDirs()` builds its target list by hand from `workspaceDir` + `overlay/` (`disk-utils.ts:128`) and never reads that constant, so `state/` is **not** actually reclaimed and the original failure stands. Found by the retirement review; tracked as **SHI-293**, not fixed in the deletion PR.
- [x] **`.env.agent` was not actually orchestrator-only.** The whole state dir was mounted, so it and the compose override sat in the container namespace. Only `state/shared/` (marker + CI logs) is mounted now; the orchestrator-only artifacts are unreachable by layout rather than by claim.
- [x] **The sweep deleted by filename alone.** A repo may legitimately track `.shipit/ci-logs/` or its own `compose.override.yml`; deletion was silent and would land in the next auto-commit. `git ls-files` became the provenance check, with an unknown answer counting as tracked. (Historical — the sweep has since been retired, so the provenance helper went with it.)
- [x] **The guard test was defeatable.** It enumerated the four artifact names and required them in the same expression as `.shipit`, so a future artifact was invisible and `service-manager.ts` already defeated it by splitting the path across two lines. It now matches the directory join itself.

## Known gaps

- **Grandfathered containers — ACCEPTED, will not be fixed (SHI-284, closed).**
  `deploy.sh` deliberately preserves session containers across an upgrade
  (docs/113), and boot rotation only replaces a worker when no turn is active.
  Such a container keeps the OLD worker: it writes the marker in the clone, and
  the new CI-fix code hands its agent `/session-state/ci-logs/...` — a path that
  container has no mount for, so the full-log read fails.

  Accepted because it degrades rather than breaks (the log excerpt and extracted
  error lines are inline in the prompt regardless, so the agent still has the
  failure content) and self-heals on the next container recreate. Both fixes cost
  more than the problem: gating container reuse on mount compatibility would
  force recreation of every session on deploy, which is precisely what docs/113
  stopped doing, and suppressing the path via a container-mount inspection adds a
  Docker round-trip plus a branch to the CI-fix path to save one failed file read
  in a shrinking window. Recorded here so it isn't re-litigated.
- ~~**Docker-secrets entrypoint.**~~ **Closed by SHI-285.** The wrapper is now staged at `<SHIPIT_SECRETS_INTERNAL_DIR>/_entrypoint/secrets-entrypoint.sh` and bind-mounted into service containers by absolute path, so the mount no longer rides the workspace volume and nothing is written into the clone. It went to the secrets root rather than the state dir because the mount source is resolved by the Docker **daemon**: the secrets root is the one directory this mode already maps daemon-side (`SHIPIT_SECRETS_HOST_DIR`, used by every `secrets: file:` reference), while the state dir has no daemon-side path when the orchestrator is containerized and sessions live on a named volume. The wrapper is also a static baked asset, identical for every session — not session state. The `service-secrets-resolver.ts` entry is gone from `ALLOWED` in `no-clone-writes.test.ts`, so req 1 is now mechanically enforced for this mode too. `secrets-entrypoint.sh` was added to `LEGACY_CLONE_ARTIFACTS` at the time so an upgraded session lost the copy an earlier version left in its clone (req 6); that list is gone with the rest of the retired migration.
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

- ~~**The sweep never runs in local/dogfood mode.**~~ **Moot — SHI-289 canceled.**
  `sweepLegacyCloneArtifacts`'s only caller was `createContainer`, and `RUNTIME_MODE=local`
  creates no container, so a local-mode session never swept. The whole migration has since
  been retired (above), so there is no sweep to be missing from that path; the residual it
  described is the same accepted residual recorded there.

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
