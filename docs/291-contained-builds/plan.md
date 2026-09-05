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

Nothing here has been run. Every claim is read from source at a pinned version
— see *Sources checked* at the end — and the experiments that must precede
implementation are listed before the residual risk.

## What runs where today

`compose-cli.ts` runs `docker compose up -d --build` as a child of the
orchestrator, against the host daemon over the bind-mounted socket. Compose
shells out to `buildx bake` (`pkg/compose/build_bake.go`), which by default
targets the daemon's built-in builder.

**An ordinary `RUN` step gets its own namespace with an endpoint on the
daemon's `bridge` network** — docker0. moby replaces BuildKit's network
providers wholesale: `newExecutor` maps `pb.NetMode_UNSET` to a
`bridgeProvider` bound to the network literally named `bridge`
(`builder/builder-next/executor_linux.go:23-31`), and the controller assigns
that executor over the worker's own (`controller.go:168`). So the step has
full, unfiltered internet egress: no Tier A ipset, no Tier B resolver, no
Tier C SNI proxy, and no allowlist of any kind. That is the gap.

*A trap for the next reader.* `controller.go:100` sets
`netproviders.Opt{Mode: "host"}`, which reads like the sandbox inheriting
dockerd's namespace. It does not: those providers are the worker's, and the
executor assignment fourteen lines above overrides them. An earlier draft of
this doc asserted host networking on the strength of that line and was wrong.
The daemon builder is not upstream BuildKit's default, and reading upstream
BuildKit does not tell you what the daemon does.

**Host networking is nonetheless available on request, and the daemon grants
the entitlement itself.** `getEntitlements` enables `network.host` whenever a
deployment has not explicitly configured otherwise — *"In case of no config
settings, NetworkHost should be enabled"* (`controller.go:538-541`). Compose's
`build.network` reaches BuildKit as `force-network-mode`
(`pkg/compose/build_bake.go:102,278`), and `compose-generator.ts` does not
validate `build:` at all beyond its secret references. So a repository or
plugin compose file may declare `build: { network: host }`, or a Dockerfile may
say `RUN --network=host`, and the step then runs in dockerd's own namespace —
the host's, with its loopback services and its network position. Requirement 2
is about that door, and it is open today with no ShipIt check in front of it.

Two further facts about the built-in builder:

- It refuses any build network mode other than `host`, `none` and the default
  (`builder-next/builder.go:351-357`). `--network container:<id>` exists only
  on the legacy builder, which Compose v2+ no longer drives. **The default
  builder cannot be aimed at a prepared namespace.** Any containment shape
  needs a builder that is not the daemon's own.
- Its worker network mode is daemon-wide. There is no per-build knob short of
  `none`.

A third entry point exists: `docker-proxy.ts:479` passes `POST /build` through
unrestricted, so a session with Docker access reaches the same daemon builder
directly. Whether this feature covers that path is an open question.

## The tier stack is OUTPUT-only, and uid-keyed

Two properties of `docker/egress-sidecar/init-firewall.sh` decide which shapes
can work. Both are load-bearing and neither is stated anywhere else.

**1. Every rule is in `filter/OUTPUT` or `nat/OUTPUT`.** `FORWARD` is never
touched, so its policy stays `ACCEPT`. Locally-generated packets are policed;
*forwarded* packets are not. A shape that puts the build behind a kernel bridge
inside the policed namespace — a CNI bridge, a second bridge of our own — sends
its traffic through `FORWARD` and `nat/POSTROUTING`, where Tier A's ipset
match, Tier B's DNS lock and Tier C's `:443` redirect do not appear at all.
Such a shape is not partially contained; it is uncontained. (This does *not*
extend to a userspace network stack such as slirp, which re-originates each
connection as an ordinary socket in its own process's namespace, where `OUTPUT`
applies normally. The distinction matters for shape F.)

**2. Tiers B and C are exempted by uid, and the exemption is generous.**
`init-firewall.sh:161-162`:

```
iptables -A OUTPUT -p udp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -m owner --uid-owner "$DNS_UID" -j ACCEPT
```

Uid 911 may send port-53 traffic to **any** destination — it has to, it is the
resolver's upstream path — and uid 912 is excluded from the `nat/OUTPUT`
`:443` redirect. A process running as uid 911 in that namespace therefore has
an unrestricted bidirectional channel on port 53 to any address on the
internet.

Nothing exploits that today because no workload sharing such a namespace can
become uid 911. A session container is non-root with `CapDrop: ALL`; a
contained Compose service must declare a numeric non-reserved uid and loses
`SETUID`/`SETGID` (docs/272-services-run-as-session-uid);
`session-worker-uid.ts` refuses the reserved range outright. **A Dockerfile has
no such constraint.** `USER 911` is one line, `RUN` starts as root, and neither
ShipIt nor BuildKit has a place to forbid it — the uid is chosen inside an
image ShipIt has not built yet. Requirement 5's last clause exists for this.

