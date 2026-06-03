# Agent containment — work items

This doc is a threat-model + audit. Items below are candidate work; triage into the
tracker as separate issues. None implemented yet.

## P0

- [ ] **Gap 2 — host-scope the git credential helper.** Make the helper at
      `github-auth.ts:225` read `host=` from stdin and emit the GitHub token only for the
      configured GitHub host(s); echo nothing otherwise. Add a test that a push to a
      non-GitHub HTTPS remote gets no credentials.
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
