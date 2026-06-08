---
description: Seed script that provisions reproducible inner sessions for the ShipIt-in-ShipIt dogfood loop at dev-service boot, with a dedicated testing GitHub token.
---

# Dogfood seed sessions (reproducible inner sessions for ShipIt-in-ShipIt)

Make the dogfood inner orchestrator (`RUNTIME_MODE=local`, feature 118) come up
with a known set of repo-backed inner sessions already provisioned, so manual
and automated testing of the inner UI doesn't start from an empty slate every
time. Also stop forwarding the outer user's GitHub token into the inner orch by
default — let the developer supply a dedicated *testing* token instead, so the
dogfood loop runs against a separate GitHub account with throwaway repos.

This is "Option B" from the discussion in `docs/118-shipit-ui-local/plan.md`'s
follow-up: persistence of inner state is the wrong goal (it drifts and goes
stale across outer sessions anyway — `sessions/` and `.inner-shipit/` are
gitignored and never travel between outer sessions). Reproducible *fixtures*
beat persistent mutable state.

## Problem

Inner-session state (`/workspace/.inner-shipit/` SQLite db + `/workspace/sessions/{id}/`
clones) lives inside the outer session's workspace volume and is gitignored. It
survives dev-service restarts and idle eviction *within one outer session*, but:

- A fresh outer session starts with empty `sessions/` and `.inner-shipit/`.
- `archiveSession` / `fullReset` on the outer session wipes it.

So every new outer session means re-clicking through "open repo → create
session" N times before you can test anything. For automated testing it's worse
— there's no clean fixture to assert against.

## Goal & non-goals

**Goal.** A checked-in seed script, wired into the dogfood `docker-compose.yml`
`command:`, that — after the inner orch is healthy — provisions a fixture-defined
set of repo-backed inner sessions via the inner orch's HTTP API. Idempotent: a
dev-service restart that finds the sessions already present does nothing.

**Goal.** Decouple the inner orch's GitHub identity from the outer user's. The
`GITHUB_TOKEN` `platform:github_token` forward is removed; the developer supplies
a testing-account token through the outer ShipIt's secret store instead.

**Non-goals.**
- Blank / template-scaffolded inner sessions. There is no public "create empty
  session" endpoint (only the `isTestMode`-gated `POST /api/_test/sessions`, and
  `isTestMode` is *off* in local mode — see `docs/118` hardening notes on
  `isTestMode ≠ runtimeMode === "local"`). v1 seeds repo-backed sessions only,
  which is the realistic test target anyway.
- Persisting inner state across outer sessions. Explicitly rejected — see above.
- Seeding chat history / running turns as part of the fixture. The seed creates
  the session + clones the repo; exercising it is the test's job.
- Changing anything in the orchestrator code. This feature is entirely the seed
  script + the compose file + a fixture file + `.gitignore`.

## How inner sessions get created (the API the script drives)

There is no generic "create session" endpoint in production wiring. The realistic
path is the **repo claim** endpoint, which creates a session *and* clones a repo
into it:

```
POST /api/repos/:url/claim-session      (:url is encodeURIComponent'd)
```

(`api-routes-session.ts` — claims a warm session if one exists, else slow-paths
through `createSessionDirFull()`, then `cacheGit.cloneFromCache()`, then
`sessionManager.setRemoteUrl()` / `setBranch()` / `setWarm()`.) The warm pool is
disabled in local mode, so this always slow-paths — fine, it's a background boot
step.

The seed script therefore:
1. Polls `GET /api/bootstrap` on the inner orch (`http://localhost:4000`) until
   it returns 200 — the orch is up.
2. Reads the existing session list from that bootstrap payload.
3. For each repo in the fixture whose URL is **not** already a `remoteUrl` of an
   existing session, `POST`s `claim-session`.
4. Logs each result; exits 0 even on partial failure (a bad fixture entry must
   not wedge the dev service).

Idempotency falls out of step 3: on a dev-service restart within the same outer
session, `.inner-shipit/` still has the sessions, so every fixture entry matches
an existing `remoteUrl` and the script no-ops.

## GitHub token change

Today `docker-compose.yml` forwards the outer user's token:

```yaml
x-shipit-secrets:
  - { name: GITHUB_TOKEN, source: platform:github_token }
```

`platform-credentials.ts` resolves `platform:github_token` from the outer
`GitHubAuthManager`. We **remove the `source:`** so the entry resolves from the
outer ShipIt's user secret store instead (the resolver in `secret-resolver.ts`
falls through to `userSecrets[req.name]` when there's no `source:`):

```yaml
x-shipit-secrets:
  - { name: ANTHROPIC_API_KEY,    source: platform:claude_oauth }   # unchanged
  - { name: ANTHROPIC_AUTH_TOKEN, source: platform:claude_oauth }   # unchanged
  - { name: GITHUB_TOKEN }                                          # was: source: platform:github_token
```

The developer sets `GITHUB_TOKEN` once in the outer ShipIt's secrets UI to a
**testing-account** personal access token. It still arrives at the inner orch as
`process.env.GITHUB_TOKEN`, which is exactly what `GitHubAuthManager.checkCredentials()`
reads (`github-auth.ts` — env var is checked after the credential store). No orch
code change needed.