The consequence is sharp: **reusing the tier program as-is for a namespace a
build step shares is not containment.** It is a firewall with a documented
password. Unless the build step's uid is *mapped* (shape F), the step must not
be in that namespace at all.

## Can a BuildKit worker be placed in a prepared namespace?

Yes. Two settings, both verified in upstream source.

**The worker container's namespace.** buildx's `docker-container` driver takes
`--driver-opt network=<value>` and assigns it verbatim:
`hc.NetworkMode = container.NetworkMode(d.netMode)`
(`driver/docker-container/driver.go`; the opt is stored unvalidated in
`factory.go`). There is no allowed-value list, so
`network=container:<holder-id>` is accepted and the worker starts in a
namespace ShipIt prepared — the same `PluginNetns.networkMode` string
`preparePluginNetns` already returns.

**The build sandbox's namespace.** A standalone worker's sandbox provider is
chosen by `--oci-worker-net` (`cmd/buildkitd/main_oci_worker.go`). `host`
selects the host provider, whose `Set` calls
`oci.WithHostNamespace(specs.NetworkNamespace)` (`util/network/host.go`) —
removing the namespace from the sandbox's OCI spec so the step inherits
buildkitd's, i.e. the holder's. No entitlement is needed for that:
`ValidateEntitlements` checks the *op's* declared mode
(`solver/llbsolver/vertex.go:134`), not the worker's resolved default, so a
worker-level host mode is silent while an explicit `RUN --network=host` still
requires `network.host`, which ShipIt would not grant.

The default must not be relied on. `auto` resolves to CNI when
`/etc/buildkit/cni.json` exists and to host otherwise
(`util/network/netproviders/network.go`); the released `moby/buildkit` image
ships the CNI binaries but that config file only in its integration-test stage;
and the CNI bridge it would build sets `"ipMasq": true`
(`util/network/cniprovider/bridge.go`) — the `FORWARD` bypass above. The mode
has to be pinned explicitly, whichever way it is pinned.

Routing Compose at that builder is one environment variable:
`toAPIBuildOptions` reads `BUILDX_BUILDER` when no `--builder` flag is given
(`cmd/compose/build.go:65-67`), and `up --build` goes through the same
function. `composeSpawnEnv`'s passthrough list, which omits it today, would
gain it.

**What it costs, before anything else is decided:**

- The builder container is **privileged**. buildx sets `Privileged: true`
  unconditionally (`driver.go`); it is not an opt. That is a privileged
  container on the host daemon, created by the orchestrator — not through
  `docker-proxy.ts`, which refuses exactly this for sessions. It runs a pinned
  upstream image and no repository content, so it is trusted in the sense
  `plugin-egress.ts`'s holder is; it is still a new privileged surface.
- A builder per policy scope, plus its cache. Residency is a separate question
  from cache retention: `buildx rm --keep-state` retains a builder's state
  volume for a replacement of the same name, so an on-demand builder that
  reuses retained state is a real option and should be measured before a
  resident one is assumed.
- Compose falls back to the classic builder when the buildx plugin is missing
  (`pkg/compose/build_bake.go`), and `DOCKER_BUILDKIT=0` is already in
  `composeSpawnEnv`'s passthrough. Both bypass a configured builder silently.
  Requirement 6 makes them refusals, not fallbacks.

## Six shapes, and what each survives

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
separate namespace, reachable on the egress bridge, and Tiers B and C become
`DNAT` rules to that address with no owner match to abuse; Tier A's ipset is
uid-free already. Costs: the resolver and proxy learn a non-loopback listen
address (`EGRESS_PROXY_LISTEN` is already a variable), a second rule program,
and a second deployment shape for the two sidecars. A root build step then
still reaches the local bridge subnet Tier A re-opens — the cross-session
bridge exposure `plugin-egress.ts` already records as not closed, now reachable
by root.

**C. Build steps in a nested sandbox namespace, policed on the forward path.**
Pin `--oci-worker-net=bridge`, let BuildKit's CNI bridge give each step its own
namespace, and extend the tier program to cover what a nested namespace
traverses: forward-chain default-deny with an ipset accept, and `DNAT` for
`:53` and `:443` to the holder's listeners. Uid-free by construction. Costs: a
genuinely new rule program, the listen-address change from B, and — this is the
part that is easy to underestimate — the rules must survive **CNI's own
setup**. The bridge conflist includes the CNI `firewall` plugin, which inserts
its own forward-chain jump and accepts traffic sourced from the sandbox's
address, ahead of any chain policy. Ordering is the design, not the policy line.

