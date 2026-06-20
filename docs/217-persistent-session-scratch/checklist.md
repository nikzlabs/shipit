# Checklist — persistent session scratch

Decisions (all resolved):

- [x] Mount path name — `/persist`
- [x] Mechanism — agent writes directly (guidance only), no worker copy-on-submit
- [x] Per-session disk policy — unbounded (parity with `/workspace`)
- [x] Archive retains `scratch/` (archive = hide from sidebar, not a discard)
- [x] No host-disk pressure valve — retain until full reset
- [x] `present` default location — `/persist`; remove `/tmp` from all agent-facing instructions

Implementation:

- [ ] Add `scratchDir` to `ContainerConfig` and derive it as a `sessionDir` sibling
- [ ] Add the `/persist` `:rw` mount branch in `buildMounts` (volume + bind forms)
- [ ] `mkdirSync(scratchDir, { recursive: true })` before mount
- [ ] Add `/persist` to the `docker/session-worker/entrypoint.sh` chown loop (uid 1000)
- [ ] Test: a non-root worker can write + read back `/persist/foo`
- [ ] Thread `scratchDir` through container creation (mirror `uploadsDir`)
- [ ] Verify the reclaim paths spare `scratch/` — `tier-escalation.ts` + `startup-janitor.ts` rm `workspace/` only; assert no `fs.rm(dirname(workspaceDir))`
- [ ] Update `src/server/session/mcp-tools/present.ts` — default throwaways to `/persist`, remove `/tmp` mentions
- [ ] Update `src/server/shipit-docs/present.md` — two-tier model (`/persist`, `/workspace`), no `/tmp`
- [ ] Update `src/server/shipit-docs/environment.md` — `/persist` in filesystem table + persistence rule; replace `/tmp` scratch guidance with `/persist`
- [ ] Audit system prompt + `untrusted-input.md` for residual `/tmp` guidance → `/persist`
- [ ] Tests: `buildMounts` emits the `/persist` mount (both deployment forms)
- [ ] Verify a `/persist`-backed present artifact re-renders after a simulated container restart
