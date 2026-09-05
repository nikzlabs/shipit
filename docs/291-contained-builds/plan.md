---
issue: planning#512
title: Contained builds
description: How build-time egress can be contained, why the worker's namespace is the easy half, and which shape survives a root build step.
---

# 291 — Contained builds

Implements [requirements.md](requirements.md). Design only; nothing here is
built. It is the prerequisite planning#510 names for a plugin-supplied
Dockerfile, and it closes the carve-out
`docs/263-compose-service-egress/plan.md` recorded under *Scope boundary*.

**The short answer to the question this doc was opened for.** Yes — a BuildKit
worker can be placed in a prepared network namespace, exactly the way
docs/263 places a Compose service and `plugin-egress.ts` places a plugin CLI.
Two settings do it, both verifiable in upstream source, and neither is exotic.
But placing the worker there is the easy half and it is *not sufficient*: the
Tier A/B/C program was written for a workload that cannot choose its own uid,
and a `RUN` step is root. The discriminating problem is not the worker's
namespace. It is that a root build step sharing a namespace with the tier
processes can assume the uid those tiers exempt, and walk out through the
exemption. Everything below follows from that.

## What runs where today

`compose-cli.ts` runs `docker compose up -d --build` as a child of the
orchestrator, against the host daemon over the bind-mounted socket. Compose
shells out to `buildx bake` (`pkg/compose/build_bake.go`), which by default
targets the daemon's built-in builder.

The daemon's built-in builder configures its worker with
`netproviders.Opt{Mode: "host"}` (moby v28.3.0,
`builder/builder-next/controller.go:100`). `Mode: "host"` resolves to
`network.NewHostProvider()`, whose `Set` calls
`oci.WithHostNamespace(specs.NetworkNamespace)` (`util/network/host.go`) —
which *removes* the network namespace from the sandbox's OCI spec, so the step
inherits the namespace of the process that spawned it.

So a `RUN` step today does not run "on the default bridge". It runs **in
`dockerd`'s own network namespace**, which on a normal deployment is the host
network namespace. It can reach host loopback services and link-local
addresses, including `169.254.169.254`, from which many cloud hosts serve
instance credentials. That is requirement 2, and it is why the gap is worse
than the one-line note in `compose.md` implies.

Two further facts about the current daemon builder, both verified:

- It refuses any build network mode other than `host`, `none` and the default:
  `builder/builder-next/builder.go:351-357` errors with `network mode %q not
  supported by buildkit`. `--network container:<id>` exists only on the legacy
  builder, which Compose v2+ no longer drives. **The default builder cannot be
  aimed at a prepared namespace.** Any containment shape needs a builder that
  is not the daemon's own.
- Its worker network mode is daemon-wide, not per build. There is no per-build
  knob short of `none`.

## The tier stack is OUTPUT-only, and uid-keyed

Two properties of `docker/egress-sidecar/init-firewall.sh` decide which shapes
can work. Both are load-bearing and neither is stated anywhere else.

**1. Every rule is in `filter/OUTPUT` or `nat/OUTPUT`.** `FORWARD` is never
touched, so its policy stays `ACCEPT`. Locally-generated packets are policed;
*forwarded* packets are not. Any shape that puts the build in a nested
namespace behind NAT — a CNI bridge, `slirp`, a second bridge of our own —
sends its traffic through `FORWARD` and `nat/POSTROUTING`, where Tier A's ipset
match, Tier B's DNS lock and Tier C's `:443` redirect all simply do not appear.
Such a shape is not partially contained. It is uncontained.

**2. Tiers B and C are exempted by uid, and the exemption is generous.**
`init-firewall.sh:161-162`:

```
iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
```

Uid 911 may send port-53 traffic to **any** destination — it has to, it is the
resolver's upstream path — and uid 912 is excluded from the `nat/OUTPUT`
`:443` redirect. A process that runs as uid 911 in that namespace therefore has
an unrestricted bidirectional channel on port 53 to any address on the
internet.