**D. BuildKit's own proxy network.** BuildKit v0.31.0 (2026-06-17) added
`--proxy-network`: a daemon flag, or a per-solve option, that puts every exec
in a namespace with **no route at all** and injects `HTTP(S)_PROXY` plus a
generated CA into the step, routing its traffic through a BuildKit-owned proxy
(`docs/proxy.md`). Upstream states plainly that a step which ignores the
variables or opens raw TCP is *blocked, not captured*, and that frontends
cannot set the option per operation — so a Dockerfile cannot switch it off
(requirement 5). It also records each request in the build log and in
provenance, which is raw material for requirement 7.

Its value here is not a better firewall. It is that the untrusted process is
not in the policed namespace, so the uid exemptions are unreachable and the
existing tier program needs no change: what is left in the holder's namespace
is buildkitd, ShipIt-pinned code that will not setuid to 911, whose own fetches
(image pulls, git contexts, `ADD <url>` — explicitly *outside* the proxy
feature) are policed by Tier A/B/C exactly as the agent's are.

Combined with `--oci-worker-net=host` it also needs no second mechanism:
`netproviders.Providers` gives the proxy's egress for default-mode execs the
worker's own `defaultProvider` (`util/network/netproviders/network.go`), which
under `host` is the holder's namespace. So the proxy's outbound connections are
ordinary socket calls in the holder — Tier A's ipset, Tier B's redirect into
the in-namespace resolver and Tier C's `:443` redirect all apply to them, since
the proxy runs as root inside buildkitd and matches none of the uid exemptions.
No `CONNECT` support in ShipIt's SNI proxy, no forced host-mode execs, no
`network.host` entitlement, no forward-path program. **This reading comes from
the implementation and contradicts upstream's own documentation table**, which
describes the default-sandbox egress as a bridge/CNI namespace — true for the
`auto`/`cni` worker mode it assumes. That contradiction is exactly why it is
experiment 2 below and not an assumption.

**E. No build network at all.** Compose's `build.network` reaches bake as
`network` and BuildKit accepts `none`, so a contained session can force build
steps offline in about ten lines of `compose-generator.ts`, today, with no
builder, no holder and no new containers. It is *not* a full-strength control:
`force-network-mode` is an attribute the standard Dockerfile frontend honours,
and a Dockerfile can select a different frontend with `# syntax=`, so E needs a
narrower supported-input contract (reject external frontends) before it can be
claimed to satisfy requirement 5. It fails requirement 4 outright: `apt-get`,
`pip` and `npm` all stop working in a build. It is a product decision — offline
builds, with dependencies baked or installed at run time — not a fallback, and
**not** the fail-closed path: requirement 6 says refuse, and a silently
different build is not a refusal.

**F. Rootless or user-mapped BuildKit.** The uid finding assumes the step's
uid 911 *is* uid 911 to the kernel that evaluates the owner match. Under a user
namespace mapping it is not, and shape A's hole closes without moving anything.
This is the only shape that keeps the existing tier program *and* preserves
non-HTTP protocols, which is D's main cost. It brings rootless BuildKit's own
documented networking and storage constraints, and its network path needs the
same scrutiny as every other shape here — with the note from above that a
userspace stack re-originates connections in its own namespace, where `OUTPUT`
applies. A candidate to test, not a proven replacement.

## Recommendation

