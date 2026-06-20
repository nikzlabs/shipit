# Checklist — persistent session scratch

Decisions (all resolved):

- [x] Mount path name — `/persist`
- [x] Mechanism — agent writes directly (guidance only), no worker copy-on-submit
- [x] Per-session disk policy — unbounded (parity with `/workspace`)
- [x] Archive retains `scratch/` (archive = hide from sidebar, not a discard)
- [x] No host-disk pressure valve — retain until full reset
- [x] `present` default location — `/persist`; remove `/tmp` from all agent-facing instructions

Implementation (done in this PR):

- [x] Add `scratchDir` to `ContainerConfig` (`session-container.ts`) and derive it as a `sessionDir` sibling (`buildContainerConfig`)
- [x] Add the `/persist` `:rw` mount branch in `buildMounts` (volume + bind forms)
- [x] `mkdirSync(scratchDir, { recursive: true })` before mount (`createContainer`)
- [x] Add `/persist` to the `docker/session-worker/entrypoint.sh` chown loop (uid 1000)
- [x] Thread `scratchDir` through container creation (single path: `buildContainerConfig`)
- [x] Update `src/server/session/mcp-tools/present.ts` — default throwaways to `/persist`, remove `/tmp` mentions
- [x] Update `src/server/shipit-docs/present.md` — two-tier model (`/persist`, `/workspace`), no `/tmp`
- [x] Update `src/server/shipit-docs/environment.md` — `/persist` in filesystem table + persistence rule; `/tmp` scratch guidance → `/persist`
- [x] Audit system prompt (`prompts/skeleton.md`) + shipit-docs for residual `/tmp` guidance → `/persist` (only the Playwright screenshot path, a hard MCP-allowlist constraint, remains)
- [x] Unit tests: `buildMounts` emits the `/persist` mount (both deployment forms) + `buildContainerConfig` default derivation — 53 pass; typecheck + lint:dev clean

Deferred to CI / manual (container-level, OOM in-session):

- [ ] Integration/manual: a non-root worker can write + read back `/persist/foo`
- [ ] Integration/manual: a `/persist`-backed present artifact re-renders after a real container restart
- [ ] Regression test that eviction (`tier-escalation.ts`) rm's `workspace/` only and leaves `scratch/` intact (verified by inspection: eviction `fs.rm`s `session.workspaceDir`, a sibling of `scratch/`)