Nothing exploits that today because no workload sharing such a namespace can
become uid 911. A session container is non-root with `CapDrop: ALL`; a
contained Compose service must declare a numeric non-reserved uid and loses
`SETUID`/`SETGID` (docs/272-services-run-as-session-uid); `session-worker-uid.ts`
refuses the reserved range outright. **A Dockerfile has no such constraint.**
`USER 911` is one line, `RUN` starts as root, and neither ShipIt nor BuildKit
has a place to forbid it — the uid is chosen inside an image ShipIt did not
build yet. Requirement 5's last clause exists for this.

The consequence is sharp: **reusing the tier program as-is for a namespace a
build step shares is not containment.** It is a firewall with a documented
password.

## Can a BuildKit worker be placed in a prepared namespace?

Yes. Two settings, both verified in upstream source at the versions below.

**The worker container's namespace.** buildx's `docker-container` driver takes
`--driver-opt network=<value>` and assigns it verbatim:
`hc.NetworkMode = container.NetworkMode(d.netMode)`
(`docker/buildx`, `driver/docker-container/driver.go:204-206`; the opt is
stored unvalidated at `factory.go:63-64`). There is no allowed-value list, so
`network=container:<holder-id>` is accepted, and the worker starts in a
namespace ShipIt prepared — the same `PluginNetns.networkMode` string
`preparePluginNetns` already returns.

**The build sandbox's namespace.** The worker's sandbox provider is chosen by
`--oci-worker-net` (`cmd/buildkitd/main_oci_worker.go:91-95`). `host` selects
the host provider, so each `RUN` step inherits buildkitd's namespace — the
holder's. No entitlement is needed for that: `ValidateEntitlements` checks the
*op's* declared mode (`solver/llbsolver/vertex.go:134`), not the worker's
resolved default, so a worker-level host mode is silent while an explicit
`RUN --network=host` in a Dockerfile still requires `network.host`, which
ShipIt would not grant.

The default must not be relied on. `auto` resolves to CNI when
`/etc/buildkit/cni.json` exists and to host otherwise
(`util/network/netproviders/network.go`), the released `moby/buildkit` image
ships the CNI binaries but that config file only in its integration-test stage,
and the CNI bridge it would build sets `"ipMasq": true`
(`util/network/cniprovider/bridge.go`) — the `FORWARD` bypass above. The mode
has to be pinned explicitly, whichever way it is pinned.

Routing Compose at that builder is one environment variable:
`toAPIBuildOptions` reads `BUILDX_BUILDER` when no `--builder` flag is given
(`docker/compose`, `cmd/compose/build.go:65-67`), and `up --build` goes through
the same function. `composeSpawnEnv`'s passthrough list would gain it.

**What it costs, before anything else is decided:**

- The builder container is **privileged**. buildx sets `Privileged: true`
  unconditionally (`driver.go:163`); it is not an opt. That is a privileged
  container on the host daemon, created by the orchestrator — not through
  `docker-proxy.ts`, which refuses exactly this for sessions. It runs a pinned
  upstream image and no repository content, so it is trusted code in the sense
  `plugin-egress.ts`'s holder is; it is still a new privileged surface.
- A resident builder plus its cache volume, per policy scope. A per-build
  builder avoids the residency and pays a cold cache every build, which is the
  opposite of what planning#510 needs.
- Compose falls back to the classic builder when the buildx plugin is missing
  (`pkg/compose/build_bake.go:64-67`), and `DOCKER_BUILDKIT=0` is already in
  `composeSpawnEnv`'s passthrough. Both routes bypass a configured builder
  silently. Requirement 6 makes them refusals, not fallbacks.

## Four shapes, and what each survives

Every shape below assumes the holder pattern from `plugin-egress.ts`: a trusted
container is started, the Tier A/B/C stack is installed into its namespace, and
only then is the workload created against `container:<holder>`. That part is
built, tested and reusable; none of the difficulty is there.

**A. Worker and build steps share the holder's namespace, tiers unchanged.**
Cheapest by far: `--driver-opt network=container:<holder>` plus
`--oci-worker-net=host`, and almost no new ShipIt code. **Rejected** — a root
`RUN` step becomes uid 911 and leaves through the DNS exemption. It satisfies
requirements 1 and 3 for a *cooperative* Dockerfile and fails requirement 5 for
a hostile one, which is the only kind this feature exists for.