Test **D with `--proxy-network --oci-worker-net=host`** first: on the reading
above it is the only shape that needs no new rule program and no change to the
tier stack, and it is cheap to falsify. Test **F** alongside it, because it is
the only shape that keeps raw protocols working and it reuses everything.
Fall back to **C** only if both fail, since it is the one that ends with two
rule programs that must agree — and this repository's history with a fourth
surface holding its own opinion about the allowlist (`plugin-egress.ts`,
planning#383) is the argument against that.

What none of them may decide by default: the allowlist itself. BuildKit's
source policy can allow, deny and rewrite proxied requests, and adopting it
would be a second policy engine. The allowlist stays `egress-allowlist.ts`,
reached through the existing SNI proxy, so `egressHostReach` keeps describing
what is actually enforced.

## What this design does not yet answer

Named rather than hidden; none needs a new subsystem, each needs a decision and
a test.

- **Requirement 7 has no path yet.** A captured proxy request is evidence, not
  a policy denial, and the authoritative denials happen in the resolver and the
  SNI proxy. Nothing yet connects a denial to the owning build, the owning
  session, the message the user reads, and the Settings → Network grant. Note
  that `plugin-egress.ts` deliberately supplies *no* decision URL, so reusing
  the holder does not inherit that UX.
- **Policy refresh on a builder that outlives a turn.** `plugin-egress.ts`
  snapshots policy because its containers are short-lived and says so. A
  builder that survives across grants, removals and allow-once expiry has no
  such excuse, and needs a stated contract: which change forces a rebuild of
  the holder, and which does not.
- **Restart.** What prevents a restarted builder, or a recreated holder, from
  accepting work before containment is back? Requirement 3 is met at first
  start by construction and is unaddressed after one.
- **Fetches made by the build client, not the builder.** BuildKit can delegate
  registry token acquisition to the client session, and buildx registers that
  provider — so an HTTP request to a token realm advertised by a registry is
  made by the *orchestrator's* process, outside any holder. Builder-only
  placement does not cover it. It must be covered or explicitly excluded before
  the "base image pulls are build egress" open question can be answered.
- **Concurrency and cache scope.** Two builds under different policies at once;
  and whether a build cache may be shared between trust scopes at all, since a
  cache entry is an input one build produced and another consumes.
- **Captured material.** D records request URLs and response bodies into build
  output and provenance. Retention, and what a URL with a credential in it does
  there, need a decision before it is switched on.
- **Requirement 8's branching.** Requirements 1–7 are written unconditionally;
  Open sessions and enforcement-disabled deployments must be an explicit
  branch, not an implied one.

## Experiments that must precede implementation

None of this has been run; the container it was written in has no Docker.

1. Does `--driver-opt network=container:<id>` start a buildkitd container in a
   prepared namespace on the pinned Engine version, and does the holder survive
   `killStaleContainers`?
2. With `--proxy-network --oci-worker-net=host` and a default-mode step: what
   does the step's namespace contain, and where does the injected proxy's own
   connection leave from? Confirm against the holder's own counters, not
   against the build log, since the log is written by the thing under test.
3. Does a step running `USER 911` get port-53 egress, in each candidate shape?
   This is the one test that separates a contained build from a decorated one,
   and it must be written so that it fails on shape A.
4. Under F, does the owner match still fire for an in-sandbox uid 911, and
   where do the step's connections originate?
5. Does an unlisted `FROM` fail, and does the failure name the host? Repeat for
   a registry that redirects token acquisition to another host (the client-side
   fetch above).
6. Is the metadata address reachable from a build step, over IPv4 and IPv6,
   before and after? The "before" answer is host-configuration dependent and
   must be measured rather than assumed.
7. Cold and warm build time and disk for a representative plugin image, for a
   resident builder and for an on-demand builder with `--keep-state`.

## Residual risk

This feature buys a network boundary and no other kind.
`docs/264-docker-sandboxes-evaluation` deferred a hardware isolation boundary
and recorded its trigger; that stays deferred, and this design does not reopen
it. It should be re-read when planning#510 ships, because two things here sit
on the shared host kernel: the privileged builder container, and the build step
itself, which runs as **root** under the default OCI capability set and seccomp
profile (`executor/oci/spec_linux.go`) — a wider kernel surface than any
session container gets, since those are non-root with `CapDrop: ALL`. The step
already runs that way today; what this design adds to the kernel surface is the
privileged builder. The `security.insecure` entitlement must never be enabled
on ShipIt's builder; without it a step cannot obtain `NET_ADMIN` and cannot
touch the rules in any shape.

Unchanged and out of scope: the plugin networks are shared across sessions and
Tier A re-opens the local bridge subnet, so containers on one bridge can
address each other by IP. `plugin-egress.ts` records that; a holder inherits it.

## Sources checked

Upstream claims were read at moby **v28.3.0**, BuildKit **v0.33.0** (with the
`--proxy-network` introduction at **v0.31.0**), buildx **master** and Compose
**main**. ShipIt's own Dockerfile installs Compose without an exact pin, so the
Compose paths above — the `BUILDX_BUILDER` read and the classic-builder
fallback — must be re-checked against the version a deployment actually ships
before either is depended on.

## Key files

- `src/server/orchestrator/plugin-egress.ts` — the holder pattern this reuses:
  contained before the workload exists, bounded, fail-closed, `release()` on
  every path. Also the precedent for snapshot-versus-live policy, and for
  omitting a decision URL.
- `src/server/orchestrator/compose-service-egress.ts` — the other shape
  (pause, install, unpause) and the fail-closed remediation ladder.
- `docker/egress-sidecar/init-firewall.sh` — the OUTPUT-only, uid-keyed tier
  program; the forward-chain policy and the uid exemptions are the two facts
  the design turns on.
- `docker/egress-sidecar/sni-proxy/main.go` — transparent SNI proxy, no
  `CONNECT` path; relevant only if a shape chains through it.
- `src/server/orchestrator/compose-cli.ts` — where builds are invoked, and the
  passthrough environment `BUILDX_BUILDER` would join.
- `src/server/orchestrator/compose-generator.ts` — no `build:` validation
  today; where `build.network` and a `# syntax=` restriction would go.
- `src/server/orchestrator/docker-proxy.ts` — the `POST /build` passthrough,
  the same gap through a different door.
