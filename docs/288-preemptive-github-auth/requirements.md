---
issue: planning#503
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

- None.

## Resolved questions

- 2026-09-03 — *Does requirement 1 cover the orchestrator's OTHER GitHub git
  traffic — the in-container self-update fetch of `/opt/shipit`
  (`services/updates.ts`) and the marketplace catalog fetch
  (`services/marketplace.ts`)?* **Not in this change, and stated rather than
  assumed.** Requirement 1 enumerates four families and those are not among
  them; the requirement's own preamble describes the self-updater as anonymous
  *by design*. Neither service can reach `GitHubAuthManager` today, so covering
  them needs new boot-time plumbing of its own, and their volume is a rounding
  error beside the ~280 bare-cache fetches an hour this change does cover.
  Recorded as a follow-up on `planning#503` rather than done silently.

- 2026-09-03 — *Does requirement 1's "pushes" include deployments where
  orchestrator git does not drop uid, i.e. a root-owned session workspace?*
  **There is no such deployment.** Verified: for a path inside a session,
  `resolveGitTreeUid` delegates to `identityForPath`, which returns the
  configured `fallbackIdentity` when the session directory is root-owned
  (`shared/session-identity.ts:173`) — never "no drop". That fallback is
  configured whenever `SHIPIT_SESSION_WORKER_UID` is set
  (`orchestrator/index.ts:154`), and every shipped deployment sets it to 1000
  (`deployment/vps/docker-compose.yml:46`, `docker/local/prod/compose.yml:45`,
  `docker/local/dev/compose.yml:26`). The only orchestrator that does not drop is
  one that is not root at all — local/dogfood mode, which returns null at
  `resolveGitTreeUid`'s `getuid() !== 0` guard. The human's constraint for that
  mode is "it just has to keep working", so requirement 1 is taken whole: a
  non-dropping orchestrator gets the credential too when ShipIt holds one, and
  requirement 4's fallback is what keeps "keep working" true.

- 2026-09-03 — *Does a preemptive credential that GitHub rejects have to keep a
  public-repo fetch working?* Yes; requirement 4 already decides it. Measured
  against git 2.39.5: `https://github.com/git/git` fetches anonymously today
  with **no** `Authorization` header at all, and the same fetch carrying a
  rejected `Authorization` header dies `fatal: Authentication failed`. A fetch
  that succeeds today and fails after the change is "worse than today's
  failure", so a rejected credential must fall back to the unauthenticated
  request rather than fail the operation.
