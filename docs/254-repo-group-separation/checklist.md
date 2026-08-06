# 254 — Repo group separation — checklist

- [x] Palette: 16 entries, light values + dark overrides, scoped per the `--color-sandbox` cascade rule
- [x] `RepoInfo.colorIndex` + `color_index` column
- [x] Backfill migration for existing repos, in sidebar display order
- [x] Assignment on add: lowest free index, counting hidden repos, stable across re-add
- [x] `PATCH /api/repos/:url` accepts `colorIndex`, validated server-side
- [x] Optimistic client store action with revert on failure
- [x] Group edge as `border-left` on the group element (survives the sticky header)
- [x] Opaque `--color-bg-tertiary` header band
- [x] Ops + Sandbox groups use their own semantic colors
- [x] Suppressed when the sidebar renders a single group
- [x] Colour picker in Project Settings → Appearance
- [x] Tests: palette, store assignment, service validation, migration backfill, sidebar rendering, picker
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Verified in-browser in Claude Light and Claude Dark
- [ ] Independent fresh-context review against `requirements.md` (CLAUDE.md step 5)
