# Sandbox sessions — checklist

## Phase 1 — foundation
- [x] Add `kind: "sandbox"` and `capabilities` to `SessionInfo` (domain-types.ts)
      — plus `SessionCapabilities`, `DEFAULT_SANDBOX_CAPABILITIES`,
      `normalizeCapabilities` (`domain-types/session.ts`)
- [x] `capabilities` DB column + migration (database.ts, migration appended after
      the `action_checklist` one)
- [x] `fromRow` parse (kind `sandbox` + capabilities JSON via
      `normalizeCapabilities`) + `setKind` widened to `"ops" | "sandbox"` +
      `setCapabilities` setter (sessions.ts). (No `toRow` exists — rows are written
      via the per-field setters / `track` INSERT.)
- [x] Sandbox creation path: `createSandboxSession` service (`services/templates.ts`)
      + `POST /api/sessions/sandbox` route (`api-routes-session-crud.ts`) +
      `createSandboxSession` client store action. Empty workspace, NO root `git init`,
      no remoteUrl; kind+capabilities stamped server-authoritatively at creation.
- [x] Enforce the **sandbox invariant**: no root git repo (creation skips
      `git.init()`); explicitly skip session-level auto-commit/push/PR card on
      `kind === "sandbox"` in `postTurnCommit` (`ws-handlers/post-turn.ts`) — gated
      on `kind`, not `remoteUrl`. (PR card is downstream of a commit hash, so the
      early `return null` suppresses it too.)
- [x] Turn off branch-op shim for sandbox: `SHIPIT_SANDBOX=1` CLI env (threaded
      `sandbox` flag: buildAgentRunParams → Claude run-params-prep → adapter →
      ClaudeProcess spawn env) makes `block-branch-ops.mjs` self-gate off. Sandbox
      also forces `autoCreatePr=false` (no Stop-hook PR enforcement).
- [x] Sidebar group + badge keyed on `kind === "sandbox"` (`SandboxSessionGroup`,
      teal `--color-sandbox` token + badge), distinct from the `remoteUrl ?? ""`
      orphan bucket (`useSessionGrouping.ts`)
- [x] Tab gating in App.tsx — **remove** (not disable) Preview/PR tabs; orientation
      banner (`SandboxBanner`, derived chrome) in the chat panel's PR-card slot

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
- [x] `+` menu above session list (Sandbox / Ops) — `renderAdvancedSessionMenu`
      in `SessionSidebar.tsx` (desktop toolbar + collapsed rail)
- [x] Capability toggle dialog with inline docs/limitations — `SandboxDialog.tsx`
      (GitHub / Docker / Network toggles, Network on by default)
- [ ] Warm-pool entry for repo-less sessions
- [x] Tests: creation (`services/sandbox-session.test.ts`,
      `integration_tests/sandbox-sessions.test.ts`), the invariant
      (`ws-handlers/post-turn.test.ts`), branch-op self-gate
      (`agent-shim/block-branch-ops.test.ts`), sidebar grouping
      (`useSessionGrouping.test.ts`), run-params sandbox flag
      (`agent-run-params-prep.test.ts`). _Remaining (Phase 2):_ capability gating
      (broker-level), repo-aware PR brokering, prompt variant.
- [ ] Docker lock-down tests: sandbox uses session proxy not `OPS_DOCKER_HOST`;
      no journal/host mounts; child resources reaped on archive

## Resolved
- [x] Egress posture: **tighten-only**, two states. On (default) = the standard
      Tier A allowlist (parity with a normal session; no wide-open mode). Off =
      lifeline-only (LLM + orchestrator, + github.com if GitHub access granted) —
      "no internet" but not a literal air-gap (the lifeline is irreducible).

## Mockups
- [x] `mockup.html` — `+` menu, capability dialog, sandbox session view
