---
issue: https://linear.app/shipit-ai/issue/SHI-279
title: Keep ShipIt's generated state out of the user's repository
description: Move ShipIt's generated session artifacts out of the git clone into a per-session state dir, with a container mount for the two the agent must read.
---

# ShipIt's generated state stays out of the session clone

Implements [requirements.md](./requirements.md).

## Problem

Every session's clone is mounted at `/workspace` and ShipIt writes its own
generated artifacts into `<clone>/.shipit/`, where the post-turn `git add -A`
(`GitManager.autoCommit`) stages them into the user's repo (req 1). Only ShipIt's
own `.gitignore` hides them here; no user repo has that line (req 2).

## Design

### One per-session state dir, one mount

`<sessionDir>/state/` — a sibling of `workspace/`, following the exact shape
docs/217 used for `scratch/` (`/persist`) and docs/138 for the per-session
credentials subtree (`/credentials`). Its **`shared/` subdirectory only** is
mounted into the session container at `/session-state` read-write, owned by the
worker uid via the entrypoint's chown loop. The state dir's root is deliberately
*not* mounted, which is what keeps the orchestrator-only artifacts (the compose
override and `.env.agent`) out of the container namespace — see
`SESSION_STATE_SHARED_SUBDIR`. Mounting the whole dir, which is what the first
implementation did, put plaintext secrets inside the container while this
document claimed they weren't there.

Why a mount and not four separate moves: two of the four artifacts must be
readable *inside* the container — `.install-done` is written there by the worker
after `agent.install`, and `ci-logs/` is read by the agent from a path embedded
in the CI-fix prompt. A mount serves both with a path swap and no protocol
change. The alternative — making the marker orchestrator-owned and passing the
stamp over the existing `POST /install` call — is a real refactor of the
install-skip logic and the overlay publish gate, both load-bearing, and buys
nothing the mount doesn't.

### The worker's state dir is injected, not read from the environment

`InstallController` first hardcoded the container mount path. That is wrong
outside a container: every in-process integration test (and any non-container
worker) then tries to create `/session-state` at the filesystem root, the marker
write throws, and the install hangs rather than failing loudly — which is
exactly how CI caught it. The path is now a dependency
(`SessionWorkerDeps.stateDir` → `InstallControllerDeps.stateDir`) defaulting to
`SHIPIT_SESSION_STATE_DIR` then the `/session-state` mount, so tests point it at
a temp dir and exercise the real mechanism.

### The state dir is never placed inside the clone (structural, not a check)

`sessionStateDir(sessionDir)` is only safe when the clone is a *subdirectory* of
the session dir. Under the pre-`workspace/` flat layout the two were the same
path, so the naive form yielded `<clone>/state` — a ShipIt directory created
**inside the user's repository**, which `git add -A` would commit. That is
strictly worse than the bug this feature fixes: it isn't under `.shipit/`, so the
req-7 guard test would not notice it.

That is why `sessionStateDirForWorkspace()` derives ONLY from the
`<sessionDir>/workspace` shape and **throws** on anything else (SHI-286). The
earlier posture — a containment check in `resolveContainerStateDir()` returning
`null`, with the worker told via `SHIPIT_SESSION_STATE_DIR` to keep the legacy
in-clone location — is gone: a production census found no flat-layout session, so
the fallback was dead weight that kept requirement 1 conditional. Because the
resolved dir is now always a *sibling* of the clone, containment is a property of
the layout rather than something a check has to enforce.

One consequence still worth knowing:

- **Grandfathered containers degrade safely.** `deploy.sh` stopped killing
  session containers on update (docs/113), so a container adopted across a
  deploy runs the OLD worker against the NEW orchestrator. That worker writes
  the marker in the clone and never sees the host-side pre-stamp, so the
  pre-stamp stops suppressing installs (a redundant install — slow, correct)
  rather than skipping one that was needed. `claim-session` clears the state-dir
  marker, so HEAD-change invalidation keeps working, and the clone's leftovers
  disappear with the clone itself the next time the session is evicted and
  re-cloned.

### The state dir is derived from ONE resolver, never from a bare `dirname`

`ServiceManager` holds only `workspaceDir` and the `Session` type has no
`sessionDir`, so the tempting move is `path.dirname(workspaceDir)`. That is
wrong: the legacy flat layout had `sessionDir === workspaceDir`, where `dirname`
yields `sessionsRoot` and every session's state collides in one directory.

