# Checklist — persistent session scratch

- [ ] Decide the mount path name (`/persist` proposed)
- [ ] Add `scratchDir` to `ContainerConfig` and derive it as a `sessionDir` sibling
- [ ] Add the `/persist` `:rw` mount branch in `buildMounts` (volume + bind forms)
- [ ] `mkdirSync(scratchDir, { recursive: true })` before mount
- [ ] Thread `scratchDir` through container creation (mirror `uploadsDir`)
- [ ] Point `present` throwaways at `/persist` (default) — tool description + instructions
- [ ] Update `src/server/shipit-docs/present.md` (two-tier → three-tier model)
- [ ] Update `src/server/shipit-docs/environment.md` (filesystem table + persistence rules)
- [ ] Tests: `buildMounts` emits the `/persist` mount (both deployment forms)
- [ ] Verify a `/persist`-backed present artifact re-renders after a simulated container restart
</content>
