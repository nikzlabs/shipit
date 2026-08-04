---
description: Seed script that provisions reproducible inner sessions for the ShipIt-in-ShipIt dogfood loop at dev-service boot.
issue: https://linear.app/shipit-ai/issue/SHI-52
---

# Dogfood seed sessions (reproducible inner sessions for ShipIt-in-ShipIt)

Implements [`requirements.md`](./requirements.md).

Make the dogfood inner orchestrator (`RUNTIME_MODE=local`, feature 118) come up
with at least one repo-backed inner session already provisioned, from a
committed fixture, so manual and automated testing of the inner UI doesn't start
from an empty slate every time (reqs 1–2).

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
dev-service restart that finds the sessions already present does nothing
(reqs 1, 4, 6).

**Goal (reqs 8–10).** The outer agent can start an inner agent — in a seeded
session or a fresh one — read back its conversation, and tell whether it is
still working. Designed in [Driving the inner ShipIt from the outer agent](#driving-the-inner-shipit-from-the-outer-agent-reqs-810)
below.

**Non-goals.**
- Blank / template-scaffolded inner sessions. There is no public "create empty
  session" endpoint (only the `isTestMode`-gated `POST /api/_test/sessions`, and
  `isTestMode` is *off* in local mode — see `docs/118` hardening notes on
  `isTestMode ≠ runtimeMode === "local"`). v1 seeds repo-backed sessions only,
  which is the realistic test target anyway.
- Persisting inner state across outer sessions. Explicitly rejected — see above.
- Seeding chat history / running turns as part of the fixture. The seed creates
  the session + clones the repo; exercising it is the test's job.
- Changing anything in the orchestrator code *for the seeding half* (reqs 1–7):
  that is entirely the seed script + the compose file + a fixture file. Reqs
  8–10 are not covered by this claim.

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

## When the inner ShipIt has no GitHub access (req 7)

The inner orch's `GITHUB_TOKEN` is a **user-supplied secret**, set once in the
outer ShipIt's Settings → Secrets. It arrives as `process.env.GITHUB_TOKEN`,
which is what `GitHubAuthManager.checkCredentials()` reads (`github-auth.ts` —
env var is checked after the credential store).

> This doc originally proposed making that change — dropping
> `source: platform:github_token` from the `x-shipit-secrets` entry so the inner
> orch stopped inheriting the outer user's GitHub identity. That has since
> landed independently: `docs/184-remove-platform-secret-forwarding` removed
> platform secret forwarding wholesale, so every `x-shipit-secrets` entry in
> `docker-compose.yml` is already user-supplied. Nothing is left to do here.

**Consequence the script must still handle:** if the developer hasn't set the
secret, the inner orch has no GitHub auth. Public fixture repos still clone
anonymously; private ones fail. The seed script must detect the
not-authenticated state (visible in `GET /api/bootstrap`) and log a clear
"GitHub not authenticated — set the GITHUB_TOKEN secret in the outer ShipIt;
private repos will be skipped" message rather than failing opaquely.

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

- Checked in so the fixture is reproducible and self-documenting (req 2). One
  entry satisfies req 1; the committed file ships with a couple of innocuous
  public repos as a sane default.
- `DOGFOOD_SEED=0` disables seeding entirely (req 3).
- The committed file is the **only** input. An earlier draft added a gitignored
  `scripts/dogfood-seed.local.json` override plus a `DOGFOOD_SEED_FILE` escape
  hatch; that was dropped — there is one developer, so a personal set and the
  committed set are the same thing (`requirements.md`, resolved 2026-08-04).

## Where it runs

Wired into the dogfood `docker-compose.yml` `command:`. The orch is started in
the background already; the seed is launched as a background step right after,
so it doesn't block Vite coming up and the inner UI is usable while sessions
trickle in (req 6) — one line added to the command as it stands today:

```sh
sh -c "
  mkdir -p $${SHIPIT_STATE_DIR:-/workspace/.inner-shipit} $${AGENT_HOME:-/root} &&
  while [ ! -x node_modules/.bin/vite ]; do
    echo '[dev] waiting for agent.install to populate node_modules…'; sleep 1;
  done &&
  PORT=4000 npm run dev &
  (node scripts/seed-inner-sessions.js 2>&1 | sed 's/^/[seed] /' &) &&
  API_PORT=4000 exec npx vite --host 0.0.0.0 --port 3000
"
```

(The `npm install` this doc originally showed is gone — the `dev` service shares
the agent container's `node_modules` and waits for `agent.install` instead; see
feature 137. The seed step slots in after the orch launch either way.)

The script itself owns the "wait until healthy" poll (bounded retries, ~60s cap)
so it's resilient to the orch taking a while to boot behind that wait.

## Driving the inner ShipIt from the outer agent (reqs 8–10)

The outer agent already has a shell and the inner ShipIt already has an HTTP
API. Three of the four things it needs are plain `curl` against routes that
exist today; only one is missing.

**Reaching the inner orch.** The `dev` service publishes port 3000, and Vite
proxies `/api` to the orch on 4000 (`vite.config.ts`), so every call below goes
to the `dev` service's port 3000. The outer agent resolves that the documented
way — `GET /api/sessions/${SHIPIT_SESSION_ID}/services` on the *outer*
orchestrator gives the service's `containerIp` and `port`
(`shipit-docs/preview.md`). No new plumbing.

