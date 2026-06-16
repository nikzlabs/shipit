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
- [x] Gate GitHub credential broker on `capabilities.git` **at the orchestrator
      endpoint** (not just container env) — defense in depth. `gitCredentialAllowed`
      (`pr-target.ts`) denies only a sandbox with `git` off; the
      `/api/sessions/:id/git/credential` route returns 403 (→ git falls back to
      anonymous). Repo-bound / ops sessions unaffected.
- [x] **Repo-aware PR brokering** (CRITICAL): `gh` shim allows `--repo` (alias
      `-R`) and forwards the `cwd` it ran in; the worker broker forwards both
      (body for POST/PATCH, query for GET); `api-routes-github.ts` resolves
      `{ gitDir, remoteUrl }` via `resolvePrTarget` (`pr-target.ts`) from the
      cwd's clone — repo-bound path UNCHANGED (session root + remote), sandbox
      reads the clone's own origin, `--repo` targets an explicit repo. No-raw-token
      property preserved (all PR ops stay server-side). `shipit-docs/github.md` updated.
- [x] Thread `docker` capability → `dockerAccess` in `buildConfigForWorkspace`
      (override param, `?? limits.dockerAccess`) threaded from
      `createContainerForRunner` (`app-lifecycle.ts`) via the session's
      `capabilities.docker`. A sandbox gets the **session-scoped** proxy (non-ops
      `dockerAccess` path), never `OPS_DOCKER_HOST`; ops-precedence guard intact.
- [x] Thread `network` capability (default on = standard allowlist; off =
      lifeline-only) → `resolveEgressConfig` returns `sandboxLifelineEgressConfig`
      for a Network-off sandbox: empties the session allowlist (extraHosts `[]`)
      and narrows the base to `EGRESS_LIFELINE_ALLOWLIST` (+ github.com via
      `EGRESS_GITHUB_LIFELINE_HOSTS` when `git` is granted), `contained: true`.
      Orchestrator/worker lifeline added separately by `orchestratorInternalNames`.
      Inert where egress enforcement isn't deployed (install gated on
      `egressEnforce && contained`). The live `reloadEgress` path reuses the same
      resolver, so an allowlist edit can't re-widen a sealed sandbox.
- [x] Sandbox system-prompt variant (agent-instructions.ts third `mode` axis +
      `prompts/sandbox-session.md`, `git-workflow{,-sandbox}.md`,
      `pull-requests-sandbox.md`; Git section tokenized to `{{GIT_WORKFLOW}}`).
      Threaded `isSandbox` in `session-agent-run-params.ts`.
- [x] Document Sandbox session in `src/server/shipit-docs/sandbox-session.md`
      (+ README + sessions.md cross-links). `shipit-docs/github.md` documents the
      `--repo`/cwd-scoping for sandbox PR brokering.

## Phase 3 — polish
- [x] `+` menu above session list (Sandbox / Ops) — `renderAdvancedSessionMenu`
      in `SessionSidebar.tsx` (desktop toolbar + collapsed rail)
- [x] Capability toggle dialog with inline docs/limitations — `SandboxDialog.tsx`
      (GitHub / Docker / Network toggles, Network on by default)
- [ ] Warm-pool entry for repo-less sessions — **deferred** (out of scope for
      SHI-161; tracked as follow-up. Sandbox creation works cold; warm-pool
      pre-warming is a latency optimization, not a correctness requirement.)
- [x] Tests: creation (`services/sandbox-session.test.ts`,
      `integration_tests/sandbox-sessions.test.ts`), the invariant
      (`ws-handlers/post-turn.test.ts`), branch-op self-gate
      (`agent-shim/block-branch-ops.test.ts`), sidebar grouping
      (`useSessionGrouping.test.ts`), run-params sandbox flag
      (`agent-run-params-prep.test.ts`), docker capability override
      (`session-container.test.ts`), egress lifeline (`egress-allowlist.test.ts`),
      sandbox prompt variant (`agent-instructions.test.ts`). Capability gating +
      repo-aware PR brokering covered by `pr-target.test.ts` (resolver + gate
      units), `agent-shim/gh.test.ts` (cwd/`--repo` forwarding),
      `agent-ops-routes.test.ts` (broker forwarding), and
      `integration_tests/agent-driven-pr.test.ts` (PR built from the resolved
      clone; repo-bound unchanged; credential 403 gate).
- [x] Docker lock-down tests: sandbox uses session proxy not `OPS_DOCKER_HOST`
      (`container-lifecycle.test.ts`), no journal/host mounts
      (`session-container.test.ts` asserts `opsSession` falsy + no `hostMounts`).
      Child-resource reaping on archive rides the existing `removeVolumes`/
      `cleanupSessionDockerResources` path (covered by its own tests).

## Resolved
- [x] Egress posture: **tighten-only**, two states. On (default) = the standard
      Tier A allowlist (parity with a normal session; no wide-open mode). Off =
      lifeline-only (LLM + orchestrator, + github.com if GitHub access granted) —
      "no internet" but not a literal air-gap (the lifeline is irreducible).

## Mockups
- [x] `mockup.html` — `+` menu, capability dialog, sandbox session view
