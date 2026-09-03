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
9. An ordinary break away from work — a night, a weekend, a holiday — does not
   change warming behaviour. Coming back on Monday is the same as coming back
   after lunch. Concretely: a user who starts in the morning and opens a new
   session gets a warm one, already prepared, without knowing or caring what
   ShipIt did overnight.
10. A warm session whose container or preview has died is rebuilt while nobody
    is watching, whatever killed it. ShipIt does not wait for the next claim to
    notice that its warm tier is hollow — the claim is the moment the user needs
    it, which is the one moment it is too late to start.
11. A claim that could not use the warm tier says so. "Warm hit" must not be
    reported for a session that then pays the full cold cost.

## Open questions

_None._

## Resolved questions

- 2026-09-03 — *"If I start working in the morning and open a new session, it
  should be warmed up already."* Stated to correct an answer that had explained
  the overnight-deploy path instead. The requirement is about the ordinary
  morning, with nothing unusual happening overnight — so it is written as req 9
  and req 10 rather than as a property of the deploy path. The gap it exposes is
  real and exists TODAY, before this feature: **nothing checks that a standby is
  still alive.** The health reconciler skips standbys and only walks registered
  runners, which a standby has none of (`app-lifecycle.ts:1025`); the boot sweep
  validates the CLONE and nothing else, printing "warm session validated (clone
  exists)" for a repo whose container died hours ago
  (`startup-tasks.ts:487-500`); and `warmSessionForRepo` then declines to act
  because the row still exists (`warm-pool-manager.ts:86-89`). It is called only
  from boot, repo add, repo trust, the claim re-warm and graduation — there is
  no periodic sweep. → reqs 10, 11.
- 2026-09-03 — *"[memory pressure] literally never happens to me."* Stated
  against a first diagnosis that blamed the idle enforcer's tier-0 reclaim.
  Correct: that tier only runs over budget, and it is one cause among several,
  not the mechanism. The mechanism is the missing liveness check above, which
  turns ANY death of a standby — a container that exits, an OOM inside the
  pre-install, a daemon restart (the agent container carries no `RestartPolicy`,
  `compose-cli.ts:297`), an external cleanup — into a permanent hollow warm
  session. → req 10 is written for any cause, not for memory pressure.
- 2026-09-03 — *What is the recency cutoff, and does a break break it?* The
  requirement was written without a number, which the human caught. The cutoff
  is **7 days**, and the rule it has to satisfy is req 9: no ordinary absence
  changes what a user comes back to. Two properties make that hold and are the
  reason 7 days is enough rather than arbitrary: the gate is evaluated when
  ShipIt WARMS (boot re-warm, repo add, claim re-warm, graduation), not when the
  user claims — so an overnight deploy re-warms and pre-starts the preview
  before the user arrives; and every claim stamps `lastUsedAt`, so an absence
  longer than the cutoff costs exactly ONE cold preview, after which the repo is
  recent again. → req 8, req 9.

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
