---
issue: https://linear.app/shipit-ai/issue/SHI-167
title: Ephemeral orchestrator (scale-to-zero)
description: Analysis of shutting the orchestrator down when no browser is connected and reviving it on the next request without losing state.
---

# Ephemeral orchestrator (scale-to-zero)

## Goal

Shut the orchestrator process/container down when nobody is using the web UI, and
bring it back on the next request **without losing anything**. This is *scale-to-zero*
for the orchestrator itself — distinct from the existing per-session idle-container
cleanup (`docs/063-idle-container-cleanup`), which evicts session containers but keeps
the orchestrator running.

## Verdict

Feasible, and most of the groundwork already exists. The expensive half — externalizing
durable state and surviving an unclean restart — is **already done**, because shutting the
orchestrator down and restarting it is already a supported path. The two genuine blockers
are *outside* the orchestrator's own state model: a **cold-start wake trigger** and an
**orchestrator-level idle signal**. The remaining gaps are small, mostly-acceptable data
loss plus a couple of background jobs that must become boot-checkpointed rather than
purely timer-scheduled.

## What already works in our favor

### Durable state is fully externalized

Nothing load-bearing lives only in memory:

- **SQLite (`.shipit.db`)** — sessions (`SessionManager`, `sessions.ts:226` uses
  `dbManager.db`, *not* a JSON file — CLAUDE.md is stale on this point), chat history
  (`chat-history.ts`), usage (`usage.ts`), secrets (`secret-store.ts`), repo metadata
  (`repo-store.ts`), presentations (`present-store.ts`), persisted PR snapshots.
- **Credential files** — `CredentialStore` JSON (`/credentials/shipit-credentials.json`)
  plus per-provider agent credential files written/read by the CLIs.
- **Filesystem** — git bare cache + per-session clones + workspaces.

A cold orchestrator that boots, reads SQLite, and re-reads credentials is back to its
authoritative state.

### Containers survive orchestrator death by design

`shutdown-manager.ts` calls `runnerRegistry.disposeAll()` and `containerManager.dispose()`
but **deliberately leaves session containers running**. Containers are labeled
`shipit-session=<sessionId>`; on boot, `rediscoverContainers()` (`container-discovery.ts`)
re-adopts them from the persisted session list, and `adoptRunningContainer()` is a
backstop for runners whose container reference was lost. **A restart reconnects, it does
not rebuild.**

### The transport is stateless and replay-safe

- Orchestrator → container: plain HTTP (`worker-http.ts`); every call is independent.
- Container → orchestrator: SSE with **monotonic sequence numbers** and `?since=N`
  resume (`sse-client.ts`, `sse-connection-manager.ts`, backoff 2s→30s). A fresh
  orchestrator reconnects and catches up on events buffered in the container.

### Boot already reconciles drift

`verifyRunningState()` corrects stale `running=true`, the missing-container reconciler
and `adoptRunningContainer()` handle containers that vanished. The boot path is built to
land in a consistent state after an unclean stop — which is exactly what scale-to-zero
needs on every wake.

## The two real blockers

### 1. No wake-up trigger (infrastructure, not code)

Nothing sits in front of the orchestrator. The browser hits it directly
(`/api/sessions`, `/ws/sessions/:id`); if it's down, the request is refused. The existing
`preview-proxy.ts` and `docker-proxy.ts` both run *inside* the orchestrator, so they
cannot wake it.

This needs something **always-on and cheap** in front that accepts the first request,
starts the orchestrator container, and proxies once it's healthy. Options (decision still
open): nginx/Caddy with on-demand backend start, systemd socket activation, a small
front shim, or a scale-from-zero ingress (K8s `KEDA`/Knative-style). Largely orthogonal
to the ShipIt codebase.

### 2. No orchestrator-level idle signal (modest code change)

All idle logic today is *per-session* (`idle-enforcer.ts`, keyed on a runner's
`viewerCount` + `running`). Nothing aggregates **zero viewers across all sessions AND no
agent running anywhere AND no in-flight background work** into a "safe to shut myself
down" decision. The change: sum runner viewer counts, gate on no running turns and no
in-flight background jobs, respect a grace period, then exit cleanly via the existing
graceful-shutdown path. Should land behind a flag.

