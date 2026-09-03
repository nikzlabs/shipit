---
issue: planning#501
title: A warm session's preview is already running — requirements
description: The warm pool pre-pays the clone, the container and the install, but never the dev server. This is what it must pre-pay instead.
---

# A warm session's preview is already running — requirements

## Why

Reported 2026-09-03: *"how do warm sessions work? I never seem to get benefit of
a warm session, all the preview still start for ages."*

The trace behind that report:

- `warmSessionForRepo` pre-pays the clone, the standby container and
  `agent.install` (`src/server/orchestrator/warm-pool-manager.ts`).
- The Compose stack is not part of warming. A `ServiceManager` is built only
  when a runner is created at WS connect (`runner-registry-factory.ts` →
  `setupServiceManager` → `mgr.start()`), and the auto-preview services are held
  by the install gate until `agent.install` succeeds, then brought up by
  `startGatedServices` → `docker compose up -d --build`.
- So `docker compose up`, the image build and the dev server's own boot and
  first compile are on the user's clock on **every** session, warm or cold. The
  warm pool removes the install; it removes nothing after it.

## Requirements

1. When the user opens a new session on a repo that ShipIt has warmed, the
   preview serves the app without the user waiting for the dev server to boot
   and compile.
2. Warming a preview never runs a repository's own code before the user has
   trusted that remote.
3. Pre-starting a preview never delays the claim, the session opening, or the
   user's first turn.
4. A pre-started preview is speculative work and yields to real sessions: when
   ShipIt reaches its memory budget, warm previews are the FIRST thing stopped —
   before any real session's preview or container.
5. The preview a claimed session shows serves that session's workspace as it is
   *after* the claim brings it up to date — never the state it was warmed at.
   The running dev server's own file watcher is what reconciles it; the stack is
   not restarted for this.
6. A pre-started preview never outlives the process that made it, in any form
   that could serve a user stale code or a stale worker image.
7. An operator can see, from the logs alone, which phase of
   activation→preview-ready dominated a given session: container acquisition,
   the install gate, the `docker compose up` (build vs create), and the dev
   server's own boot.
8. Only repos the user has opened recently get a pre-started preview. A repo
   nobody has touched carries no standing preview cost.

## Open questions

_None._

## Resolved questions

- 2026-09-03 — *Which repos get a pre-started warm preview?* Recently used repos
  only. `repoStore.touch(url)` already stamps `lastUsedAt` on every claim, so
  the set exists; the standing cost is then a few dev servers, not one per
  imported repo. → req 8.
- 2026-09-03 — *What happens to the running preview when the claim brings the
  clone up to fresh `origin/main`?* Leave it running. The dev server's own file
  watcher is what reconciles it — the same mechanism that already serves every
  agent edit — and restarting the stack would cost back most of what this
  feature buys. → req 5.
- 2026-09-03 — *Where does a warm preview sit in the memory eviction order?*
  First, ahead of every real session. It is speculative work for a session
  nobody has opened, so the feature can never cost a live session its preview or
  its container. → req 4.
- 2026-09-03 — Req 7 is already implemented, ahead of the rest of this feature:
  the `[timing]` lines for container acquisition, the install gate, the
  `compose up` build/create split, and compose-up→first-answered-request ship in
  the same pull request that adds this doc. Measuring first was the human's
  instruction ("see which phase dominates").
