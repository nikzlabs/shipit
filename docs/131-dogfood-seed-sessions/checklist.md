# 131 — Dogfood seed sessions: checklist

Implemented and smoke-tested end to end on a real dogfood stack (2026-08-04),
with a real agent turn. Credential seeding (reqs 11–12) added and smoke-tested
the same way 2026-08-11. Nothing outstanding.

## Credential seeding (reqs 11–12)

- [x] Established from the code, before building, that a declared env key does
      **not** already materialise as a credential route: `listConfiguredCredentials`
      (`service-routing.ts`) reads raw env so models are *eligible*, but
      `listCredentialRoutes` (`services/credential-routes.ts`) reads the store
      only, `stringSelectionFor` reaches an env credential only as a last resort
      with no row to bench or order, and `LimitsRegistry` has no route id to
      attach a reader to. So the missing half had to be built — case B.
- [x] `scripts/seed-inner-credentials.ts` — catalogue-driven
      (`credentialStorageEnvNames` + `credentialModeForStorageEnv`), no
      per-service branch. POSTs `/api/credential-routes` so the store, the SSE
      and any open inner UI all update.
- [x] Same contract as the repo seeder: fail-open, always exits 0, skips a mode
      that already holds a string credential, `DOGFOOD_SEED=0` plus
      `DOGFOOD_SEED_CREDENTIALS=0`, `[seed]`-prefixed output.
- [x] `docker-compose.yml` — all eight catalogue credential names declared;
      both seeders share one backgrounded subshell, credentials first.
- [x] Guard test: `x-shipit-secrets` is asserted against
      `credentialStorageEnvNames()` in both directions, so a new service fails
      the build naming the missing key.
- [x] Billing hazard established from the code and surfaced rather than hidden
      — `spawnSubAgent` passes no `resolveHome`, so a local-mode non-turn spawn
      is unscoped and `scrubEnvAuthForScopedHome` is a no-op. Recorded in
      `plan.md`, warned at seed time, documented in the skill.

## Manual smoke (2026-08-11, `dev` service in production ShipIt)

- [x] **req 11** — first boot with `DEEPSEEK_API_KEY` set as an outer secret:
      `[seed] credentials: DEEPSEEK_API_KEY — added as deepseek:key`. Nothing
      was configured in the inner UI.
- [x] **req 12** — inner Settings → Services renders a full DeepSeek card:
      "DeepSeek key (dogfood secret)" with Replace/Remove and its two models,
      identical to a hand-added credential. `GET /api/credential-routes`
      returns a real `cred_…` row, `via: "string"`, `status: "ready"`.
- [x] **req 12, `sub` mode** — seeded a throwaway `ZAI_CODING_PLAN_KEY` against
      the live inner orch: `zai:sub` renders as a Subscription card with the
      failover copy. This is the shape `planning#339`'s quota reader attaches
      to. Removed afterwards.
- [x] **req 4** — restarting the dev service logged
      `deepseek:key already has a credential, leaving it alone`, and
      `/api/credential-routes` still had exactly one row.

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
- [x] **req 8, new session** — `POST /api/sessions/headless` with
      `{repoUrl, agent: "codex", initialPrompt}` on the seeded repo started a
      real turn with no human touching the inner UI.
- [x] **req 8, existing session** — the decisive test. Restarting the `dev`
      service drops every runner while the session rows survive in
      `.inner-shipit`, which is exactly the "session from an earlier boot"
      case. `POST /api/sessions/:id/agent/dispatch` at that session returned
      `{ok: true, queued: false}` and ran the turn. On the old code this is the
      404 "Session is not active" path. A genuinely unknown session id still
      404s, and an earlier run against a Claude-pinned session showed the
      dispatch reaching the *auth gate* (401) rather than 404 — the gate is
      step 3 and runner resolution is step 2, so that too proved the wake.
- [x] **req 10** — `GET /api/sessions/:id/status` reported
      `running: true` for the duration of the first turn and flipped to
      `running: false` when it ended.
- [x] **req 9** — `GET /api/sessions/:id/history` returned the whole
      conversation: the dispatched prompt, the agent's reasoning, its `shell`
      tool calls, and its final answer ("a responsive TODO web app built with
      React 19, TypeScript, and Vite…"). Both turns are there, so what the
      inner agent *said* and what it *did* are both readable.
- [x] The woken turn pushed nothing and opened no PR — the prompts were
      read-only, so the post-turn commit had nothing to commit.

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
      reconciliation and the planning#181 workspace restore; `activateSession` and
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
