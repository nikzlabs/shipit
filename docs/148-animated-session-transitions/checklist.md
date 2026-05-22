# Checklist

- [x] Write design doc (`plan.md`)
- [ ] Add `@formkit/auto-animate@0.9.0` to `package.json` and refresh `package-lock.json`
- [ ] Confirm `npm run check-deps` passes
- [ ] Wire `useAutoAnimate` ref into `RepoGroup`'s session-list wrapper in `SessionSidebar.tsx`
- [ ] `npm run lint` clean
- [ ] `npm run typecheck` clean
- [ ] Manual smoke: PR merged → row glides to bottom of group
- [ ] Manual smoke: archive → row exits in place rather than popping out
- [ ] Manual smoke: new session created → row animates in
- [ ] Manual smoke: `prefers-reduced-motion: reduce` → instant updates
- [ ] Manual smoke: repo-header drag-and-drop reorder still works
