# Sandbox sessions — checklist

## Phase 1 — foundation
- [ ] Add `kind: "sandbox"` and `capabilities` to `SessionInfo` (domain-types.ts)
- [ ] `capabilities` DB column + migration (database.ts)
- [ ] `fromRow`/`toRow` + `setCapabilities` (sessions.ts)
- [ ] Sandbox creation path (service + route/WS message), empty workspace
- [ ] Enforce the **sandbox invariant**: no root git repo; explicitly skip
      session-level auto-commit/push/PR card on `kind === "sandbox"`
      (post-turn.ts) — gate on `kind`, not `remoteUrl`
- [ ] Turn off branch-op shim for sandbox
- [ ] Sidebar group + badge keyed on `kind === "sandbox"` (distinct from the
      `remoteUrl ?? ""` standalone bucket)
- [ ] Tab gating in App.tsx — **remove** (not disable) Preview/PR tabs

## Phase 2 — capabilities wiring
- [ ] Gate GitHub credential broker on `capabilities.git` **at the orchestrator
      endpoint** (not just container env) — defense in depth
- [ ] **Repo-aware PR brokering** (CRITICAL): `gh` shim resolves target repo from
      the cwd's clone + allow `--repo`; `/agent-ops/pr/*` + `api-routes-github.ts`
      build GitManager/remote from the resolved clone, not `session.remoteUrl`;
      keep the no-raw-token property
- [ ] Thread `docker` capability → `dockerAccess` in `buildContainerConfig`
- [ ] Thread `network` capability (default on = standard allowlist; off =
      lifeline-only) → `egressEnforce` + `EgressAllowlistStore` per-session scope;
      GitHub access adds github.com to the lifeline when network is off; hide the
      toggle where egress enforcement isn't deployed (no silent no-op)
- [ ] Sandbox system-prompt variant (agent-instructions.ts + prompts/)
- [ ] Document Sandbox session in `src/server/shipit-docs/`

## Phase 3 — polish
- [ ] `+` menu above session list (Sandbox / Ops)
- [ ] Capability toggle dialog with inline docs/limitations
- [ ] Warm-pool entry for repo-less sessions
- [ ] Tests: creation, capability gating (broker-level), repo-aware PR brokering,
      sidebar grouping, prompt variant
- [ ] Docker lock-down tests: sandbox uses session proxy not `OPS_DOCKER_HOST`;
      no journal/host mounts; child resources reaped on archive

## Resolved
- [x] Egress posture: **tighten-only**, two states. On (default) = the standard
      Tier A allowlist (parity with a normal session; no wide-open mode). Off =
      lifeline-only (LLM + orchestrator, + github.com if GitHub access granted) —
      "no internet" but not a literal air-gap (the lifeline is irreducible).

## Mockups
- [x] `mockup.html` — `+` menu, capability dialog, sandbox session view
