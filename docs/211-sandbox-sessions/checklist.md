# Sandbox sessions — checklist

## Phase 1 — foundation
- [ ] Add `kind: "sandbox"` and `capabilities` to `SessionInfo` (domain-types.ts)
- [ ] `capabilities` DB column + migration (database.ts)
- [ ] `fromRow`/`toRow` + `setCapabilities` (sessions.ts)
- [ ] Sandbox creation path (service + route/WS message), empty workspace
- [ ] Turn off PR lifecycle / auto-push / auto-commit / branch-op shim for sandbox
- [ ] Sidebar group + badge for sandbox sessions
- [ ] Tab gating in App.tsx (no Preview/PR tabs)

## Phase 2 — capabilities wiring
- [ ] Gate git credential broker on the `git` capability
- [ ] Thread `docker` capability → `dockerAccess` in `buildContainerConfig`
- [ ] Sandbox system-prompt variant (agent-instructions.ts + prompts/)
- [ ] Document Sandbox session in `src/server/shipit-docs/`

## Phase 3 — polish
- [ ] `+` menu above session list (Sandbox / Ops)
- [ ] Capability toggle dialog with inline docs/limitations
- [ ] Warm-pool entry for repo-less sessions
- [ ] Tests: creation, capability gating, sidebar grouping, prompt variant

## Mockups
- [x] `mockup.html` — `+` menu, capability dialog, sandbox session view