**B. Shared namespace, with the tier processes moved out of it.** The
exemptions exist because the resolver and the SNI proxy live in the namespace
they police and would otherwise redirect their own traffic. Run them in a
separate namespace, reachable on the egress bridge, and Tier B/C become `DNAT`
rules to that address with no owner match to abuse. Uid-free, keeps exactly one
policy engine, and the Tier A ipset is uid-free already. Costs: the resolver
and proxy learn a non-loopback listen address (`EGRESS_PROXY_LISTEN` is already
a variable), a second rule program, and a second deployment shape for the two
sidecars. Note that a root build step then still reaches the local bridge
subnet that Tier A re-opens — the cross-session bridge exposure
`plugin-egress.ts` already records as not closed, now reachable by root.

**C. Build steps in a nested sandbox namespace, policed on the forward path.**
Pin `--oci-worker-net=bridge`, let BuildKit's CNI bridge give each step its own
namespace, and extend the tier program to cover what a nested namespace
actually traverses: `-P FORWARD DROP` with an ipset accept, and `DNAT` for
`:53` and `:443` to the holder's listeners. Uid-free by construction, because
the exec never shares a namespace with a privileged uid. Costs: a genuinely new
rule program to write and test, and the resolver/proxy listen-address change
from B.

**D. BuildKit's own proxy network.** BuildKit v0.31.0 (2026-06-17) added
`--proxy-network` — a daemon flag, or per solve request, that puts every exec
in a namespace with **no route at all** and injects `HTTP(S)_PROXY` plus a
generated CA into the step, routing its traffic through a BuildKit-owned proxy
(`docs/proxy.md` at v0.33.0). Upstream states plainly that a step which ignores
the variables or opens raw TCP is *blocked, not captured*, and that frontends
cannot set the option per operation — so a Dockerfile cannot switch it off
(requirement 5). It also captures each request into the build log and into
provenance, which is requirement 7's raw material and which no other shape
gives.

Its value here is not that it is a better firewall. It is that **it removes the
untrusted process from the policed namespace entirely**, so the uid exemptions
stop being reachable and the existing tier program needs no change: the only
thing left in the holder's namespace is buildkitd, which is ShipIt-pinned code
that will not setuid to 911, and whose own fetches (image pulls, git contexts,
`ADD <url>` — explicitly *not* covered by the proxy feature) are policed by
Tier A/B/C exactly as the agent's are.

Two things must be settled before it can be relied on, and both are experiments
rather than readings:

- *Where does the injected proxy egress?* Upstream's table says the default
  sandbox mode egresses "through a bridge/CNI-style namespace", which is the
  `FORWARD` path again — so either the holder gains `-P FORWARD DROP` plus an
  upstream proxy the build proxy must chain to, or the exec's mode is forced to
  `host` (Compose supports `build.network`, which reaches BuildKit as
  `force-network-mode`) so the proxy egresses from the holder's namespace under
  the existing tiers. The second reading is the one upstream's own example
  implies — a host-mode step's `127.0.0.1` request is shown being *proxied*,
  not executed in the host namespace — but if that reading is wrong, granting
  `network.host` puts a root step straight into the holder's namespace and we
  are back at shape A. **This is a fail-open failure mode and must be tested,
  not inferred.**
- *Chaining.* If the upstream-proxy route is taken, ShipIt's SNI proxy is
  transparent-only: it reads the SNI from a ClientHello and has no `CONNECT`
  path (`docker/egress-sidecar/sni-proxy/main.go`). Chaining needs `CONNECT`
  support added there — a contained change to a file that already owns the
  allowlist decision, not a second policy engine.

**Not a shape, but worth having anyway:** `-P FORWARD DROP` belongs in
`init-firewall.sh` regardless of which of B/C/D is chosen. It is one line, it
is a no-op for every surface that exists today (nothing in those namespaces can
create a nested namespace without `NET_ADMIN`), and it is the difference
between "the build cannot bypass the proxy" and "we assume it will not".

**E. No build network at all.** Compose's `build.network` reaches bake as
`network` (`pkg/compose/build_bake.go:102,278`) and BuildKit accepts `none`, so
a contained session can force every build step offline in about ten lines of
`compose-generator.ts`, today, with no builder, no holder and no new
containers. It satisfies requirements 1, 2, 3, 5 and 8 completely and fails
requirement 4 completely: `apt-get`, `pip` and `npm` all stop working in a
build. It is not the answer, but it is the honest floor — it is what should be
applied if a fuller shape is deferred, and it is the correct behaviour on the
fail-closed path of requirement 6 where a session must keep working but no
containment can be installed.

