---
issue: nikzlabs/shipit#1728
title: Honor the repo's Node version pin in the agent container
description: The agent container runs its baked Node major regardless of the repo's .nvmrc; provision the pinned version or surface the mismatch.
---

# Requirements — repo Node version pin

Source: [nikzlabs/shipit#1728](https://github.com/nikzlabs/shipit/issues/1728), filed from a session.

Design: see [plan.md](./plan.md) (not written yet — blocked on the open questions below).

## Context (reported behavior)

A repo pins Node 22 with a `.nvmrc` at the workspace root and has no `engines`
field. The agent container reports `node -v` → `v24.15.0` — the session-worker
image's baked Node major (`docker/Dockerfile.session-worker.prod` is
`FROM node:24-slim`). Nothing fails outright; the pin is silently ignored.

## Requirements

1. When a repository pins a Node version, the agent container runs that Node
   version. `node -v` in the session terminal reports a version matching the
   repo's pin, not the container's baked default.

2. `.nvmrc` at the workspace root counts as a pin. A bare major (`22`) is the
   reported form and must work.

3. `package.json` `engines.node` counts as a pin when present. (The reporting
   repo has no `engines` field; the issue names it as an additional source.)

4. The pinned version is what the session *builds and runs with*, not only what
   an interactive `node -v` prints. Dependency installs, native-addon compiles,
   and anything else the agent runs in the session use it, so:
   - native modules are compiled against the ABI of the Node major the project
     targets;
   - version-sensitive tooling behavior matches what CI and a developer's own
     machine see;
   - a failure the agent reproduces (or fails to reproduce) is against the
     project's real target runtime.

5. The Node that installs the workspace's dependencies agrees with the Node a
   Compose preview service pins for that same mounted workspace. A repo whose
   service is `node:22` must not have had its `node_modules` installed under a
   different Node major.

6. When the pin cannot be honored — the requested version is unavailable, or
   provisioning it is judged too costly — the mismatch is surfaced in session
   diagnostics. The discrepancy must be visible rather than silently assumed
   correct. This is the floor, not the goal: requirement 1 is the goal.

## Explicitly out of scope

7. Native-module build failures caused by upstream incompatibility are not part
   of this work. The reporter saw a pinned, years-old `nan` release fail against
   modern V8 in the same session; it would fail on Node 22 too. That is an
   upstream problem, and honoring the pin would not fix it. It is called out
   here only so it is not folded into this feature's success criteria.

## Open questions

- **How far does this go — provision, or only report?** Requirement 1 says run
  the pinned version; requirement 6 accepts surfacing the mismatch as the floor
  if provisioning is impractical. Which is being asked for now: full
  provisioning, diagnostics-only, or provisioning with a diagnostics fallback
  when a version can't be provisioned?
- **Which pin files, and which wins when they disagree?** `.nvmrc` and
  `engines.node` are named in the issue. Ecosystem-adjacent sources exist and
  are not named: `.node-version` (nodenv/fnm), `volta.node` in `package.json`,
  `mise.toml`/`.tool-versions`. And `.nvmrc` = `22` vs `engines.node` = `>=20`
  need a stated precedence.
- **How is the version provisioned?** Two mechanisms with different cost
  profiles: baking a small set of majors into the session-worker image (instant,
  fixed image growth, only covers the baked set), or downloading the pinned
  version on demand from `nodejs.org` into the shared dependency cache (covers
  any version, costs a one-time download per version per host).
- **Does session start wait for it?** Requirement 4 means the pinned Node has to
  be in place *before* `agent.install` runs, or the install compiles against the
  wrong ABI. That implies blocking the install (and so the first turn) on
  provisioning. Is that acceptable, or should the first turn start immediately
  and the pin apply from the next one?
- **Does a repo need to opt in?** Honoring a pin changes the runtime under
  existing sessions of existing repos, which could break a repo whose `.nvmrc`
  is stale or wrong. Automatic for every repo, or gated behind a `shipit.yaml`
  key?
- **Scope boundary.** ShipIt's own worker process, agent CLIs, and shims run on
  the image's Node and are not repo code. Assumption to confirm: the pin applies
  to the agent's shell, the terminal, and `agent.install` — not to the
  session-worker process itself.

## Resolved questions

_None yet._
