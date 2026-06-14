# Checklist — PR-scoped changed-docs quick access

## Design
- [x] Pick the surface (PR card top chrome, not a per-turn chat card)
- [x] Pick the trigger (two-doc icon left of ⋯, no count, hidden when empty)
- [x] Pick collapse behavior (per-session localStorage, default collapsed)
- [x] Pick chip layout (Option B — compact wrapping chips)
- [x] Decide notable-file tiers (design docs + config allowlist)
- [x] Commit mockup + plan

## Server
- [x] Add `NotableFileChange` type + `WsPrLifecycleUpdate.notableFiles`
- [x] Compute notable list in `pr-lifecycle.ts` (ready + auto-create open phases) via `notableFilesForBranch` (`diffNameStatus` vs base, same ref fallback as `diffStatVsBranch`)
- [x] Filter classifier (`.md` docs + config allowlist) and attach resolved frontmatter `title` (`services/notable-files.ts` + `markdown.resolveDocTitle`)

## Client
- [x] `notableFiles` on `PrCardState` + `updateCard` / handler passthrough (preserved across poller `applyPrStatusUpdates` so it stays sticky)
- [x] `ChangedDocsToggle` button in `PrLifecycleCard` header (left of `PrActionsMenu`), hidden when `notableFiles.length === 0`
- [x] `ChangedDocsStrip.tsx` — chip list, status dots, open via `openPreview`
- [x] Per-session collapse state in localStorage (default collapsed)

## Tests
- [x] Server: notable-file classification + branch-diff derivation (`notable-files.test.ts`)
- [x] Client: toggle hidden when empty; chip click calls `openPreview`; collapse state persists per session
- [x] `npm run lint:dev` + `npm run typecheck` clean
