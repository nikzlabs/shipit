# Checklist — PR-scoped changed-docs quick access

## Design
- [x] Pick the surface (PR card top chrome, not a per-turn chat card)
- [x] Pick the trigger (two-doc icon left of ⋯, no count, hidden when empty)
- [x] Pick collapse behavior (per-session localStorage, default collapsed)
- [x] Pick chip layout (Option B — compact wrapping chips)
- [x] Decide notable-file tiers (design docs + config allowlist)
- [x] Commit mockup + plan

## Server
- [ ] Add `NotableFileChange` type + `WsPrLifecycleUpdate.notableFiles`
- [ ] Compute notable list in `pr-lifecycle.ts` (open phase: from `files`; ready phase: from `diffNameStatus(base, HEAD)`)
- [ ] Filter classifier (`.md` docs + config allowlist) and attach resolved frontmatter `title`

## Client
- [ ] `notableFiles` on `PrCardState` + `updateCard` / handler passthrough
- [ ] `ChangedDocsToggle` button in `PrLifecycleCard` header (left of `PrActionsMenu`), hidden when `notableFiles.length === 0`
- [ ] `ChangedDocsStrip.tsx` — chip list, status dots, open via `openPreview`
- [ ] Per-session collapse state in localStorage (default collapsed)

## Tests
- [ ] Server: notable-file classification + `notableFiles` on the emitted update
- [ ] Client: toggle hidden when empty; chip click calls `openPreview`; collapse state persists per session
- [ ] `npm run lint:dev` + `npm run typecheck` clean