## Recommendation

Take **D**, with **C** as its fallback if the experiments below contradict
upstream's documentation, and ship **E** first if the gap needs closing before
either is built.

The reason to prefer D over B and C is not that its firewall is stronger. All
three can be made to satisfy the requirements. It is that D is the only one
where **the untrusted process is not in the policed namespace at all**, so the
uid-exemption class of bug cannot come back — and where the tier program, which
four surfaces already depend on, does not have to change to accommodate a
workload unlike every other workload it serves. B and C both end with two rule
programs that must agree; this repository's own history with a fourth surface
holding its own opinion about the allowlist (`plugin-egress.ts`, planning#383)
is the argument against that.

What D does **not** decide, and must not be allowed to decide by default: the
allowlist itself. BuildKit's source policy can allow, deny and rewrite proxied
requests, and it would be a second policy engine. The allowlist stays
`egress-allowlist.ts`, reached through the existing SNI proxy, so that
`egressHostReach` keeps describing what is actually enforced.

## Experiments that must precede implementation

None of this has been run. Everything above is read from upstream source and
this repository's own code; the container this was written in has no Docker.
Before any of it is built:

1. Does `--driver-opt network=container:<id>` actually start a buildkitd
   container in a prepared namespace on the pinned Engine version, and does the
   holder survive `killStaleContainers`?
2. With `--proxy-network` and a default-sandbox step: what does the step's
   namespace contain, and where does the injected proxy's own connection leave
   from? Confirm against the holder's counters, not against the build log.
3. With `--proxy-network` and a forced host-mode step: does the step reach
   `127.0.0.1` in the holder directly, or only through the proxy? A direct
   reach means shape A's uid hole, and D is then only usable in its
   default-sandbox form.
4. Does a step running `USER 911` get port-53 egress in each candidate shape?
   This is the one test that separates a contained build from a decorated one,
   and it must be written so that it fails on shape A.
5. Does an unlisted `FROM` fail, and does the failure name the host?
6. Cold and warm build time and disk for a representative plugin image, against
   the budget the last open question sets.

## Residual risk

This feature buys a network boundary and no other kind.
`docs/264-docker-sandboxes-evaluation` deferred a hardware isolation boundary
and recorded its trigger; that stays deferred, and this design does not reopen
it. But it should be re-read when planning#510 ships, because two things here
sit on the shared host kernel: the privileged builder container, and the build
step itself, which runs as **root** under the default OCI capability set and
seccomp profile (`executor/oci/spec_linux.go`) — a wider kernel surface than
any session container gets, since those are non-root with `CapDrop: ALL`. The
`security.insecure` entitlement must never be enabled on ShipIt's builder;
without it a step cannot obtain `NET_ADMIN` and cannot touch the rules
whichever shape is chosen.

Unchanged and out of scope: the plugin networks are shared across sessions and
Tier A re-opens the local bridge subnet, so containers on one bridge can
address each other by IP. `plugin-egress.ts` records that; a build step in the
holder inherits it.

## Key files

- `src/server/orchestrator/plugin-egress.ts` — the holder pattern this reuses:
  contained before the workload exists, bounded, fail-closed, `release()` on
  every path.
- `src/server/orchestrator/compose-service-egress.ts` — the other shape
  (pause, install, unpause) and the fail-closed remediation ladder.
- `docker/egress-sidecar/init-firewall.sh` — the OUTPUT-only, uid-keyed tier
  program; the `FORWARD` policy and the uid exemptions are the two facts the
  design turns on.
- `docker/egress-sidecar/sni-proxy/main.go` — transparent SNI proxy; would gain
  `CONNECT` if shape D chains through it.
- `src/server/orchestrator/compose-cli.ts` — where builds are invoked and where
  `BUILDX_BUILDER` would have to be passed through.
- `src/server/orchestrator/compose-generator.ts` — where `build.network` would
  be forced for shape E.
- `src/server/orchestrator/docker-proxy.ts` — the `POST /build` passthrough,
  the same gap through a different door.
