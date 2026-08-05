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

8. When the repo's Node pin could not be honored, the agent is told so on its
   first turn, as a system note ahead of the user's message — without the agent
   having to ask, and without the note appearing as part of what the user said.
   It can then decide what to do with that (warn, work around it, distrust a
   repro), rather than debugging against a runtime it believes is correct.
   Previously this existed only in the diagnostics panel, which is a human
   surface: the agent had no way to reach it and no signal that it should look.

## Explicitly out of scope

7. Native-module build failures caused by upstream incompatibility are not part
   of this work. The reporter saw a pinned, years-old `nan` release fail against
   modern V8 in the same session; it would fail on Node 22 too. That is an
   upstream problem, and honoring the pin would not fix it. It is called out
   here only so it is not folded into this feature's success criteria.

## Open questions

_None._

## Resolved questions

### 2026-08-05 — tell the agent in a system prefix on the first user message

Asked how proactive requirement 8 should be, offering an on-demand command, an
annotation on install failure, or a chat card. **Answer: when the pin
installation failed, notify the agent in the "system" prefix of the first user
message.** Chosen over all three offered options; requirement 8 is written from
that answer.

Two consequences worth recording, because they are why this is the right channel
and not merely one of several:

- It must NOT go in the system prompt. That is precomputed per
  `(agentId, isOps)` at module load and kept byte-stable so the prompt cache
  stays warm (`CLAUDE.md` → Prompts); per-session text there would cost every
  turn in the fleet. The user message carries no such contract.
- The note is not part of what the user said. The transcript keeps the user's own
  text; only the prompt handed to the CLI carries the prefix — the same split
  `assembleAgentPrompt` already makes for file and image context.

No on-demand command was added: `node -v` already answers "what am I running",
and the push covers the case where the answer is surprising.

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
