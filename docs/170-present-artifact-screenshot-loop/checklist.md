# Checklist — present artifact screenshot loop (SHI-68)

- [x] Add `GET /present-files/:presentId/*` route to `session-worker.ts`, reading from `PresentBuffer` (extracted to `registerPresentFilesRoutes` in `present-view.ts` for testability)
- [x] Serve `text/html` content as-is with correct `Content-Type` and `Cache-Control: no-store`
- [x] Serve `image/svg+xml` wrapped in a zero-margin HTML document for full-bleed rendering
- [x] Serve `text/markdown` rendered to HTML via the same `react-markdown` + `remark-gfm`/`remark-breaks` stack the client uses (no new dependency — `react-dom/server` `renderToStaticMarkup`, lazily imported)
- [x] Serve `image/png` / `image/jpeg` / `image/gif` data-URI artifacts as viewable bytes
- [x] Return a readable 404 body when the `presentId` is absent (LRU-evicted or never existed)
- [x] Co-located test covering each MIME path + the 404 case + wildcard variant (`present-view.test.ts`)
- [x] Document the screenshot-and-iterate loop in `src/server/shipit-docs/present.md` (exact URL + `replaceId` revise step)
- [x] Confirm the worker port env var / URL the agent should navigate to — resolved by returning a concrete `viewUrl` in the `present` tool result (agent never has to guess the port)
- [x] Cross-reference this doc from `docs/093-agent-present/plan.md` as the Tier 2 serving realization
- [x] `npm run lint:dev` and `npm run typecheck` clean

## Notes

- **`viewUrl` in the tool result** — beyond the bare endpoint, the worker now
  returns `viewUrl = http://127.0.0.1:${WORKER_PORT}/present-files/${presentId}`
  from `/agent-ops/present/submit`, the bridge relays it in the tool result, and
  the tool description + `present.md` instruct the agent to navigate + screenshot
  + revise via `replaceId`. This is the load-bearing behavioral change.
- **Markdown fidelity** — the worker renders markdown with the *same*
  `react-markdown` + `remark-gfm`/`remark-breaks` stack as the client
  (`message-markdown.tsx`), via `react-dom/server` `renderToStaticMarkup`. No
  new dependency. The only difference from the user's tab is the interactive
  code-block chrome (copy buttons, syntax highlighting) the client layers on —
  irrelevant to a screenshot. React/react-markdown are imported lazily so the
  worker only loads them when an artifact is actually markdown.
