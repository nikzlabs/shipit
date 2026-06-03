# Checklist — present artifact screenshot loop (SHI-68)

- [ ] Add `GET /present-files/:presentId/*` route to `session-worker.ts`, reading from `PresentBuffer`
- [ ] Serve `text/html` content as-is with correct `Content-Type` and `Cache-Control: no-store`
- [ ] Serve `image/svg+xml` wrapped in a zero-margin HTML document for full-bleed rendering
- [ ] Serve `text/markdown` rendered to HTML (match the client renderer)
- [ ] Serve `image/png` / `image/jpeg` / `image/gif` data-URI artifacts as viewable bytes
- [ ] Return a readable 404 body when the `presentId` is absent (LRU-evicted or never existed)
- [ ] Co-located worker test covering each MIME path + the 404 case
- [ ] Document the screenshot-and-iterate loop in `src/server/shipit-docs/present.md` (exact URL + `replaceId` revise step)
- [ ] Confirm the worker port env var / URL the agent should navigate to
- [ ] Cross-reference this doc from `docs/093-agent-present/plan.md` as the Tier 2 serving realization
- [ ] `npm run lint:dev` and `npm run typecheck` clean
