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
credentials subtree (`/credentials`). Mounted into the session container at
`/session-state` read-write, owned by the worker uid via the entrypoint's chown
loop.

Why a mount and not four separate moves: two of the four artifacts must be
readable *inside* the container — `.install-done` is written there by the worker
after `agent.install`, and `ci-logs/` is read by the agent from a path embedded
in the CI-fix prompt. A mount serves both with a path swap and no protocol
change. The alternative — making the marker orchestrator-owned and passing the
stamp over the existing `POST /install` call — is a real refactor of the
install-skip logic and the overlay publish gate, both load-bearing, and buys
nothing the mount doesn't.

### The state dir is threaded, never derived

`ServiceManager` holds only `workspaceDir` (`service-manager.ts:245`) and the
`Session` type has no `sessionDir` (`domain-types/session.ts:99`), so the
tempting move is `path.dirname(workspaceDir)`. That is wrong: the legacy flat
layout has `sessionDir === workspaceDir` (`container-lifecycle.ts:229`), where
`dirname` yields `sessionsRoot` and every session's state collides in one
directory.

So the resolved state dir is computed once by the caller that knows both paths
and **threaded as an explicit option**, exactly as docs/183 threaded
`serviceEnvDir` through `service-manager-setup.ts` → `ServiceManager`. No
consumer re-derives it from a workspace path.

### Per-artifact

| Artifact | New home | Container-visible? | Notes |
|---|---|---|---|
| `compose.override.yml` | `<sessionDir>/state/` | no | Orchestrator writes it, orchestrator's `docker compose` reads it. Passed as an **absolute** `-f`. |
| `.install-done` | `<sessionDir>/state/` | yes (`/session-state`) | Written in-container by the worker; pre-stamped and deleted by the orchestrator. |
| `ci-logs/` | `<sessionDir>/state/ci-logs/` | yes (`/session-state`) | Prompt must cite the new in-container path. |
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

### Cleanup of what earlier versions left behind (req 6)

On session boot, remove the four generated names from `<clone>/.shipit/`, then
remove the directory if empty. Working tree only — copies already committed to a
user's history are left alone and not announced (resolved question, 2026-08-03).

Note `.shipit/system-prompt.md` is **not** in a clone: every caller passes the
app-scope `workspaceDir` (`route-registry.ts:238` → `:977`,
`bootstrap-managers.ts:361`, `services/misc.ts:88`), i.e. the orchestrator's
workspace root. It is a global setting living above every session, so the
cleanup has no carve-out to make and a clone's `.shipit/` can disappear
entirely.

### Making it stay fixed (req 7)

One exported helper owns every path under the session state dir, and a test
asserts no writer composes `path.join(workspaceDir, ".shipit", …)`. With no
user-authored file left in a clone's `.shipit/`, the invariant is
unconditional — `.shipit/` inside a session clone is a bug — which is what makes
it mechanically checkable rather than a review convention.

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
