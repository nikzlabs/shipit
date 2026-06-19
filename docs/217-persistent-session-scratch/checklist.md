# Checklist — persistent session scratch

- [x] Decide the mount path name — `/persist`
- [x] Decide the mechanism — agent writes directly (guidance only), no worker copy-on-submit
- [x] Decide per-session disk policy — unbounded (parity with `/workspace`)
- [ ] Add `scratchDir` to `ContainerConfig` and derive it as a `sessionDir` sibling
- [ ] Add the `/persist` `:rw` mount branch in `buildMounts` (volume + bind forms)
- [ ] `mkdirSync(scratchDir, { recursive: true })` before mount
- [ ] Add `/persist` to the `docker/session-worker/entrypoint.sh` chown loop (uid 1000)
- [ ] Test: a non-root worker can write + read back `/persist/foo`
- [ ] Thread `scratchDir` through container creation (mirror `uploadsDir`)
- [ ] Extend the `disk-janitor.ts` archived-session sweep to reclaim archived `scratch/` (+ `uploads/`)
- [ ] Decide: archived `scratch/` sweep opt-in vs default
- [ ] Update `src/server/session/mcp-tools/present.ts` — point throwaways at `/persist` (new default)
- [ ] Update `src/server/shipit-docs/present.md` (two-tier → three-tier model)
- [ ] Update `src/server/shipit-docs/environment.md` (filesystem table + persistence rules)
- [ ] Tests: `buildMounts` emits the `/persist` mount (both deployment forms)
- [ ] Verify a `/persist`-backed present artifact re-renders after a simulated container restart
