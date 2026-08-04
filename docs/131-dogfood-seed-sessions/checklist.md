# 131 — Dogfood seed sessions: checklist

Implemented and smoke-tested on a real dogfood stack (2026-08-04). One step of
the smoke is blocked on a human: the inner ShipIt has no agent account connected,
and connecting one is an OAuth flow only the user can complete.

## Remaining

- [ ] Finish the reqs 9–10 smoke once the inner ShipIt is signed in to a Claude
      or Codex account (Settings → Agents in the inner UI). Then: dispatch at a
      session, poll `GET /api/sessions/:id/status` until `running` goes false,
      and read the turn back from `GET /api/sessions/:id/history`. Everything up
      to the agent itself is already verified — see below.

## Manual smoke (2026-08-04, `dev` service in production ShipIt)

- [x] **req 1** — first boot: `[seed] … added and trusted`, and
      `GET /api/repos` reports the fixture repo `status: ready`,
      `trusted: true`, with a `warmSessionId` already allocated (so opening it
      is instant, which is the point of req 1). The inner UI's sidebar shows
      `todo-list` with no trust banner.
- [x] **req 4** — second boot logged `already present` /
      `0 seeded, 1 already present, 0 failed`. The repo list still has exactly
      one entry, with its original `addedAt` and its warm session intact:
      nothing re-cloned, nothing duplicated.
- [x] **req 7** — the warning path was exercised earlier against a local
      orchestrator with no GitHub login. On the real stack `GITHUB_TOKEN` is
      set, so the private fixture repo cloned cleanly.
- [x] **req 8 (wake half)** — dispatching at the warm session, which had no
      runner, reached the *auth gate* (401 "Claude is not authenticated")
      rather than 404 "Session is not active". The auth gate is step 3 of
      `dispatchAgentMessage` and step 2 is runner resolution, so a 401 proves
      the runner was materialized. A genuinely unknown session id still 404s.
- [ ] **reqs 9–10** — blocked on the agent sign-in above. `GET /status`
      answers correctly for a session with no runner
      (`{running: false, queueLength: 0}`); what's untested is a real turn
      flowing through it and landing in history.

## Seeding (reqs 1–7)

- [x] `scripts/seed-inner-sessions.js` — polls until the orch is healthy, skips
      fixture repos already registered and `ready`, then add → poll `ready` →
      trust for the rest. No `claim-session` — adding the repo warms one anyway,
      and a claimed session is invisible. `GET /api/repos` is the idempotency
      key, NOT the session list. Exits 0 on partial failure, honors
      `DOGFOOD_SEED`. Reads the committed fixture only.
- [x] Health probe confirmed: `GET /api/bootstrap` is registered by the same
      `buildApp()` call as the rest of the API, so a 200 there means the routes
      the script drives are live. Its payload also carries `githubStatus`, so
      the auth check costs no extra round-trip.
- [x] Not-authenticated detection + clear `[seed]` log (req 7).
- [x] `scripts/dogfood-seed.json` — default fixture, one repo
      (`nicolasalt-shipit/todo-list`).
- [x] `docker-compose.yml` — background seed step in the `dev` service's
      `command:`, after the orch launch, before the `exec npx vite`.
- [x] `scripts/seed-inner-sessions.test.ts` — the four cases in plan.md, plus
      malformed/missing fixture, canonicalization, and a guard that the
      committed fixture itself parses.

## Driving the inner ShipIt (reqs 8–10)

- [x] Wake-on-dispatch — a session with no runner is activated instead of
      404'd. NO new route: `POST /api/sessions/:id/agent/dispatch` already
      exists and does the rest.
- [x] Shared with the WS path rather than reimplemented:
      `services/materialize-runner.ts` holds the archived guard, the agent
      reconciliation and the SHI-179 workspace restore; `activateSession` and
      the dispatch route both call it.
- [x] Checked the other `/agent/dispatch` callers before relaxing the 404. The
      only ones are client buttons (`client/utils/dispatch-agent-message.ts` →
      Create PR, compose errors, auto-fix), which act on a session the user has
      open and therefore never hit the no-runner branch. Fix-CI and
      child-session spawn use `runner.dispatch` directly, not this route.
- [x] Integration tests in `agent-dispatch-route.test.ts` — dispatch at a cold
      session activates and runs it; `status` flips around the turn; `history`
      carries it afterwards; an archived session still 404s.
- [x] `materialize-runner.test.ts` — guards, agent reconciliation, and the
      sync/async split that keeps WS connect's frame ordering intact.
- [x] `CLAUDE.md` — dogfooding paragraph: the seed, plus the four calls the
      outer agent uses (list / start / read history / check status).

## Done (docs)

- [x] `requirements.md` written and reviewed; every question answered
      2026-08-04, none outstanding.
- [x] Local override dropped (one developer — a personal set and the committed
      set are the same thing).
- [x] Obsolete GitHub-token half removed from `plan.md` (superseded by
      docs/184 — platform secret forwarding is gone, the secret is already
      user-supplied).
- [x] Cross-link from `docs/118-shipit-ui-local/plan.md` (corrected — it still
      credited this doc with the GitHub-token change docs/184 made).
- [x] Cross-agent review by Codex (2026-08-04); findings verified against the
      source and folded into plan.md — no new route, `claim-session` dropped,
      trust step added, warm-pool claim corrected.
