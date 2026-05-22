---
status: planned
priority: high
description: Eliminate the synchronous claim-time git fetch (~650ms, ~95% of claim latency) by keeping repos pre-fetched in the background and skipping the fetch on the claim path.
---

# Proactive background git pre-fetch

> Split out of [docs/144-session-switch-latency/](../144-session-switch-latency/plan.md).
> **Gate cleared (2026-05-22).** Dogfooded `[timing]` data shows that after 144
> fix #1, the claim-time `git fetch` (`refreshCloneToLatestMain`, "git fetch #1")
> is **~620–700ms and ~95–98% of total claim latency on every path** — the
> single dominant cost. Build it.

## Goal

Today a `claim-session` does a synchronous `git fetch` to GitHub on the critical
path so the new session's branch is cut from the latest `origin/main`
(`refreshCloneToLatestMain`,
[api-routes-session.ts:61](../../src/server/orchestrator/api-routes-session.ts#L61)).
Eliminate that ~650ms from the claim.

## Key measured finding that shapes the design

**A no-op `git fetch` still costs the full network round-trip.** In the dev
measurements the claim's fetch took ~667ms even when the bare-cache fetch logged
`HEAD … → … (unchanged)`. So the cost is "ask GitHub whether anything changed,"
not "download new commits." That has a sharp consequence:

> **Keeping the cache warm is necessary but not sufficient.** Pre-fetching does
> not make `refreshCloneToLatestMain` fast — that helper fetches the *session
> clone's* `origin` (GitHub) directly, and an empty fetch still pays the RTT.
> The only way to remove the ~650ms is for the claim to **skip the synchronous
> fetch entirely**, trusting a clone that was already refreshed off the critical
> path.

So the design is two parts that must go together:

1. **Pre-fetch in the background** (keep the bare cache, and the warm session's
   clone, near `origin/main` off the request path).
2. **Skip / defer the claim-time fetch** — the claim trusts the pre-refreshed
   warm clone and does *not* run `refreshCloneToLatestMain` synchronously
   (run it fire-and-forget, or skip it when a recent background refresh covered
   this repo). This is what actually removes the ~650ms.

## Approach

Fetch proactively on two triggers, both off the request path:

- **Periodically** — a low-frequency background `git fetch` per `ready` repo
  (e.g. every N minutes), reusing the existing 60s TTL guard
  (`cacheGit.fetchCache`) so overlapping triggers coalesce instead of stacking.
- **On change** — opportunistically when we already know `main` moved: a PR
  merge / push surfaced by the GitHub poller (`pr-status-poller.ts`), a webhook,
  or right after the user's own auto-push completes. These are the moments the
  cache actually goes stale, so fetching then keeps it fresh for almost no cost
  and avoids pointless polling when nothing changed.

Then, on the claim path, **don't block on a fresh fetch**: either skip
`refreshCloneToLatestMain` outright (the warm clone was cut from a recently
pre-fetched cache) or kick it off fire-and-forget so the response returns
immediately. Combined with 144's fix #1, the warm-hit claim then does **zero**
blocking git work.

## Bounded staleness — the key tradeoff (and why it's fine)

A newly claimed session may be a few seconds behind `origin/main` if a
background fetch is still in flight when the agent starts. That window is small
and rare, and in practice the agent's first actions almost never touch a file
that changed in those few seconds. So: let the agent start immediately against
the slightly-stale clone and let the fetch catch up concurrently.

### Guardrails

- **Resource limits must not be derived from a stale `shipit.yaml`.** This is
  the one thing that genuinely can't be wrong — a container booted with the old
  `agent.memory` then OOMs (the W2 / `reprovisionStandbyIfLimitsChanged`
  concern). If a deferred fetch moves HEAD and the limits changed, re-provision
  the standby as today; until then the existing limits stand.
- **The session clone is never fast-forwarded after its branch is cut.** A
  session is just a normal feature branch cut from a snapshot of `main`. Once
  cut, it's expected to diverge — that's ordinary multi-change workflow, and
  "this branch now conflicts with `main`" is resolved at PR/merge time like any
  other branch (other in-flight changes may land first anyway). So there is
  **no** "fast-forward the live clone at a safe boundary" to design and no
  HEAD-jumping-under-the-agent hazard to guard against — we simply don't touch a
  session's HEAD after start. The only freshness that matters is the **branch
  point at cut time**, and even that is best-effort. The existing claim-time
  reset (`refreshCloneToLatestMain` → `sessionGit.rollback(resetTarget)`) is
  only valid *before* the agent has edited anything (an untouched warm clone)
  and is an optimization, not a requirement. Pre-fetch's job is therefore purely
  to keep the **bare cache** close to `origin/main` so *new* branches start from
  a recent point; it never reaches into live session clones.
- **Preserve the W2 stale-clone visibility breadcrumb** — if we knowingly start
  against a stale snapshot, the existing "may be based on stale code" surface
  still applies.

## Open questions

- Periodic interval N — fixed, or adaptive to repo activity?
- Should the on-change trigger be webhook-driven (lower latency, needs webhook
  plumbing) or ride the existing poller (simpler, coarser)?
- Per-repo fetch concurrency / rate-limit budget against GitHub when many repos
  are tracked.
- Interaction with `disk-janitor` and unreferenced `repo-cache/<hash>` cleanup —
  don't keep fetching caches for repos no session will use.

## Key files

| File | Role |
|------|------|
| [api-routes-session.ts](../../src/server/orchestrator/api-routes-session.ts) | `refreshCloneToLatestMain` — becomes a no-op when cache is fresh |
| [warm-pool-manager.ts](../../src/server/orchestrator/warm-pool-manager.ts) | `cacheGit.fetchCache` (60s TTL), warm-session branch cutting |
| [pr-status-poller.ts](../../src/server/orchestrator/pr-status-poller.ts) | on-change trigger candidate (merge/push detection) |
| [repo-git.ts](../../src/server/orchestrator/repo-git.ts) | bare-cache fetch primitives |

See [checklist.md](checklist.md) for the work breakdown.
