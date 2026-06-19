# Checklist — persistent session scratch

- [ ] Decide the mount path name (`/persist` proposed)
- [ ] Confirm the mechanism: Variant 2 (worker snapshot, bounded) recommended over Variant 1 (guidance, unbounded)
- [ ] Add `scratchDir` to `ContainerConfig` and derive it as a `sessionDir` sibling
- [ ] Add the `/persist` `:rw` mount branch in `buildMounts` (volume + bind forms)
- [ ] `mkdirSync(scratchDir, { recursive: true })` before mount
- [ ] Add `/persist` to the `docker/session-worker/entrypoint.sh` chown loop (uid 1000)
- [ ] Test: a non-root worker can write + read back `/persist/foo`
- [ ] Thread `scratchDir` through container creation (mirror `uploadsDir`)
- [ ] Variant 2: worker copies presented artifact to `/persist/<presentId>.<ext>` on submit + records it as `resolvedPath`
- [ ] Update `src/server/shipit-docs/environment.md` (filesystem table + persistence rules)
- [ ] Update `src/server/shipit-docs/present.md` (note `/tmp` throwaways now survive restart)
- [ ] Tests: `buildMounts` emits the `/persist` mount (both deployment forms)
- [ ] Verify a `/persist`-backed present artifact re-renders after a simulated container restart
</content>
