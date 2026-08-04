# 131 — Dogfood seed sessions: checklist

Nothing is implemented yet. Requirements are settled (no open questions), so
this is buildable.

## Seeding (reqs 1–8)

- [ ] `scripts/seed-inner-sessions.js` — poll `GET /api/bootstrap` until healthy,
      diff the fixture against existing session `remoteUrl`s, `POST`
      `claim-session` for the rest. Idempotent, exits 0 on partial failure,
      honors `DOGFOOD_SEED` / `DOGFOOD_SEED_FILE`.
- [ ] Confirm the health-probe payload — does `GET /api/bootstrap` actually
      carry the session list with `remoteUrl`s? Use whatever route does if not.
- [ ] Not-authenticated detection + clear `[seed]` log (req 8).
- [ ] `scripts/dogfood-seed.json` — default fixture, a couple of public repos.
- [ ] `.gitignore` — `scripts/dogfood-seed.local.json`.
- [ ] `docker-compose.yml` — background seed step in the `dev` service's
      `command:`, after the orch launch, before the `exec npx vite`.
- [ ] `scripts/seed-inner-sessions.test.ts` — the five cases in plan.md.

## Driving the inner ShipIt (reqs 9–11)

- [ ] `POST /api/sessions/:id/message` in `api-routes-session-crud.ts` —
      `{ text }`, runner from the registry, same path as WS `send_message`,
      `202`, 404 on unknown id.
- [ ] Integration tests: message route reaches the runner and 404s; `status`
      flips around a turn; `history` carries the turn afterwards.
- [ ] `CLAUDE.md` — dogfooding paragraph: the seed, plus the four calls the
      outer agent uses (list / start / read history / check status).

## Done

- [x] `requirements.md` written; three open questions answered 2026-08-04.
- [x] Obsolete GitHub-token half removed from `plan.md` (superseded by
      docs/184 — platform secret forwarding is gone, the secret is already
      user-supplied).
- [x] Cross-link from `docs/118-shipit-ui-local/plan.md`.
