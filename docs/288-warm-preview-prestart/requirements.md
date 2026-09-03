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
4. A pre-started preview is speculative work and yields to real sessions: ShipIt
   stops creating and keeping them when it reaches its memory budget.
5. The preview a claimed session shows serves that session's workspace as it is
   *after* the claim brings it up to date — never the state it was warmed at.
6. A pre-started preview never outlives the process that made it, in any form
   that could serve a user stale code or a stale worker image.
7. An operator can see, from the logs alone, which phase of
   activation→preview-ready dominated a given session: container acquisition,
   the install gate, the `docker compose up` (build vs create), and the dev
   server's own boot.

## Open questions

- Which repos get a pre-started warm preview — every warmed repo, or a narrower
  set? One preview per warmed repo is one running dev server per repo, all the
  time.
- When the claim brings the clone up to fresh `origin/main`, what happens to the
  already-running stack (req 5)? Leaving it up keeps the saving and leans on the
  dev server's own file watcher; restarting it is certainly correct and costs
  most of the saving back.
- Where does a warm preview sit in the memory eviction order (req 4) — ahead of
  every real session's preview, or level with an idle one?

## Resolved questions

- 2026-09-03 — Req 7 is already implemented, ahead of the rest of this feature:
  the `[timing]` lines for container acquisition, the install gate, the
  `compose up` build/create split, and compose-up→first-answered-request ship in
  the same pull request that adds this doc. Measuring first was the human's
  instruction ("see which phase dominates").