Note: `lastViewerDetachAt` and `viewerCount` live only in runner memory and reset on
boot. Today the ~10-minute grace period accidentally makes restarts survivable. For
scale-to-zero we should not depend on that accident — either persist detach timestamps or
make the wake-trigger authoritative about "someone is here now."

## Data-loss triage

On shutdown only in-memory, rebuildable state is lost. Triaged by whether it matters:

| Category | State | Verdict |
|---|---|---|
| **Fine — rebuilds on next poll/request** | PR status cache, GitHub rate-limit snapshot, GitHub App token cache, subscription limits, service-status maps, detected ports | No action |
| **Acceptable with caveats** | message queue (client re-sends), in-flight turn-event *replay* buffer (content already persisted to chat history; only live catch-up lost), terminal scrollback | No action / optional |
| **Decide deliberately** | Auto-remediation state machines — `AutoMergeManager` / `AutoFixManager` / `AutoConflictResolveManager` hold per-session attempt counts, cooldowns, fire-once guards purely in memory | See below |
| **Must fix for scale-to-zero** | Timer-scheduled OAuth refresh (`agents/*/oauth-refresher.ts`, ~45 min before expiry) | See below |

### Auto-remediation state machines

On restart these reset, so a fresh PR poll could **re-fire an auto-merge or auto-fix**
that already ran, or lose a cooldown. The merged-fire-once guard is already DB-backed via
`sessions.merged_at`, so that specific case is safe; the rest needs either persistence or
idempotency hardening if the orchestrator bounces frequently.

### Timer-scheduled OAuth refresh

Refresh is scheduled in-memory ahead of token expiry. If the orchestrator sleeps through
that window, a pinned session can wake with an expired token and 401 mid-turn. For true
scale-to-zero, refresh must be **checkpoint-driven on boot** ("is any token within
margin? refresh now") rather than purely interval-driven. Same shape, lower stakes:
disk-tier escalation and repo prefetch.

## Recommended sequencing

Smallest blast radius first:

1. **Prove the restart path is truly lossless** (manual): kill the orchestrator
   mid-turn, restart, confirm rediscovery + SSE `?since` resume + chat history reconcile.
   Validates the premise before building anything.
2. **Add orchestrator-idle self-shutdown** behind a flag — the one real code change
   (aggregate viewer count + in-flight check + grace period → clean exit).
3. **Make OAuth refresh and auto-remediation boot-checkpointed** rather than purely
   timer-scheduled, so a sleep window can't skip or double-fire them.
4. **Solve wake-up at the infra layer** (proxy / socket activation / scale-from-zero
   ingress) — where the actual "ephemeral" behavior comes from, mostly outside the repo.

## Key files

- `container-discovery.ts` — `rediscoverContainers()`, `adoptRunningContainer()` (boot re-adopt)
- `shutdown-manager.ts` — graceful shutdown; leaves containers running by design
- `app-lifecycle.ts` — startup reconciliation, signal handlers, shutdown hooks
- `sse-client.ts`, `sse-connection-manager.ts` — sequence-numbered SSE + `?since` resume
- `worker-http.ts` — stateless HTTP to containers
- `idle-enforcer.ts` — per-session idle today; site of the orchestrator-level idle change
- `agents/claude/oauth-refresher.ts`, `agents/codex/oauth-refresher.ts` — timer-scheduled refresh to make boot-checkpointed
- `auto-merge-manager.ts`, `auto-fix-manager.ts`, `auto-conflict-resolve-manager.ts` — in-memory remediation state
- `sessions.ts` (`SessionManager`) — SQLite-backed session metadata

## Related docs

- `docs/063-idle-container-cleanup` — per-session container idle eviction (not orchestrator-level)
- `docs/153-orchestrator-owned-claude-oauth-refresh` — current OAuth refresh ownership
- `docs/118-shipit-ui-local` — local mode (in-process agents); confirms orchestrator is still required there
