# npm v12 readiness — checklist

Readiness work (this doc) — done:

- [x] Assess all npm invocation points against the three v12 changes
- [x] Confirm agent-CLI install is already v12-compatible (`docs/141`)
- [x] Confirm exact-pin check pre-satisfies `--allow-git` / `--allow-remote`
- [x] Write the migration plan
- [x] Add a forward-pointer from the dependency policy in CLAUDE.md

Migration work — deferred until npm v12 ships (its `approve-scripts` allowlist
API must be final before these can be authored/tested):

- [ ] Enumerate root-tree script-needing packages via `npm approve-scripts --allow-scripts-pending`
- [ ] Commit the root allowlist (or switch main-app installs to `--ignore-scripts` + explicit `npm rebuild`)
- [ ] Verify `npm run build`, `npm test`, and a container build pass under v12 defaults
- [ ] Decide on session-install behavior (shipit.yaml `npm install`, global MCP installs)
- [ ] Keep `npm run check-deps` wired in CI so git/tarball specifiers stay impossible
