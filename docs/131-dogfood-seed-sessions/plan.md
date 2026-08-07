---
description: Seed script that adds a reproducible set of repos to the ShipIt-in-ShipIt dogfood loop at dev-service boot, plus the API the outer agent uses to drive the inner ShipIt.
issue: planning#54
---

# Dogfood seed sessions (reproducible inner state for ShipIt-in-ShipIt)

Implements [`requirements.md`](./requirements.md).

Make the dogfood inner orchestrator (`RUNTIME_MODE=local`, feature 118) come up
with at least one repo from a committed fixture already added, trusted and
warmed, so manual and automated testing of the inner UI doesn't start from an
empty slate every time (reqs 1–2).

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
`command:`, that — after the inner orch is healthy — adds and trusts the
fixture's repos via the inner orch's HTTP API. Idempotent: a dev-service restart
that finds them already registered does nothing (reqs 1, 4, 6).

**Goal (reqs 8–10).** The outer agent can start an inner agent — in a new
session on a seeded repo, or in a session that already exists — read back its
conversation, and tell whether it is still working. Designed in [Driving the inner ShipIt from the outer agent](#driving-the-inner-shipit-from-the-outer-agent-reqs-810)
below.

**Non-goals.**
- Blank / template-scaffolded inner sessions. There is no public "create empty
  session" endpoint (only the `isTestMode`-gated `POST /api/_test/sessions`, and
  `isTestMode` is *off* in local mode — see `docs/118` hardening notes on
  `isTestMode ≠ runtimeMode === "local"`). v1 seeds repo-backed sessions only,
  which is the realistic test target anyway.