The first implementation avoided that by computing the path once in the caller
that knew both and **threading it as an explicit option** (as docs/183 threaded
`serviceEnvDir`). SHI-286 replaced the threading with a single shared resolver:
consumers — `ServiceManager`, the container config, the secret resolver,
`claim-session` — each call `sessionStateDirForWorkspace(workspaceDir)`, which
enforces the `<sessionDir>/workspace` contract and throws on anything else. That
is safe precisely because it is not a bare `dirname`: one function owns the
derivation, so the host side and the container mount cannot disagree.

### Per-artifact

| Artifact | New home | Container-visible? | Notes |
|---|---|---|---|
| `compose.override.yml` | `<sessionDir>/state/` | no | Orchestrator writes it, orchestrator's `docker compose` reads it. Passed as an **absolute** `-f`. |
| `.install-done` | `<sessionDir>/state/shared/` | yes (`/session-state`) | Written in-container by the worker; pre-stamped and deleted by the orchestrator. |
| `ci-logs/` | `<sessionDir>/state/shared/ci-logs/` | yes (`/session-state`) | Prompt must cite the new in-container path. |
| `.env.agent` | `<sessionDir>/state/` | **no** | Orchestrator-side only — see below. |

**`.env.agent` is not exposed in the container**, which restores what docs/087
§403 specified — "Orchestrator passes `--env-file .shipit/.env.agent` on `docker
create`. This file is on the orchestrator's filesystem, **not the workspace
volume**." The workspace placement was an implementation divergence (087's
`checklist.md:40`), and the `--env-file` wiring it existed for was never built:
the file has no reader in `src/` or `docker/` outside tests, and `agent: true`
values actually reach the agent through the worker `PUT /secrets` endpoint into
`process.env` (docs/088 §260). So nothing observable changes, and the earlier
draft's "keep it agent-readable" rationale — preserving a hand-sourcing
affordance — was hypothesising a consumer that does not exist.

**The compose override stays correct as an absolute `-f`** because the project
directory is anchored by the *first* `-f` — the user's compose file, still
relative to cwd = the clone. The generated override already contains only
absolute paths (`env_file: /workspace/service-env/<id>/.env.<svc>`, named-volume
mounts with subpaths), so nothing in it resolves relative to its own location.

### Cleanup of what earlier versions left behind (req 6) — done, and retired

On session boot (container create), `sweepLegacyCloneArtifacts()` removed the
generated names from `<clone>/.shipit/` and dropped the directory if the sweep
emptied it. Working tree only — copies already committed to a user's history
were left alone and not announced (resolved question, 2026-08-03). Provenance
came from `git ls-files`, so a repo that legitimately tracked a file of the same
name kept it.

**That migration has served its purpose and the code for it is gone.** The sweep,
`LEGACY_CLONE_ARTIFACTS`, the `isTrackedByGit()` helper, and the three pre-246
unlinks (`claim-session.ts`, `install-controller.ts`, `secret-resolver.ts`) are
deleted. Requirement 6 is not withdrawn — it was honoured, and the code that
honoured it was retired once it had nothing left to find:

- **It has already run**, on every container create and every claim / `/install`
  / `.env.agent` write, for the whole period docs/246 has been deployed. On a
  single-instance deployment that is past tense, not future.
- It only ever removed files an **older** ShipIt wrote; current code writes none
  of them into a clone, which is what `no-clone-writes.test.ts` pins.
- One production instance, one user — no fleet of older orchestrators to wait for.

**Not a reason: disk-tier eviction.** An earlier draft justified this with
"eviction re-clones the workspace, so leftovers self-clean." That is false and
the opposite is closer to true: `reclaimToEvicted` (`tier-escalation.ts:180`)
auto-commits and pushes a **dirty** tree before wiping it, so an untracked
leftover is *staged and committed* into the user's branch and then cloned back.
Recorded here because the claim is plausible enough to be re-derived.

The accepted residual is a session that still holds a leftover: the next turn's
`git add -A`, or the eviction auto-commit above, can commit it.
`GitManager.autoCommit`'s secret scanner is a partial backstop for the
`.env.agent` case only. Accepted by the user, recorded in `checklist.md`.

None of the *placement* work changed: the state dir, the `/session-state` mount,
the artifact constants and the req-7 guard test are all untouched. If a change
here starts moving where an artifact is written, it has gone too far.

Note `.shipit/system-prompt.md` is **not** in a clone: it is a global setting
living at the orchestrator's own workspace root, above every session, so the
cleanup has no carve-out to make and a clone's `.shipit/` can disappear
entirely. SHI-290 made that legible in the code rather than only here — see
below.

### Making it stay fixed (req 7)

One exported helper owns every path under the session state dir, and a test
asserts no writer composes `path.join(workspaceDir, ".shipit", …)`. With no
user-authored file left in a clone's `.shipit/`, the invariant is
unconditional — `.shipit/` inside a session clone is a bug — which is what makes
it mechanically checkable rather than a review convention.

**The guard has no allowlist (SHI-290).** It asserts "no source file composes an
in-clone `.shipit` path", not "only these files may". The exemption map it used
to carry was worse than it looked: granularity was per FILE, so a new forbidden
writer added to an already-listed file passed silently. Emptying it took
resolving its last four rows rather than tolerating them, and the two halves were
different in kind:

- **Three were false positives, and the fix was a naming problem.** They composed
  `path.join(workspaceDir, ".shipit", "system-prompt.md")` where `workspaceDir`
  was the orchestrator's own root — the regex could not tell them apart because
  the codebase uses one name for two different things. That ambiguity is the same
  one that produced the flat-layout bug below (a session resolving to a
  host-shared `<sessionsRoot>/state`), so the fix is a real clarity win and not a
  dodge: `global-system-prompt.ts` owns the path, its parameter is
  `appWorkspaceDir`, and `.shipit` appears once instead of four times. The guard
  stops matching as a consequence.
- **One was a genuine in-clone writer, and it was deleted.** See below.

### docs/183's in-workspace env-file fallback is gone (SHI-290)

`ServiceSecretsResolver` used to fall back to writing `.shipit/.env.<svc>` into
the clone when neither Docker-secrets mode nor `serviceEnvDir` was configured.
Production never took it — `bootstrap-managers.ts` always computes
`serviceEnvDir` (`SHIPIT_SERVICE_ENV_DIR ?? <stateDir>/service-env`) — so it was
reachable only from tests, which is exactly the shape SHI-286 deleted for the
flat layout. `serviceEnvDir` is now **required** on `ServiceSecretsResolver`,
`ServiceManager`, `setupServiceManager` and `createRunnerRegistry`, so "service
secrets never land in the clone" is a property of the type rather than of the
wiring.

Deleted with it, because they existed only to serve that mode:
`writePerServiceEnvFiles`, `sweepWorkspaceServiceEnvFiles` (docs/183's own
migration tail, retired for the same reasons as the docs/246 sweep) and its two
call sites, and the compose generator's `?? \`.shipit/.env.${svc}\`` fallback —
which after the writer's removal would have named a file nothing creates. A
service missing from `serviceEnvFiles` now gets no `env_file:` entry at all.

