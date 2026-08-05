---
issue: nikzlabs/shipit#1728
title: Honor the repo's Node version pin in the agent container
description: The agent container runs its baked Node major regardless of the repo's .nvmrc; provision the pinned version or surface the mismatch.
---

# Requirements — repo Node version pin

Source: [nikzlabs/shipit#1728](https://github.com/nikzlabs/shipit/issues/1728), filed from a session.

Design: see [plan.md](./plan.md).

## Context (reported behavior)

A repo pins Node 22 with a `.nvmrc` at the workspace root and has no `engines`
field. The agent container reports `node -v` → `v24.15.0` — the session-worker
image's baked Node major (`docker/Dockerfile.session-worker.prod` is
`FROM node:24-slim`). Nothing fails outright; the pin is silently ignored.

## Requirements

1. When a repository pins a Node version, the agent container runs that Node
   version. `node -v` in the session terminal reports a version matching the
   repo's pin, not the container's baked default. This applies to every repo
   with a pin, with no configuration — a repo does not opt in.

2. `.nvmrc` at the workspace root counts as a pin. A bare major (`22`) is the
   reported form and must work.

3. `package.json` `engines.node` counts as a pin when present. (The reporting
   repo has no `engines` field; the issue names it as an additional source.)
   `.nvmrc` and `engines.node` are the only pin sources; when both exist,
   `.nvmrc` wins. Other ecosystem pin files (`.node-version`, `volta.node`,
   `mise.toml`, `.tool-versions`) are not read.

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

8. The agent running in the session can find out how the repo's Node pin was
   resolved — the Node it is actually running, what the repo asked for, and, when
   the pin is not being honored, why — so it can take that into account when
   deciding what to do. Today this information exists only in the diagnostics
   panel, which is a human surface: the agent has no way to reach it and no
   signal that it should look.

## Explicitly out of scope

7. Native-module build failures caused by upstream incompatibility are not part
   of this work. The reporter saw a pinned, years-old `nan` release fail against
   modern V8 in the same session; it would fail on Node 22 too. That is an
   upstream problem, and honoring the pin would not fix it. It is called out
   here only so it is not folded into this feature's success criteria.

## Open questions

- **How proactive should requirement 8 be?** Making the information *reachable*
  is easy; making the agent *notice* is the real question, and it trades
  usefulness against noise. A command the agent runs on demand costs nothing but
  relies on it thinking to ask — which is the same discoverability problem the
  diagnostics panel already has. Volunteering the information on every turn would
  reach an agent that wasn't looking, but almost every repo either pins nothing or
  pins something the container already satisfies, so it would be noise nearly all
  of the time.

## Resolved questions

### 2026-08-04 — provision, with diagnostics as the fallback

Asked whether to provision the pinned Node, only report the mismatch, or
provision with a reporting fallback. **Answer: provision, report on failure.**
ShipIt installs and uses the pinned version; when a version can't be provisioned
(unavailable, no network, network-off sandbox) the session falls back to the
image's Node and the mismatch is surfaced in session diagnostics rather than
failing the session. Requirements 1 and 6 stand as written, and 6 is explicitly
the fallback path rather than the design.

### 2026-08-04 — `.nvmrc` and `engines.node` only, `.nvmrc` wins

Asked which files count as a pin and what the precedence is. **Answer: exactly
the two sources the issue names — `.nvmrc` first, then `engines.node`.**
`.nvmrc` wins when both are present, because it pins a version while
`engines.node` is usually a range; a range resolves to the newest available
version satisfying it. `.node-version`, `volta.node`, `mise.toml`, and
`.tool-versions` are deliberately not read. Folded into requirement 3.

### 2026-08-04 — download on demand and cache it

Asked whether to bake a set of Node majors into the session-worker image or
download the pinned version on demand. **Answer: download on demand, cached.**
The version is fetched from `nodejs.org` (already on the egress allowlist) the
first time it's needed and reused from the shared dependency cache afterwards,
so any pinned version is covered with no image growth. This is a mechanism
choice and adds no requirement.

### 2026-08-04 — automatic for every repo

Asked whether honoring the pin should be automatic or gated behind a
`shipit.yaml` key. **Answer: automatic for every repo, no opt-in.** ShipIt reads
the pin file and honors it; the resolved version is visible in session
diagnostics so a stale or wrong `.nvmrc` is diagnosable. Folded into
requirement 1.