| Need | Route | Exists? |
|---|---|---|
| List the inner sessions (find a seeded one by `remoteUrl`) | `GET /api/sessions/all` | Yes |
| Start work in a **fresh** session (req 8) | `POST /api/sessions/headless` — `{ repoUrl, initialPrompt }`, plus optional `branch`/`agent`/`model` | Yes |
| Start work in a **seeded** session (req 8) | — | **No: WS-only `send_message`** |
| Read the conversation (req 9) | `GET /api/sessions/:id/history` | Yes |
| Still working, or done? (req 10) | `GET /api/sessions/:id/status` → `{ running, queueLength }` | Yes |

**The one gap: `POST /api/sessions/:id/message`.** Sending a message to an
existing session is WebSocket-only (`send_message` in `ws-client-messages.ts`);
the only HTTP path is `POST /api/sessions/:parentId/children/:childId/message`,
which is parent-to-child. This is exactly missing piece #1 in
`docs/160-external-control-api`, and it's what makes the *seeded* sessions
reachable at all — without it, reqs 1–7 provision sessions the outer agent
cannot use.

Add the thin version of that route: body `{ text }`, resolve the runner from
`SessionRunnerRegistry`, hand off to the same path `send_message` takes, return
`202` with the session id. Deliberately **not** in scope: docs/160's personal
access tokens and auth middleware. Every orch route is unauthenticated today and
this one is no different — the inner orch is reachable only on the Compose
network. That's a real limitation of the current trust model, not something this
feature should quietly fix on the side; docs/160 owns it.

**Why not have the outer agent speak WebSocket instead** (and add no route)?
A WS client is more code than a fetch, it would live somewhere nobody else uses,
and it leaves the documented gap open. A route the agent can `curl` needs no
client at all — which is the whole reason the capability is cheap.

**Why no wrapper CLI.** No `shipit dogfood ...` command, no helper script: the
four calls above are `curl` one-liners against a documented API, and a wrapper
would be a second surface to keep in sync with the routes. A short section in
`CLAUDE.md`'s dogfooding paragraph, listing the four calls, is the deliverable.

## Key files

| File | Change |
|---|---|
| `scripts/seed-inner-sessions.js` | New. Polls `GET /api/bootstrap`, diffs fixture against existing `remoteUrl`s, `POST`s `claim-session` for the rest. Idempotent, non-fatal on error, honors `DOGFOOD_SEED`. Plain Node (no deps) so it runs before/independent of the build. |
| `scripts/dogfood-seed.json` | New. Default fixture — a couple of public repos. |
| `docker-compose.yml` | Add the background seed step to the `dev` service's `command:`. |
| `docs/118-shipit-ui-local/plan.md` | Cross-link this doc from the dogfooding section. **Done.** |
| `CLAUDE.md` | The "Dogfooding ShipIt in ShipIt" paragraph: one line on the seed, plus the four calls the outer agent uses to drive the inner ShipIt. |
| `api-routes-session-crud.ts` | New. `POST /api/sessions/:id/message` — `{ text }` → resolve runner from the registry → same path as WS `send_message` → `202`. The one gap for reqs 8–10. |

Reqs 1–7 need no orchestrator/client/shared code changes — the inner orch
already exposes `POST /api/repos/:url/claim-session` and reads
`process.env.GITHUB_TOKEN`. Reqs 8–10 add exactly one route; everything else
they need already exists.

## Tests

- **Unit** (`scripts/seed-inner-sessions.test.ts`): with a faked `fetch`, assert
  the script (a) skips repos whose URL already appears as a session `remoteUrl`,
  (b) `POST`s `claim-session` with a correctly `encodeURIComponent`'d URL for new
  ones, (c) exits 0 when a `claim-session` call fails, (d) no-ops cleanly when
  `DOGFOOD_SEED=0` or the fixture file is missing.
- **Integration** (reqs 8–10, in `integration_tests/`): `POST
  /api/sessions/:id/message` reaches a running session's runner and 404s on an
  unknown id; `GET /api/sessions/:id/status` flips `running` false→true→false
  around a turn; `GET /api/sessions/:id/history` contains the turn afterwards.
  Uses the existing `buildApp` + `TestClient` + `FakeClaudeProcess` harness — no
  dogfood stack needed.
- **Manual smoke**: open the ShipIt repo in production ShipIt, set the
  `GITHUB_TOKEN` secret, start the dev service. Confirm the inner UI comes up
  with the fixture session(s) present, each with its repo cloned. Restart the dev
  service; confirm the script no-ops and no duplicates appear (req 4). Then, as
  the outer agent: send a task to a seeded session, poll status until it stops
  running, and read the conversation back (reqs 8–10).

## Open questions / risks

No requirements-level open questions are outstanding — see
[`requirements.md`](./requirements.md). The items below are design risks in the
seeding half, for the implementer.

- **Health probe shape.** The script assumes `GET /api/bootstrap` returns 200
  once the orch is ready and includes the session list with `remoteUrl`s.
  Confirm that's the right payload during implementation; if not, use whatever
  the bootstrap/session-list route actually is.
- **Clone cost at boot.** Several fixture repos = several clones serialized in
  the background. Acceptable (non-blocking, sessions appear progressively), but
  keep the default fixture small.
- **Auth race.** `claim-session` for a private repo needs `GitHubAuthManager` to
  have picked up the token. It reads env at `checkCredentials()` time and the env
  is set at container boot, so this should be fine — but the script's
  not-authenticated detection (above) is the backstop if it isn't.
- **Partial-failure visibility.** The script logs under a `[seed]` prefix in the
  dev service logs; that's the only surfacing in v1. If it proves too easy to
  miss, a later iteration could emit a notice into the inner UI.
