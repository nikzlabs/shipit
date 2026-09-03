---
title: Preemptive GitHub auth for orchestrator git
description: Orchestrator-side git sends a held GitHub credential on the first HTTP request instead of waiting for a 401.
---

# Preemptive GitHub auth for orchestrator git

Orchestrator-side git traffic to GitHub is anonymous on its first HTTP request,
always. Over HTTPS git asks for a URL, and only consults a credential helper
*after* the server answers 401 — so for a **public** repository the held
credential is never used at all and every request spends the host's shared
anonymous budget, and for a **private** one every request costs an extra
round-trip. The bare-cache pre-fetch sweep alone is ~280 fetches an hour on the
production VPS, around the clock, from the same public IP that the host
self-updater and every session container also fetch from. GitHub throttles
unauthenticated traffic per source IP and authenticated traffic per token.

## Requirements

1. When ShipIt holds a GitHub credential applicable to a remote (global PAT or a
   repo-scoped installation token), orchestrator-side git operations against
   that remote — bare-cache fetch/prefetch, LFS cache fetch, claim-path fetch,
   pushes — send it on the first HTTP request. No anonymous attempt precedes it.
2. When ShipIt holds no credential, the fetch stays genuinely anonymous (today's
   `credential.helper=` reset semantics are preserved).
3. The token never appears in a process argv (`ps`, `/proc/<pid>/cmdline`) or in
   a file readable by a non-root process.
4. Behaviour on a rejected preemptive credential (expired PAT, installation
   token for a different repo) is defined and tested: it must not be worse than
   today's failure, and must surface in the same place — the stale-cache warning
   path `fetchCache` throws into.

## Open questions

- **Does requirement 1's "pushes" include the deployments where orchestrator git
  does *not* drop uid?** On production, a push from a session workspace already
  carries a ShipIt-held credential (docs/266-orchestrator-git-trust-boundary E3),
  so making it preemptive costs nothing. But where the workspace is root-owned —
  local/dogfood mode (`RUNTIME_MODE=local`), and any deployment predating
  per-session uids — the push authenticates today through whatever git
  credential helper the operator configured, which need not be ShipIt's. Making
  those preemptive means ShipIt substitutes its own token for the operator's
  helper on those operations.

## Resolved questions

- 2026-09-03 — *Does a preemptive credential that GitHub rejects have to keep a
  public-repo fetch working?* Yes; requirement 4 already decides it. Measured
  against git 2.39.5: `https://github.com/git/git` fetches anonymously today
  with **no** `Authorization` header at all, and the same fetch carrying a
  rejected `Authorization` header dies `fatal: Authentication failed`. A fetch
  that succeeds today and fails after the change is "worse than today's
  failure", so a rejected credential must fall back to the unauthenticated
  request rather than fail the operation.
