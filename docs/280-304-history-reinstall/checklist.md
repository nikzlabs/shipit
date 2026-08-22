# Checklist

- [x] Establish Q1 (truncation window?) from the code — answered: no; ordering guaranteed by construction
- [x] Establish Q2 (seed vs replay) from the code — answered: seed is authoritative over attach-time buffer replay; needs only card fields; must always run
- [x] Write requirements.md / plan.md with verified-at citations
- [x] Extract `seedCardStoresFromHistory` — seeds structurally independent of transcript install, docstring carries the finding
- [x] Comment the `304` branch with why the install always runs
- [x] Guard tests: 304 re-seeds over a replay draft; 304 installs into a cleared store; flag raised only after install
- [x] `npm run typecheck` + `npm run lint:dev` pass
- [x] `npm run test:dev` + new tests pass
- [x] Behaviour verified in the running app (dogfood inner instance): first
      `/history` load 200 with `ETag "Eb_jSDk459tkOL-OzsC8vJjPI0E"`; SPA
      switch-away-and-back sent `If-None-Match` and got `304`; after the 304 the
      transcript rendered whole and the bug card rendered `filed` (#4242), not a draft
- [ ] PR open with `Refs planning#467`