- Persisting inner state across outer sessions. Explicitly rejected — see above.
- Seeding chat history / running turns as part of the fixture. The seed makes
  the repo ready to work in; creating a session and exercising it is the caller's
  job. (This is also why the seed does not create sessions — see "Why not
  `claim-session`" below.)
- Changing anything in the orchestrator code *for the seeding half* (reqs 1–7):
  that is entirely the seed script + the compose file + a fixture file. Reqs
  8–10 are not covered by this claim.

## What the seed actually does (the API the script drives)

Seeding is **adding a repo**, not creating a session (req 1). Two calls per
fixture entry, both of which already exist:

```
POST /api/repos            { url }        — register + clone the bare cache
POST /api/repos/trust      { url }        — clear the agent trust gate
```

`POST /api/repos` clones the bare cache in the background, flips the repo to
`ready`, broadcasts `repo_status`, **and then calls `warmSessionForRepo` itself**
(`api-routes-session-repos.ts:98`). So warming is a consequence of adding the
repo — the seed does not have to arrange it. By the time the repo is `ready` and
warm, opening it in the inner UI is one instant click with no clone wait, which
is what req 1 asks for.

The trust call is not optional: a repo added by URL is untrusted by default, and
every dispatch path opens with the trust gate — `AgentTurnAdmissionError`, 403
`repository_untrusted` (`session-runner.ts:336`). Public repos are not exempt.
Without it the seeding "works" and then reqs 8–10 fail on first use.

The seed script therefore:
1. Polls the inner orch until it is up.
2. `GET /api/repos` — fixture entries already registered and `ready` are skipped
   (req 4). This is the idempotency key.
3. For the rest: `POST /api/repos` → poll until `ready` → `POST /api/repos/trust`.
4. Logs each result; exits 0 even on partial failure (req 5 — a bad fixture entry
   must not wedge the dev service).

### Why not `claim-session`

An earlier draft of this design had the seed call
`POST /api/repos/:url/claim-session` to pre-create a session per repo. A
cross-agent review (2026-08-04) established that this cannot work and is not
needed:

- **A claimed session is invisible.** `claim` ends with `setWarm(appSessionId,
  true)` (`services/claim-session.ts:445`), and both `list()` and `listAll()` are
  `WHERE warm = 0` (`sessions.ts:358`, `:598`). A claimed-but-untouched session
  appears nowhere — not in the inner UI, not in `GET /api/sessions/all`. It
  graduates on its first message (`services/graduate-session.ts`), which the seed
  deliberately does not send. The original idempotency check — diff the fixture
  against session `remoteUrl`s — could therefore never match.
- **It isn't a standalone entry point anyway.** `claim` throws `404 Repository
  not found` if the repo isn't registered and `400 Repository is still cloning`
  until it's ready (`services/claim-session.ts:299`), so `POST /api/repos` has to
  come first regardless.
- **Adding the repo already warms one.** Which is the only benefit claiming
  offered.

(That draft also asserted "the warm pool is disabled in local mode, so this
always slow-paths". Also wrong: `createWarmPool` is always constructed
(`bootstrap-managers.ts:794`) and prepares warm *workspaces* when
`containerManager` is null (`warm-pool-manager.ts:190`) — local mode lacks
standby *containers*, not the pool.)

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
    { "url": "https://github.com/my-test-account/test-repo-a" }
  ]
}
```

- Checked in so the fixture is reproducible and self-documenting (req 2). One
  entry satisfies req 1, so the committed file ships with a single small repo
  (`nicolasalt-shipit/todo-list`) — every extra entry is another bare-cache
  clone at boot, and multi-entry handling is a unit-test concern rather than a
  default. That repo is not publicly readable, so seeding it needs the inner
  ShipIt's `GITHUB_TOKEN` secret; without it the seed logs req 7's warning and
  the clone fails, which is the behavior req 7 exists to make legible.
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
API. **Every call it needs already exists** — including the one an earlier draft
of this section called a gap.

**Reaching the inner orch.** The `dev` service publishes port 3000, and Vite
proxies `/api` to the orch on 4000 (`vite.config.ts`), so every call below goes
to the `dev` service's port 3000. The outer agent resolves that the documented
way — `GET /api/sessions/${SHIPIT_SESSION_ID}/services` on the *outer*
orchestrator gives the service's `containerIp` and `port`
(`shipit-docs/preview.md`). No new plumbing.

| Need | Route | Exists? |
|---|---|---|
| List the inner sessions | `GET /api/sessions/all` | Yes (warm sessions are filtered out — see above) |
| Start work in a **new** session on a seeded repo (req 8) | `POST /api/sessions/headless` — `{ repoUrl, initialPrompt }` | Yes |
| Start work in an **existing** session (req 8) | `POST /api/sessions/:id/agent/dispatch` — `{ text }` | Yes |
| Read the conversation (req 9) | `GET /api/sessions/:id/history` | Yes |
| Still working, or done? (req 10) | `GET /api/sessions/:id/status` → `{ sessionId, running, queueLength }` | Yes |

> **Correction (2026-08-04, cross-agent review).** This section previously
> claimed messaging an existing session was WebSocket-only, cited
> `docs/160-external-control-api`'s missing-piece list as evidence, and proposed
> adding `POST /api/sessions/:id/message`. That was wrong.
> `POST /api/sessions/:id/agent/dispatch` is registered
> (`api-routes-agent.ts:52`, `api-routes.ts:385`), takes `{ text }`, runs the
> same gates as WS `send_message`, and calls `runner.dispatch`
> (`services/agent.ts:82`). docs/160's write-up is stale. **No new route.**

**What is actually missing is a cold session, not a route.** `dispatchAgentMessage`
resolves the runner from `SessionRunnerRegistry` and returns **404 when there
isn't one** (`services/agent.ts:126`, pinned by
`integration_tests/agent-dispatch-route.test.ts:140`). The WS path doesn't hit
that because connecting *activates* the session first — `getOrCreate` via
`activateSession` (`ws-handlers/send-message.ts:389`, `route-registry.ts:809`).
A session nobody currently has open — from an earlier dogfood boot, or one that
went idle — has no runner, so an HTTP dispatch at it 404s. That is the gap for
req 8's "session that already exists" half.

So the work for reqs 8–10 is:

- **Wake-on-dispatch.** Let the HTTP dispatch path activate a session that has
  no runner, the way a WS connect does, instead of 404ing. This is the whole of
  the new behavior, and it belongs to the existing route rather than to a second
  one. Implemented by lifting the materialization out of `activateSession` into
  `services/materialize-runner.ts` and calling it from both sides, so the
  archived guard and the planning#181 workspace restore cannot drift between
  transports. What still 404s: an id with no session row, an archived session,
  and a session with no workspace.
- **Trust, at seed time.** The 403 trust gate (`session-runner.ts:336`) is the
  other thing between a seeded repo and a working dispatch; the seed script
  calling `POST /api/repos/trust` covers it, which is why it's in the seeding
  steps above rather than here.

Deliberately **not** in scope: docs/160's personal access tokens and auth
middleware. Every orch route is unauthenticated today and the dispatch route is
no different — the inner orch is reachable only on the Compose network. That's a
real limitation of the current trust model, not something this feature should
quietly fix on the side; docs/160 owns it.

**Why no wrapper CLI.** No `shipit dogfood ...` command, no helper script: the
calls above are `curl` one-liners against a documented API, and a wrapper would
be a second surface to keep in sync with the routes. A short section in
`CLAUDE.md`'s dogfooding paragraph, listing them, is the deliverable.

## Key files

