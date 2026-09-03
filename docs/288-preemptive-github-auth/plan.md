---
title: Preemptive GitHub auth — design
description: How orchestrator git carries a held GitHub credential on its first request, without putting the token in argv or on disk.
---

# Preemptive GitHub auth for orchestrator git — design

Implements [requirements.md](./requirements.md). Requirements are cited as
`(req N)`.

## What is true today, measured

All of this was reproduced against **git 2.39.5** (the version in the
orchestrator and session-worker images — both are `node:24-slim`, Debian
bookworm), on 2026-09-03. `http.proactiveAuth`, git's own answer to this, landed
in git 2.46 and is therefore not available.

| Observation | Command | Result |
|---|---|---|
| A public-repo fetch sends **no** `Authorization` at all, even with a credential helper configured | `GIT_TRACE_CURL=1 git -c credential.https://github.com.helper=… ls-remote https://github.com/git/git` | two requests, zero auth headers |
| `http.<url>.extraHeader` authenticates the **first** request | same, with `-c 'http.https://github.com/.extraHeader=Authorization: Basic …'` | `authorization: Basic …` on the initial `GET /info/refs` |
| A rejected preemptive header **breaks a fetch that works today** | same, with a bad token | `remote: Invalid username or token` → `fatal: Authentication failed`, exit 128 |
| The header does **not** cross an origin change on redirect | local 302 from `127.0.0.1:7701` → `127.0.0.1:7702` | first request `auth=PRESENT`, redirect target `auth=absent` |
| The header **does** survive a same-origin redirect | local 301 `/old/…` → `/new/…` | both `auth=PRESENT` |
| The key matches with or without a trailing slash | `http.http://127.0.0.1:7703.extraHeader` | applied |

Two consequences for the design. The redirect rows answer the `http.followRedirects`
question raised in the brief: git re-matches URL-scoped `http.*` config against
the redirect target, so **no `followRedirects` change is needed** — the header
cannot travel to another host, and a renamed-repo redirect on github.com still
authenticates. The third row is why req 4 exists and is not optional.

## Where the traffic comes from

`repo-prefetch.ts` sweeps every ready repo's bare cache every
`PREFETCH_INTERVAL_MS` (3 min) and `RepoGit.fetchCache` runs
`git fetch --all --force --prune` behind a 60s TTL — ~280 `Fetched bare cache`
lines an hour across 14 caches on the production VPS, around the clock. None of
those requests is authenticated today, because `RepoPrefetcherDeps.createRepoGit`
is `(dir: string) => RepoGit` — no credential — so the fetch falls through to the
global helper, which git never asks.

## Mechanism

### The header, and how the token reaches git (req 3)

Preemptive auth in git 2.39 is
`http.<origin>.extraHeader = Authorization: Basic base64(username:password)`.
Three ways to hand git that value, and only one satisfies req 3:

- **`-c http.<origin>.extraHeader=…` on the argv** — puts the credential (base64
  is not encryption) in `/proc/<pid>/cmdline`. This is exactly what
  docs/266-orchestrator-git-trust-boundary E3 refused for the credential helper.
  Rejected.
- **A file** — `-c include.path=<root-only file>`, or the orchestrator's global
  gitconfig. Both rejected. The global gitconfig is **root-owned 0644 and read by
  the session-worker uid on purpose** (`reshareGlobalGitConfig`), so the header
  in it is a secret readable by a non-root process — the brief's premise that
  "the global gitconfig already embeds the PAT" has been false since E3, which
  moved the PAT into a root-only file and left only its *path* in the config.
  `include.path` is worse than it looks: an unreadable include is a hard
  `fatal: unable to access` on **every** git command (measured in E3), so a
  root-only include would break every dropped-uid git in the process.
- **The environment** — `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` /
  `GIT_CONFIG_VALUE_0`. Not in argv, not at rest. **Chosen.**

