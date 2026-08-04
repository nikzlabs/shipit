# 131 — Dogfood seed sessions: checklist

Nothing is implemented yet. Requirements are settled — no open questions — so
everything below is buildable.

## Seeding (reqs 1–7)

- [ ] `scripts/seed-inner-sessions.js` — poll until the orch is healthy, skip
      fixture repos already registered and `ready`, then add → poll `ready` →
      trust for the rest. No `claim-session` — adding the
      repo warms one anyway, and a claimed session is invisible. `GET /api/repos`
      is the idempotency key, NOT the session list. Exits 0 on partial failure,
      honors `DOGFOOD_SEED`. Reads the committed fixture only.
- [ ] Confirm the health probe — `GET /api/bootstrap` is assumed to 200 once the
      orch is up; use whatever route actually does if not.
- [ ] Not-authenticated detection + clear `[seed]` log (req 7).
- [ ] `scripts/dogfood-seed.json` — default fixture, one small public repo.
- [ ] `docker-compose.yml` — background seed step in the `dev` service's
      `command:`, after the orch launch, before the `exec npx vite`.
- [ ] `scripts/seed-inner-sessions.test.ts` — the four cases in plan.md.

## Driving the inner ShipIt (reqs 8–10)

- [ ] Wake-on-dispatch in `services/agent.ts` — activate a session with no
      runner instead of returning 404. NO new route: `POST
      /api/sessions/:id/agent/dispatch` already exists and does the rest.
- [ ] Check the other `/agent/dispatch` callers (Fix-CI, child sessions, agent
      SDK) before relaxing the 404 — it may be load-bearing for their error
      handling.
- [ ] Integration tests: extend `agent-dispatch-route.test.ts` — dispatch at a
      cold session activates and runs it; `status` flips around the turn;
      `history` carries it afterwards.
- [ ] `CLAUDE.md` — dogfooding paragraph: the seed, plus the four calls the
      outer agent uses (list / start / read history / check status).

## Done

- [x] `requirements.md` written and reviewed; six questions answered
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