| File | Change |
|---|---|
| `scripts/seed-inner-sessions.js` | New. Add repo → poll `ready` → trust, per fixture entry, keyed for idempotency on `GET /api/repos`. Non-fatal on error, honors `DOGFOOD_SEED`. Plain Node (no deps) so it runs before/independent of the build. |
| `scripts/dogfood-seed.json` | New. Default fixture — one repo. |
| `docker-compose.yml` | Background seed step in the `dev` service's `command:`, detached so Vite is not held up. |
| `docs/118-shipit-ui-local/plan.md` | Cross-link this doc from the dogfooding section. **Done.** |
| `CLAUDE.md` | The "Dogfooding ShipIt in ShipIt" paragraph: the seed, plus the four calls the outer agent uses to drive the inner ShipIt. |
| `services/materialize-runner.ts` | New. The runner-materialization core lifted out of `activateSession` — archived guard, agent reconciliation, workspace restore, `getOrCreate` — so WS connect and HTTP dispatch bring a session up the same way. |
| `services/agent.ts` | Wake-on-dispatch: an optional `wakeSession` dep, used when the registry has no runner, instead of returning 404. |
| `api-routes-agent.ts` | Supplies `wakeSession` from `materializeRunner`. |
| `route-registry.ts` | `activateSession` delegates to the shared helper. |

Reqs 1–7 need no orchestrator/client/shared code changes — both routes the seed
script drives already exist. Reqs 8–10 add **no new route**; they change one
existing behavior (dispatch against a session with no runner).

### Why the materialization split is sync + async

`materializeRunnerSync` does everything that doesn't touch the disk and returns
`needs-restore` for the one case that does; `materializeRunner` awaits that tail
for HTTP callers, and `activateSession` drives the two halves itself. That is
not incidental structure. `activateSession` is invoked as `void
activateSession(sid)` and the connect handler keeps sending frames immediately
after, so making the *common* path async pushes
`session_container_freshness` behind them — `connection.test.ts` failed on
exactly that during implementation. Before the extraction, only a session with a
remote ever awaited; the split preserves that. `materialize-runner.test.ts`
pins it.

## Tests

- **Unit** (`scripts/seed-inner-sessions.test.ts`): with a faked `fetch`, assert
  the script (a) skips fixture repos already registered and `ready`, (b) for a
  new one runs add → poll-ready → trust in that order, (c) exits 0 when any one
  of those calls fails and still processes the remaining entries (req 5),
  (d) no-ops cleanly when `DOGFOOD_SEED=0` or the fixture file is missing.
- **Integration** (reqs 8–10, in `integration_tests/`): the one that matters is
  **dispatch against a cold session** — a session with no runner in the registry
  gets activated and runs the turn instead of 404ing. Extend
  `agent-dispatch-route.test.ts`, whose current 404-on-no-runner case pins the
  behavior being changed. Alongside it: `GET /api/sessions/:id/status` flips
  `running` false→true→false around that turn, and `GET /api/sessions/:id/history`
  contains it afterwards. Uses the existing `buildApp` + `TestClient` +
  `FakeClaudeProcess` harness — no dogfood stack needed.
- **Manual smoke**: open the ShipIt repo in production ShipIt, set the
  `GITHUB_TOKEN` secret, start the dev service. Confirm the inner UI comes up
  with the fixture repo present, ready and trusted, and opening it giving a
  session with no clone wait (req 1). Restart the dev service; confirm the script
  no-ops and nothing is duplicated (req 4). Then, as the outer agent: create a
  session on that repo, dispatch a task at it, poll status until it stops
  running, and read the conversation back (reqs 8–10).

## Open questions / risks

No requirements-level open questions are outstanding — see
[`requirements.md`](./requirements.md). The items below are design risks for the
implementer.

- **Health probe shape.** The script needs a route that returns 200 once the
  orch is ready. `GET /api/bootstrap` is the assumption; confirm during
  implementation. The *fixture diff* keys on `GET /api/repos`.
- **Clone cost at boot.** Several fixture repos = several bare-cache clones plus
  their warm-session prep, serialized in the background. Acceptable
  (non-blocking, repos become ready progressively), but keep the default fixture
  small.
- **Auth race.** Registering a private repo needs `GitHubAuthManager` to have
  picked up the token. It reads env at
  `checkCredentials()` time and the env is set at container boot, so this should
  be fine — but the script's not-authenticated detection (above) is the backstop
  if it isn't.
- **Wake-on-dispatch is a behavior change to a shared route.** `/agent/dispatch`
  is used by Fix-CI, child sessions and the agent SDK, not just this feature. Its
  404-on-no-runner is currently load-bearing for those callers' error handling;
  check each before relaxing it, and keep the WS activation path as the single
  implementation rather than growing a second one.
- **Partial-failure visibility.** The script logs under a `[seed]` prefix in the
  dev service logs; that's the only surfacing in v1. If it proves too easy to
  miss, a later iteration could emit a notice into the inner UI.