This is the same split E3 already made for the credential helper: the *shape*
is ShipIt's, the *secret* rides the environment of a simple-git instance that is
created and consumed inside one function.

### Reconciling with the `GIT_CONFIG_COUNT` guards

Two existing controls forbid `GIT_CONFIG_COUNT`, and both survive intact because
each is about an environment ShipIt does **not** control:

- `sanitizeGitEnv` (`git-remote-credential.ts`) deletes `GIT_CONFIG_COUNT`,
  `GIT_CONFIG_PARAMETERS` and every `GIT_CONFIG_KEY_n`/`VALUE_n` from the
  *inherited* environment, because one of those is higher-precedence than
  anything `-c` can say and could reinstate the helper the reset just cleared.
  We add ours **after** that call, so the only such pair git sees is the one this
  module wrote. The guard's purpose — no inherited config injection — is
  unchanged.
- simple-git refuses to spawn on `GIT_CONFIG_COUNT` unless
  `unsafe.allowUnsafeConfigEnvCount` is set (`@simple-git/argv-parser`,
  `git_config_count → allowUnsafeConfigEnvCount`). `git-hooks-guard.ts` rejected
  that flag when the proposal was to set `GIT_CONFIG_COUNT` on **`process.env`**,
  where it would have disabled the protection for every instance in the process
  including ones that forward the inherited environment. Here it is set only on
  the two instances that already build their environment from
  `sanitizeGitEnv(process.env)` and already opt out of three other simple-git
  checks for the same reason (`credentialledGit`, `RepoGit`'s credentialled
  constructor). Those instances' environments contain no inherited `GIT_CONFIG_*`
  by construction, so the flag switches off a check that has nothing left to
  find. `process.env` is not touched.

### Coverage: where a credential gets resolved

The header can only be preemptive where a credential is *resolved*, so the work
is mostly widening resolution, not writing headers.

1. **`RepoGit` resolves lazily per remote op.** Today a `RepoGit` is credentialled
   only if its constructor was handed one, which happens on exactly one path
   (`plugin-fetch.ts`). `RepoGit` gains an optional async resolver, injected by
   `createRepoGit` in `app-di.ts` from `githubAuthManager`, and a private
   `remoteGit()` used by `fetchCache`, `clone`, `cloneBare`, `fetch` and
   `deleteBranch` — the same shape `GitManager.remoteGit()` already has. This is
   one change point rather than six: `repo-prefetch.ts`, `claim-session.ts`,
   `session.ts` (unarchive + restore), `warm-pool-manager.ts` and
   `shipit-source.ts` all get it without touching their call sites, and so does
   the next one somebody adds. An explicitly-supplied credential still wins.
2. **`resolveTreeRemoteCredential` stops gating on the uid drop.** Its
   `resolveGitTreeUid(dir) === null → null` early return means a non-dropping
   orchestrator gets no credential. Per requirements.md's resolved question that
   is only local/dogfood mode, but req 1 covers it and the gate no longer earns
   its keep. The blast radius is bounded by the resolver itself, which is
   **github.com-only** (`getGitCredential` in `services/github.ts`): every
   non-GitHub remote still resolves to `null` and is byte-for-byte unchanged.
   This also makes the root-side `git lfs pull` credentialled, which is req 1's
   "LFS cache fetch".
3. **`fetchLfsIntoCache`** (`git-lfs-store.ts`) runs against the bare cache and
   resolves nothing today; it takes the same resolver.

### Rejected credential (req 4)

Measured above: a public-repo fetch that succeeds anonymously today **fails**
with a stale PAT once the header is preemptive. That is "worse than today's
failure", so a remote op that could have succeeded anonymously retries **once**
without the credential when the first attempt fails auth-shaped.

- A shared `withPreemptiveAuthFallback` in `git-remote-credential.ts` takes the
  credential and a `run(credential | null)`, so the rule lives in one place.
  `null` there means "the git this call site would have built before docs/288",
  which is what makes the fallback exactly today's behaviour rather than an
  approximation of it.