Why not a plain compose `environment:` passthrough (`GITHUB_TOKEN: "${GITHUB_TOKEN:-}"`)?
That depends on `docker compose` substituting from whatever environment
`ServiceManager` invokes compose in, which isn't a controllable knob from the
repo. The secret-store route is ShipIt-native, definitely works, and keeps the
test token out of the repo and out of git. (Anthropic creds stay on
`platform:claude_oauth` — only the *git* identity is being separated, so the
dogfood loop keeps using the developer's own Claude subscription.)

**Consequence to handle in the script:** with no token forwarded by default, if
the developer hasn't set the secret the inner orch has no GitHub auth. Public
fixture repos still clone anonymously; private ones fail. The seed script must
detect a missing/!authenticated state (visible in `GET /api/bootstrap`) and log
a clear "GitHub not authenticated — set the GITHUB_TOKEN secret in the outer
ShipIt; private repos will be skipped" message rather than failing opaquely.

## Fixture format

A checked-in `scripts/dogfood-seed.json`:

```json
{
  "repos": [
    { "url": "https://github.com/my-test-account/test-repo-a" },
    { "url": "https://github.com/my-test-account/test-repo-b" }
  ]
}
```

- Checked in so the fixture is reproducible and self-documenting.
- Because the repos belong to the developer's own test account, support an
  override: if `scripts/dogfood-seed.local.json` exists it wins over the
  committed file (and is gitignored), and `DOGFOOD_SEED_FILE` can point
  elsewhere entirely. The committed file ships with a couple of innocuous public
  repos as a sane default.
- `DOGFOOD_SEED=0` disables seeding entirely.

## Where it runs

Wired into the dogfood `docker-compose.yml` `command:`. The orch is started in
the background already; the seed is launched as a background step right after,
so it doesn't block Vite coming up and the inner UI is usable while sessions
trickle in:

```sh
sh -c "
  mkdir -p $${SHIPIT_STATE_DIR:-/workspace/.inner-shipit} &&
  npm install &&
  (PORT=4000 npm run dev 2>&1 | sed 's/^/[orch] /' &) &&
  (node scripts/seed-inner-sessions.js 2>&1 | sed 's/^/[seed] /' &) &&
  API_PORT=4000 exec npx vite --host 0.0.0.0 --port 3000
"
```

The script itself owns the "wait until healthy" poll (bounded retries, ~60s cap)
so it's resilient to the orch taking a while to boot behind `npm install`.

## Key files

| File | Change |
|---|---|
| `scripts/seed-inner-sessions.js` | New. Polls `GET /api/bootstrap`, diffs fixture against existing `remoteUrl`s, `POST`s `claim-session` for the rest. Idempotent, non-fatal on error, honors `DOGFOOD_SEED` / `DOGFOOD_SEED_FILE`. Plain Node (no deps) so it runs before/independent of the build. |
| `scripts/dogfood-seed.json` | New. Default fixture — a couple of public repos. |
| `docker-compose.yml` | (a) Add the background seed step to `command:`. (b) Drop `source: platform:github_token` from the `GITHUB_TOKEN` `x-shipit-secrets` entry. |
| `.gitignore` | Add `scripts/dogfood-seed.local.json`. |
| `docs/118-shipit-ui-local/plan.md` | Cross-link this doc from the dogfooding section. |
| `CLAUDE.md` | One line in the "Dogfooding ShipIt in ShipIt" paragraph noting the seed + the testing-token secret. |

No orchestrator/client/shared code changes — the inner orch already exposes
`POST /api/repos/:url/claim-session` and reads `process.env.GITHUB_TOKEN`.

## Tests

- **Unit** (`scripts/seed-inner-sessions.test.ts`): with a faked `fetch`, assert
  the script (a) skips repos whose URL already appears as a session `remoteUrl`,
  (b) `POST`s `claim-session` with a correctly `encodeURIComponent`'d URL for new
  ones, (c) exits 0 when a `claim-session` call fails, (d) no-ops cleanly when
  `DOGFOOD_SEED=0` or the fixture file is missing, (e) prefers
  `dogfood-seed.local.json` over the committed fixture.
- **Manual smoke**: open the ShipIt repo in production ShipIt, set a
  testing-account `GITHUB_TOKEN` secret, start the dev service. Confirm the inner
  UI comes up with the fixture sessions present, each with its repo cloned.
  Restart the dev service; confirm the script no-ops and no duplicates appear.

## Open questions / risks

- **Health probe shape.** The script assumes `GET /api/bootstrap` returns 200
  once the orch is ready and includes the session list with `remoteUrl`s.
  Confirm that's the right payload during implementation; if not, use whatever
  the bootstrap/session-list route actually is.
- **Clone cost at boot.** Several fixture repos = several clones serialized in
  the background. Acceptable (non-blocking, sessions appear progressively), but
  keep the default fixture small and let developers grow their `.local.json`.
- **Auth race.** `claim-session` for a private repo needs `GitHubAuthManager` to
  have picked up the token. It reads env at `checkCredentials()` time and the env
  is set at container boot, so this should be fine — but the script's
  not-authenticated detection (above) is the backstop if it isn't.
- **Partial-failure visibility.** The script logs under a `[seed]` prefix in the
  dev service logs; that's the only surfacing in v1. If it proves too easy to
  miss, a later iteration could emit a notice into the inner UI.