## Key files

- `src/server/orchestrator/session-dir-factory.ts` — the `state/` sibling
- `src/server/orchestrator/container-lifecycle.ts` — the `/session-state` mount
- `docker/session-worker/entrypoint.sh` — chown loop coverage
- `src/server/orchestrator/compose-generator.ts` / `compose-cli.ts` /
  `service-manager.ts` — override path + absolute `-f`
- `src/server/session/install-controller.ts`,
  `orchestrator/overlay-session.ts` (`preStampInstallMarker`),
  `orchestrator/services/claim-session.ts` — the marker
- `src/server/orchestrator/services/github-ci-fix.ts` — log dir + prompt path;
  drop `ensureShipitGitignored` (it mutates the user's tracked `.gitignore`,
  which req 2 forbids)
- `src/server/orchestrator/secret-resolver.ts` /
  `service-secrets-resolver.ts` — `.env.agent`
- `src/server/shipit-docs/secrets.md`, `shipit-yaml.md` — agent-facing paths

## Rejected

- **Gitignore them instead** (per-clone `.git/info/exclude`, the
  `ensurePnpmStoreGitExcluded` pattern). Cheaper, but the files stay in the
  user's tree — visible to their tooling, their editor, and any script that
  walks the working tree. Requirement 1 is about the tree, not just the commit.
- **Appending `.shipit` to the user's `.gitignore`** — what
  `github-ci-fix.ts:200` does today. Forbidden by req 2: it makes ShipIt's
  problem into a commit on the user's branch.
