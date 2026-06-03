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
      (SHI-72)
- [ ] **Gap 2-R — credential broker is caller-blind (residual after SHI-72).** Verified
      live 2026-06-03: `git credential fill` for `github.com` (or invoking
      `/usr/local/bin/shipit-git-credential get` directly) still returns the full `ghp_…`
      PAT to any code running in the session. The broker authorizes by host, not by caller,
      and the agent is indistinguishable from `git`. SHI-72 closed plaintext-at-rest and
      host-blindness but not on-demand extraction. Fix is defense-in-depth: short-lived
      repo-scoped tokens (GitHub App installation tokens, minutes-long TTL, minted
      per-turn) and/or out-of-process git (push/pull from the orchestrator host so the
      token never enters the container), with Gap 1 egress as the backstop.
- [ ] **Gap 1 — outbound egress allowlist.** Default-deny egress for session containers
      via an orchestrator-controlled proxy or `internal` network + NAT gateway; inject
      and enforce `HTTP_PROXY`/`HTTPS_PROXY`; allow only known hosts (agent APIs, git
      host, package registries).
- [ ] **Gap 1 — identity-validating proxy** for allowlisted multi-tenant hosts so an
      approved API can't be used to upload into an attacker's account.

## P1

- [ ] **Gap 3 — per-repo trust gate.** Defer `agent.install` and compose
      `command:`/`build:` on first open of an untrusted remote until the user accepts;
      cache the decision per remote; auto-trust ShipIt-created template repos.

## P2

- [ ] **Gap 6 — read-only mounts.** Downgrade `/uploads` (and `/credentials` after
      first-turn provisioning) to `:ro` where the agent has no legitimate write need.
- [ ] **Gap 5 — kernel-tier hardening.** Evaluate gVisor (`runsc`) runtime, a custom
      seccomp profile, and `ReadonlyRootfs: true` with explicit writable mounts.

## Cross-cutting

- [ ] **Gap 4 — untrusted-input lens.** Treat uploaded files, cloned-repo content, web
      fetches, and MCP tool returns as untrusted; fold into the egress/trust work and
      apply to future input surfaces.
