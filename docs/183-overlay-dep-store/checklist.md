# Checklist — canonical dependency volume vs. copy-based nm-store

This doc is a design evaluation. Remaining work to move from proposal to implementation:

- [ ] Prototype hardlink-from-store materialize ladder (strategy B) behind a flag
- [ ] Benchmark materialize time vs. current `tar`/`cp -a` on a large repo (ShipIt itself)
- [ ] Decide store + workspace same-filesystem layout (required for hardlink/reflink)
- [ ] Verify pnpm/uv aren't silently falling back to copy today (separate-mount check)
- [ ] Investigate orchestrator-side host overlay mount feasibility (strategy A)
- [ ] Confirm `runtimeKey` covers compiled wheels (arch + libc + python version) for any Python work
- [ ] Mutation-safety test: `npm rebuild` / `patch-package` / in-place edit against a hardlinked store
