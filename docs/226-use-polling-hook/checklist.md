# usePolling hook — checklist

## This PR (design + prototype)

- [x] Enumerate the real call sites with file:line and per-site divergence
- [x] Design the API (`usePolling<T>`) resolving the planning#214 "awkward API" concern
- [x] Address stale-guard, immediate-vs-interval, pause-while-hidden, manual refresh
- [x] Per-site migration mapping + flag the non-migrating site (`usePreviewHealthPoller`)
- [x] Build the prototype `src/client/hooks/usePolling.ts`
- [x] Co-located fake-timer tests `usePolling.test.ts` (interval, disable, stale, cleanup, +)
- [x] `npm run typecheck` + ESLint clean
- [x] Linear issue created (planning#215) and linked in `plan.md` frontmatter

## Follow-up PRs (migrations — NOT in this PR)

All moot as of 2026-09-02: the prototype was removed unadopted (see plan.md Status).

- [x] Migrate `HostPanel.tsx` host-overview poll onto `usePolling` (leave the one-shot `refreshSource` as-is) (dropped — prototype removed)
- [x] Migrate `SessionDiagnosticsPanel.tsx` (use `resetOnDisable: true`) (dropped — prototype removed)
- [x] Partial-migrate `useContainerHealthPoll.ts`: mechanics → `usePolling` (variable `intervalMs`, `onSuccess` for rescue-finalize); keep the wrapper's `setHealth`/`setError` re-exports and the 1 Hz elapsed-time tick effect (dropped — prototype removed)
- [x] Decide whether `usePolling` should expose a `setData` escape hatch for the health site's `setHealth` re-export, or whether that site keeps a thin local mirror (dropped — prototype removed)
- [x] Confirm `usePreviewHealthPoller` stays bespoke (no migration) (dropped — prototype removed)
- [x] Remove the now-redundant per-site `eslint-disable` comments as each site migrates (dropped — prototype removed)