- It takes an optional `rejected(value)` predicate, because not every git failure
  here is a throw: `runGit` in `git-lfs.ts` resolves with an exit code and
  captured stderr, so the LFS paths classify with the exported
  `looksLikeAuthRejection` instead of relying on a catch.
- Applied to the **fetch/clone** paths, where the anonymous retry can succeed.
  **Not** to `push`, where anonymous can never succeed: retrying there would
  replace a precise `Authentication failed` with a less useful
  `could not read Username`, which req 4 forbids.
- The auth-shaped signatures are taken from git's own output, observed above:
  `Invalid username or token`, `Authentication failed`,
  `could not read Username`, and `HTTP 401`.
- `fetchCache` still throws on a failure that survives the retry, so the failure
  surfaces exactly where it does today — the stale-cache warning path in
  `repo-prefetch.ts` / `claim-session.ts` / `session.ts` (req 4).

### Scope questions the brief raised, answered

- **`http.followRedirects`** — no change needed; measured above.
- **A repo-scoped installation token whose host matches but whose repo does
  not** — cannot arise. Every resolution derives `owner`/`repo` from the URL of
  the very remote being contacted (`parseRemoteOrigin` → the resolver), so the
  minted token is always scoped to the repository the request is for. A mint
  that fails falls back to the PAT (`getRepoScopedGitCredential`), which is
  host-scoped and repo-agnostic.

## Key files

| File | Change |
|---|---|
| `src/server/shared/git-remote-credential.ts` | preemptive header in `gitCredentialEnv`; `withPreemptiveAuthFallback` + `looksLikeAuthRejection`; `allowUnsafeConfigEnvCount` on `credentialledGit`; drop the uid gate in `resolveTreeRemoteCredential` |
| `src/server/shared/git.ts` | `remoteGit` no longer uid-gated; the `gitTreeUidDeps` test seam deleted, since removing the gate left nothing reading it |
| `src/server/orchestrator/repo-git.ts` | lazy per-op credential resolution + fallback on the remote ops |
| `src/server/orchestrator/app-di.ts` | wire the resolver into `createRepoGit` |
| `src/server/orchestrator/git-lfs-store.ts` | resolve a credential for the cache-side LFS fetch |
| `src/server/orchestrator/repo-prefetch.ts` | no call-site change; comment correction (the origin normalization no longer implies the *global* helper) |

## Tests

- **First request carries `Authorization` when a credential is held, and carries
  none when not** — a local Node HTTP server recording request headers, driven by
  a real `git ls-remote`. Asserts the header on the very first
  `GET /info/refs`, and its absence with no credential (req 1, req 2). The
  captured header value is redacted before any assertion message can print it.
- **req 3 guard** — the token appears in neither `gitCredentialConfig`'s argv
  entries nor any file; only in the env pairs.
- **Rejected credential** — the local server answers 401 to an authenticated
  request and 200 to an anonymous one; the fetch still succeeds, and a failure
  that survives the retry still throws out of `fetchCache`.
- **Non-GitHub remotes unchanged** — the resolver returns null, so no header and
  no env pairs.

The wire tests live in `src/server/shared/git-preemptive-auth.test.ts` and widen
`GIT_ALLOW_PROTOCOL` from `file` to `file:http` for their own `describe` only.
`server-test-setup.ts` pins it to `file` so that no server test pays for a
DNS + TLS round-trip to github.com to learn a fake URL is fake; the server here
is an ephemeral port on `127.0.0.1` that the file starts and stops, so no lookup
happens and no packet leaves the box. The original value is restored in
`afterEach`.

Every new guard was checked **red alone**: reverting the header leaves req 1's
and req 4's tests failing, and disabling only the retry leaves req 4's failing.
The server deliberately does not implement git's smart protocol, so each git
command fails and the assertions are over the recorded request log — which keeps
the fixture from passing for any reason other than the header.
