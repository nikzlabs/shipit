# usePolling hook — checklist

## This PR (design + prototype)

- [x] Enumerate the real call sites with file:line and per-site divergence
- [x] Design the API (`usePolling<T>`) resolving the SHI-212 "awkward API" concern
- [x] Address stale-guard, immediate-vs-interval, pause-while-hidden, manual refresh
- [x] Per-site migration mapping + flag the non-migrating site (`usePreviewHealthPoller`)
- [x] Build the prototype `src/client/hooks/usePolling.ts`
- [x] Co-located fake-timer tests `usePolling.test.ts` (interval, disable, stale, cleanup, +)
- [x] `npm run typecheck` + ESLint clean
- [x] Linear issue created (SHI-213) and linked in `plan.md` frontmatter

## Follow-up PRs (migrations — NOT in this PR)

- [ ] Migrate `HostPanel.tsx` host-overview poll onto `usePolling` (leave the one-shot `refreshSource` as-is)
- [ ] Migrate `SessionDiagnosticsPanel.tsx` (use `resetOnDisable: true`)
- [ ] Partial-migrate `useContainerHealthPoll.ts`: mechanics → `usePolling` (variable `intervalMs`, `onSuccess` for rescue-finalize); keep the wrapper's `setHealth`/`setError` re-exports and the 1 Hz elapsed-time tick effect
- [ ] Decide whether `usePolling` should expose a `setData` escape hatch for the health site's `setHealth` re-export, or whether that site keeps a thin local mirror
- [ ] Confirm `usePreviewHealthPoller` stays bespoke (no migration)
- [ ] Remove the now-redundant per-site `eslint-disable` comments as each site migrates
