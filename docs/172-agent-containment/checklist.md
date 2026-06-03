# Agent containment — work items

This doc is a threat-model + audit. Items below are candidate work; triage into the
tracker as separate issues. None implemented yet.

## P0

- [ ] **Gap 2 — fix the GitHub token leak (verified live).** (a) Stop writing the inline
      `password=<token>` helper into the workspace `.git/config` (`github-auth.ts:219-227`)
      — it puts the `ghp_…` token in plaintext on disk; route the workspace through the
      brokered `shipit-git-credential` helper instead. (b) Make that broker host-aware:
      read `host=` from stdin, emit the token only for the configured GitHub host(s), echo
      nothing otherwise. Add a test that `git credential fill` for a non-GitHub host
      returns no credentials, and that no plaintext token lands in `.git/config`.
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
