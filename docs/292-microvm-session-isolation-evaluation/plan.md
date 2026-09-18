---
issue: planning#514
title: Per-session microVM isolation evaluation
description: Whether ShipIt should run sessions in Firecracker / Cloud Hypervisor microVMs instead of containers on the shared host kernel, and what a kernel boundary should look like if it is wanted.
---

# 292 — Per-session microVM isolation evaluation

Follow-up to `docs/264-docker-sandboxes-evaluation`, which deferred a direct
Firecracker / Cloud Hypervisor comparison to "when a hardware boundary proves
necessary". Evaluated 2026-09-06. All product facts below were fetched on that
date (sources at the end); every code claim was read at the cited line.

## Recommendation

**Do not run sessions in per-session microVMs, and do not build a Firecracker
or Cloud Hypervisor integration.** The honest answer is the same as 264's, on
fresh evidence, for reasons that are properties of ShipIt rather than of any
one VMM:

1. **It cannot be the default.** The local install supports macOS, Linux and
   WSL2 (`deployment/local/setup.sh:396-399`); on macOS Docker Desktop a Linux
   container gets no `/dev/kvm` on any chip today (Apple exposes nested
   virtualization only on M3+/macOS 15, and Docker has not enabled it —
   docker/desktop-feedback#314 still open). The VPS install targets any Linux
   host with Docker, and a common one, Hetzner Cloud, answers "not possible on
   cloud server" in its FAQ; AWS added it to virtualized Intel instances only
   in 2026-02, opt-in. A boundary that supported hosts cannot provide is an
   operator opt-in, exactly like `SESSION_RUNTIME=runsc` is today — never the
   thing ShipIt's isolation story rests on.
2. **Firecracker has no shared filesystem, by design.** virtio-fs was rejected
   upstream in 2020 on attack-surface grounds and is "not on our roadmap"; the
   generic vhost-user device that would let an external `virtiofsd` attach is
   an open PR with "no guarantee any work on this will be merged". Every
   session mount — `/workspace`, `/persist`, `/credentials`, the overlay
   dep-dir volumes (`container-lifecycle.ts:365-588`) — would have to become a
   block image, which breaks `clone --local` hardlink sharing with the bare
   cache (`warm-pool-manager.ts:294`) and the daemon-mounted overlay dep store
   (`overlay-volume.ts:432-441`). Cloud Hypervisor does have virtio-fs, so it
   is the only candidate of the two, and it ships no jailer: namespaces and
   cgroups are "the caller's job".
3. **The orchestrator would become a hypervisor host.** It is a container with
   `/var/run/docker.sock` and nothing else — no devices, no `cap_add`
   (`deployment/vps/docker-compose.yml:31-35`). Running a VMM there means
   `/dev/kvm` plus tap creation (`CAP_NET_ADMIN`) plus, for Firecracker, a
   jailer that "runs as the root user", all on the process whose blast radius
   ShipIt is trying to shrink.
4. **Every non-agent path keys on the Docker bridge or daemon.** The
   agent-control path already takes a URL and nothing else
   (`container-session-runner.ts:367-400`, `worker-http.ts`), but identity by
   source IP (`api-container-guard.ts:291-293`, `docker-proxy.ts:530`,
   `orchestrator/worker-auth.ts:15-17`), preview dialing
   (`preview-proxy.ts:946-953`), egress tiers joining a netns
   (`egress-firewall-install.ts:198-199`), Compose service inspection and log
   follow (`service-poller.ts:590`, `compose-cli.ts:559`), overlay volumes,
   adoption, health, memory stats and the janitors — 23 dockerode importers and
   34 `containerIp` sites — assume one daemon on one host. That is the
   rewrite 264 named, confirmed at the source.
5. **The density model does not transfer.** Session memory limits are a
   ceiling, not a reservation — half the host per session, relying on
   overcommit (`container-config-builder.ts:4-9, 168-193`). A guest kernel
   fills free RAM with page cache and keeps it unless the host reclaims it
   (balloon, free-page reporting), so a VM tier needs a real per-session
   memory budget that the current formula does not express.

**What to do instead, if and when a kernel boundary is wanted:** the cheapest
form of a *hardware* boundary in this codebase is not a VMM integration but an
OCI VM runtime — **Kata Containers** — selected through the same
`HostConfig.Runtime` mechanism that already selects gVisor
(`container-hardening.ts:47-50`), and applied first to the **untrusted tier
only**: plugin containers and the contained BuildKit worker. Note that today
`SESSION_RUNTIME` reaches the agent container alone
(`container-lifecycle.ts:1368`); neither `plugin-install.ts:771` nor
`plugin-cli-run.ts:857` passes a `Runtime`, so per-tier selection is new
wiring, not a setting. That is the "middle option" and it is where the
boundary is actually missing today. It is not free either; the concrete
prerequisite is replacing the netns-join egress enforcement, which a VM
runtime bypasses (below). Whether to do it at all is a product
decision this doc does not make; the triggers are restated at the end in
checkable terms.

## What was verified since 264

264's facts, re-checked one month on:

| 264 said | Today |
|---|---|
| Docker Sandboxes: `sbx` CLI only, no programmatic API | **Changed.** Docker published generated SDKs on 2026-09-02/03 — `@docker/sbx-api` 0.36.0 (npm), `docker-sbx-api` (PyPI), `github.com/docker/sandboxes-api` (Go) — a Connect-RPC contract served by a local `sandboxd` daemon and a cloud endpoint. Nothing on docs.docker.com documents it, the source repo returns 404, and the local socket path and auth are unpublished. 264's trigger 1 ("a *documented* programmatic API") is in motion but not met. |
| Ports publish to the host | Still true: `[[HOST_IP:]HOST_PORT:]SANDBOX_PORT`, loopback by default; no bridge join documented. |
| Nested virtualization "many cloud instance types do not" support | Weaker now: AWS added nested virtualization on virtualized Intel 7i/8i instances on 2026-02-16 (opt-in, no ARM/AMD/T-family); GCE and Azure support it on most x86 series. Still absent on Hetzner Cloud, Linode, macOS Docker Desktop. |
| "rejects `--privileged` and host mounts" | Overstated: binds *under the session workspace* are allowed (`docker-proxy-sanitize.ts:123-141`); only out-of-workspace paths, `Devices`, `VolumesFrom` are rejected. |
| Kernel hardening opt-ins default-off | Still true, and they apply only to the agent container — Compose services get `cap_drop: [NET_RAW]` (plus `SETUID`/`SETGID` and `no-new-privileges` under containment) and no runtime/seccomp/ro-rootfs (`compose-generator.ts:1827-1836`); plugin containers get `CapDrop: ALL` but no runtime either (`plugin-install.ts:788-793`). |

Which of 264's objections survive a direct VMM design: **2** (hypervisor in
the orchestrator), **3** (network position as identity) and **4** (Compose
services behind a daemon the orchestrator cannot see) survive unchanged and
are covered by the numbered points above. **1** (CLI-only control) and **5**
(account/licensing) are Docker-product properties and do not apply.

## What the mechanisms are

Figures from upstream sources; the vendor "125 ms" number is included only to
say what it measures.

| | Firecracker 1.16.1 (2026-07-02) | Cloud Hypervisor 53.0 (2026-07-12) | Kata Containers 4.1.0 (2026-08-21) | gVisor (weekly; 2026-08-31) |
|---|---|---|---|---|
| Shape | Rust VMM, REST over Unix socket, jailer | Rust VMM, REST over Unix socket, seccomp + Landlock, **no jailer** | containerd shim v2; `docker run --runtime kata` with Docker v26+; hypervisor pluggable | user-space kernel (Sentry) as an OCI runtime |
| Host needs | Linux, KVM, x86_64/aarch64; host kernels 5.10/6.1/6.18 | Linux, KVM or MSHV | Linux, `/dev/kvm`, `vhost_vsock`, `vhost_net` | Linux 5.6+; **no KVM** (systrap platform is the default; the KVM platform is discouraged inside a VM) |
| Shared filesystem | **None** (virtio-fs rejected; vhost-user generic device unmerged) | virtio-fs via `virtiofsd`, needs `--memory shared=on`, no DAX | virtio-fs default (9p dropped in the Rust runtime); block volumes preferred | host FS via gofer / directfs |
| Docker inside | n/a (block rootfs, devmapper snapshotter needed under Kata) | n/a | works, with `/var/lib/docker` on tmpfs or a block volume (virtio-fs cannot be an overlay upper) | documented, needs `--net-raw` and `dockerd --iptables=false` |
| Fixed per-VM overhead | ≤ 5 MiB VMM threads (1 vCPU/128 MiB guest) | not published | **130 MiB** (CLH/FC) – **320 MiB** (QEMU) host-side, declared in kata-deploy; +32–128 MiB guest-side | ~20–50 MiB per container (density CSV) |
| Boot | ≤ 125 ms = API start → `/sbin/init` exec, serial off, minimal rootfs | "< 100 ms" kernel-start → userspace-start, Ubuntu Jammy guest | ~1.9 s (Dragonball) / ~2.4 s (Firecracker) full container start, 4 vCPU/4 GiB, Edera paper 2026 | ~ runc |
| Realistic guest | Depot (CH v51, 8 vCPU/16 GB Ubuntu): 7–9 s stock → 2.3 s trimmed systemd → 0.6 s p50 with custom init and hugepages | | | |
| Kata + Docker + this VMM | **broken** (needs net hotplug; #10661 open) | tested in CI; Docker support "tested with QEMU" | | |

Who runs what (own docs): E2B, Fly.io, Vercel Sandbox and Blaxel — Firecracker;
Northflank — Kata + Cloud Hypervisor with gVisor fallback where nested
virtualization is unavailable; Modal and claude.ai code execution — gVisor;
the remote provider in planning#204 — microVMs (VMM not named) with
`/dev/kvm` passed into Linux instances; Anthropic's local Claude Code sandbox — bubblewrap/Seatbelt, no
container at all.

**Measurement I could not make.** No `/dev/kvm` reaches a session container
(the only passthrough is the Android emulator Compose service,
`compose-generator.ts:770-783`), and the orchestrator has none either, so a
ShipIt-shaped guest could not be booted here. What could be measured: this
session container sits at ~500 MB cgroup usage (`memory.current`), of which
the agent CLI is ~350 MB RSS and the worker processes ~330 MB. A guest running
the same would add a guest kernel and the VMM/shim, then grow with page cache
that the host cannot see. Kata's declared 130–320 MiB `podFixed` allowances
cover guest *and* host overhead and are described upstream as
over-provisioned, so they are an accounting budget, not a measured RSS.
Hypothesis, unmeasured: **roughly 0.7–1 GiB resident per idle session**
against ~500 MB today. That is the first number to take on a live host
before anything is designed.

## What ShipIt already has

The isolation stack is layered and each layer has dependents; the parts that
matter here, verified:

- **Always on, agent container:** `CapDrop: ["ALL"]` with five caps re-added,
  `no-new-privileges`, `Init`, PIDs/memory/CPU limits
  (`container-lifecycle.ts:1342-1390`); root-to-`gosu` drop in the entrypoint.
- **Opt-in, agent container only:** `SESSION_RUNTIME` (gVisor `runsc`),
  `SESSION_SECCOMP`, `SESSION_READONLY_ROOTFS` — all default-off
  (`container-hardening.ts`). `docs/172-agent-containment` checklist records gVisor was
  never verified on a live host.
- **Egress containment, default ON:** `SESSION_EGRESS_ENFORCE` defaults on
  (`egress-firewall-install.ts:46-47`; the "default-off" comment at
  `session-container.ts:1085-1086` is stale). Tier A/B/C are separate
  containers with `NetworkMode: container:<id>` — the firewall installer and
  the resolver with `CAP_NET_ADMIN`, the SNI proxy with none — that install
  iptables rules, dnsmasq and a loopback proxy **inside the target's network
  namespace** (`egress-firewall-install.ts:188-231`,
  `egress-dns-install.ts:156-157`, `egress-proxy-install.ts:131-136`). The
  rules are `OUTPUT`-chain rules with uid-owner exemptions, a DNS redirect and
  a loopback proxy target (`docker/egress-sidecar/init-firewall.sh:145-230`). Plugin
  containers and Compose services get the same holders (`plugin-egress.ts`,
  `compose-service-egress.ts:265-336`).
- **Identity by network position:** loopback = own agent, bridge + token =
  orchestrator (`shared/worker-auth.ts:17-25`); the orchestrator's guard and
  `docker-proxy.ts` map the socket peer IP to a session.
- **Plugins run in their own containers** on an untrusted bridge, never
  `container:<session>` (`plugin-container.ts:11-26`, `plugin-egress.ts:37-42`)
  — non-root, `CapDrop: ALL`, but on the host kernel.
- **Idle reclaim is memory-budget driven, longest-idle first**
  (`idle-enforcer.ts:63-97`, docs/284); the fixed grace CLAUDE.md still
  mentions is gone.

## Where a kernel boundary would genuinely help

1. **Repo-authored plugin code** (docs/262). It runs non-root with every
   capability dropped, but on the shared kernel, with nothing but Docker's
   default seccomp between it and the host.
2. **Repo-declared builds.** The contained-builds design (on an unmerged
   branch at the time of writing; `docs/263-compose-service-egress` leaves
   builds outside its scope at `plan.md:47`) concluded that a BuildKit worker
   must be a *privileged* container and that a Dockerfile `RUN` executes as
   root under the default OCI capability set and seccomp profile — a wider kernel surface than any session container. A VM is the
   natural home for "privileged, but only inside its own kernel".
3. **Docker-access sessions**, where a private in-guest daemon would make
   `docker-proxy.ts` unnecessary. This is 264's point 2 and is unchanged.

The session container is deliberately *not* on this list, and that is a
risk decision rather than an absence of benefit. A session does execute
repository and dependency code — `agent.install` runs through a shell in the
workspace (`session/install-controller.ts:637`), and so do tests and dev
servers — and `container-hardening.ts:4` names the residual container-escape
surface. A kernel boundary would cover that. The judgement here is that the
session's dominant threat is prompt injection reaching credentials and the
network, which the egress tiers and trust boundaries address, and that the
cost side (every item in the recommendation) is paid per session, whereas the
untrusted tier pays it per plugin or build.

## The three options

### A. Per-session microVM (Firecracker / Cloud Hypervisor, driven by the orchestrator)

Rejected, for the five numbered reasons in the recommendation. Two more
details from the code: the preview proxy dials each **Compose service's** IP
before the agent's (`preview-proxy.ts:946-949`), so services inside a guest
would need an in-guest multiplexer; and inbound caller classification is
by source IP in three places. The worker-token registry itself is keyed by a
base URL string (`orchestrator/worker-auth.ts:15-20, 56`) and would accept any
URL; what is Docker-bound is how the token is provisioned and re-read on
adoption (`container-lifecycle.ts:1440`, `worker-auth.ts:97-107`), and the
transport is plain `http.request` (`worker-http.ts:181`), not something ready
for a remote hop.

### B. Kata Containers as a runtime, for the untrusted tier — the middle option

Kata is an OCI runtime: the Docker daemon still creates the container, its
network namespace, its veth on ShipIt's bridge and its volume mounts; Kata
boots a VM inside that shape and bridges the veth to a tap with TC filters.
What this preserves and what it breaks, per ShipIt mechanism:

| Mechanism | Under Kata |
|---|---|
| Orchestrator → worker over `http://<bridge-ip>:9100` | preserved — the container keeps its bridge IP |
| Preview proxy, source-IP identity, `docker-proxy` caller lookup | preserved for the same reason |
| Compose services, service registry, `compose logs` | preserved — they stay ordinary containers on the host daemon (or Kata ones, per service) |
| Bind mounts, Subpath volumes, overlay dep-dir volumes, `/plugins` ro | preserved as mounts, delivered by **virtio-fs**; the daemon still performs the overlay mount on the host (`overlay-volume.ts:10-18`), the guest sees the merged tree |
| `clone --local` hardlinks, shared cache uid rules | preserved — all host-side |
| Idle reclaim, health, adoption | preserved — still Docker containers |
| **Egress Tier A/B/C** | **broken.** The sidecars install rules in the container's netns, but Kata's default TC-filter redirection moves packets tap↔veth below netfilter — that is precisely why Kata's experimental L3-forwarding mode exists "where the CNI sets up iptables rules". Kata also lists `--net=container:` as unsupported. The existing topology is incompatible, and relocating the rules is not enough: they are `OUTPUT` rules with uid-owner exemptions, a DNS redirect to a namespace-local resolver and a loopback SNI proxy (`init-firewall.sh:145-230`), none of which apply to forwarded guest packets. Replacement enforcement on the host side of the per-session bridge (docs/263 already creates `shipit-egress-<id>` NAT bridges) has to be designed and validated, including how the resolver and proxy are reached from the guest. |
| Memory sizing | changed — Kata sizes the VM from the container limit (`static_sandbox_resource_mgmt`), so the half-host ceiling becomes guest RAM; touched pages only are resident, but the guest page cache stays resident unless `reclaim_guest_freed_memory` (free-page reporting, default off) or a balloon returns it. Needs a real budget. |
| Docker / BuildKit inside the guest | not needed for the agent (its `docker` CLI still points at the host-side proxy). A BuildKit worker runs its own daemon, not dockerd, but the same constraint applies: its snapshotter storage (`/var/lib/buildkit`) cannot live on virtio-fs, which cannot be an overlay upper, so it needs a block or tmpfs volume |
| `privileged` | a privileged container under Kata is privileged **inside the guest**; the Go runtime has `privileged_without_host_devices` to keep host devices out — verify the Rust runtime's equivalent before relying on it |
| Start cost | ~2 s per container (Edera, 4 vCPU/4 GiB); hidden by the warm pool for sessions, but paid on every plugin CLI invocation, which spawns a container per call (`plugin-cli-run.ts:840-870`) |
| Hypervisor choice | QEMU is the only Docker-tested path (320 MiB fixed overhead); Cloud Hypervisor is a supported Kata hypervisor (130 MiB) but not Docker-tested; **Firecracker under Kata + Docker is broken** and Kata pins an out-of-support Firecracker |
| Where it can run | Linux hosts with `/dev/kvm` only — the same list as option A; macOS local and Hetzner Cloud are out |

Applied to the untrusted tier only — plugin install/CLI containers and the
BuildKit worker — the blast radius of the egress change is small (those
containers already have their own bridge and holders), the 2 s start is
tolerable for builds and marginal for plugin CLIs, and sessions keep today's
density. Applied to sessions it inherits every cost in the table for a threat
that is not on the list above.

### C. Status quo, plus what is already wired

gVisor via `SESSION_RUNTIME=runsc` needs no KVM, runs inside any VM with the
systrap platform, runs Docker inside it, and would extend to plugin and build
containers by passing the same `Runtime` (today only the agent container gets
it). It narrows the host syscall surface to the Sentry's; it is not a
hardware boundary, does not cover hardware side channels, and does not
enforce cgroup limits inside (host cgroups still do). What a microVM buys over
it, concretely: a real Linux kernel (full compatibility — overlay-on-overlay,
io_uring, `perf`, mounts, cgroups — matters for builds more than for agents),
and a boundary that is hardware plus a small VMM rather than a large Go
reimplementation exposed to the sandboxed code. What it costs over it: KVM,
which excludes the local macOS install outright.

For the untrusted tier the honest ordering is: **verify gVisor on a live host
first** (docs/172 never did) and extend it to plugin and build containers;
reach for Kata only if a build or plugin workload fails under gVisor, or if a
review concludes the Sentry is not an acceptable boundary for root-in-a-build.

## Relationship to a remote sandbox provider (planning#204)

planning#204 evaluates running ShipIt on a hosted microVM provider, in two
models: the whole ShipIt stack inside one provider instance (Model A, its
recommendation), or one central orchestrator provisioning per-session remote
instances behind a `SessionRuntime.create(config) -> { workerUrl,
previewBaseUrl(port), destroy() }` seam (Model B). Nik asked whether a
self-run VM tier could share infrastructure with that.

**A self-run Kata tier and a remote-provider backend share almost nothing
mechanically, and that is the point.** Kata's entire value is that it keeps
every Docker assumption — bridge IP, daemon-mounted volumes, netns, Compose
siblings — so it needs no seam. A remote backend replaces the daemon and needs
the seam, and the seam is further away than #204 states: the agent-control
path already takes a URL, but `previewBaseUrl(port)` has to be a per-port
resolver covering Compose services, caller identity has to stop being a bridge
IP, and egress, overlay storage and observability all sit behind Docker
(section "The runtime seam", verified list in the checklist). Building that
seam is Model B's work; a self-run microVM backend would then be a second
provider behind it, but at that point it is the expensive path this doc
rejects.

What *is* shared:

- **Model A composes with option B.** The provider passes `/dev/kvm` into
  Linux instances (its nested-virtualization page: `linux/amd64` supported, no
  flag needed in a devbox), so a ShipIt running inside one instance can use
  the `HostConfig.Runtime` mechanism (once wired to the untrusted tier) with
  `kata` or `runsc` exactly as on a bare-metal VPS. That mechanism is the
  shared infrastructure; nothing else needs to be.
- **Host-side egress enforcement** — the prerequisite for any VM runtime — is
  also what a provider's egress policy replaces in Model A (#204 already plans
  `SESSION_EGRESS_ENFORCE=0` there). Moving enforcement to the bridge is the
  design that survives both.
- **The provider's own API** (gRPC/Connect, scoped tokens, ingress with
  wildcard domains, egress policy tags, suspend/wake) is a complete Model B
  surface today, which #204 flagged as unverified in June; the provider-specific
  detail is recorded on that issue, not here, per its confidentiality note.

## What would change the answer

Restated so each can be checked rather than argued:

1. **A plugin or build workload that gVisor cannot run** — a concrete
   `runsc` failure on a live host for something the plugin contract
   (docs/262) or the contained-builds design requires. That is the trigger for
   option B on the untrusted tier.
2. **A review concluding the Sentry is not an acceptable boundary for root in
   a build**, recorded on the contained-builds issue. Same trigger.
3. **Replacement egress enforcement lands and is validated** (host side of
   the per-session bridge, with resolver and proxy reachable from a guest).
   Until it does, turning on a VM runtime silently disables containment.
4. **A live-host measurement** of resident memory per idle Kata session and
   per idle plugin container, and of plugin CLI invocation latency, against
   the ~500 MB / sub-second figures today. If sessions ever go on the list,
   these numbers decide it.
5. **Firecracker merges a shared-filesystem path** (the generic vhost-user
   device, PR #6147 or successor) — removes reason 2 for Firecracker, not
   reasons 1, 3, 4, 5.
6. **Docker documents the Sandboxes API** (docs.docker.com page for the
   `sbx-api` contract, local socket path and auth) — 264's trigger 1 met;
   re-open 264's comparison for local/single-machine mode only, since its
   ports still publish to host loopback.
7. **The local install drops macOS, or Docker Desktop ships nested
   virtualization** — removes half of reason 1.

## Key files

- `src/server/orchestrator/container-hardening.ts` — `SESSION_RUNTIME` / seccomp / ro-rootfs opt-ins; the knob a Kata tier would reuse.
- `src/server/orchestrator/container-lifecycle.ts` — mounts (`buildMounts`), caps, sidecar teardown, `containerIp` discovery.
- `src/server/orchestrator/egress-firewall-install.ts`, `egress-dns-install.ts`, `egress-proxy-install.ts` — the netns-join tiers that a VM runtime bypasses.
- `src/server/orchestrator/compose-service-egress.ts` — per-session NAT bridge (`shipit-egress-<id>`), the natural host-side enforcement point.
- `src/server/orchestrator/plugin-container.ts`, `plugin-install.ts`, `plugin-cli-run.ts`, `plugin-egress.ts` — the untrusted tier.
- `src/server/orchestrator/api-container-guard.ts`, `docker-proxy.ts`, `worker-auth.ts`, `src/server/shared/worker-auth.ts` — identity by network position.
- `src/server/orchestrator/preview-proxy.ts` — service-then-agent target resolution.
- `src/server/orchestrator/container-config-builder.ts` — memory ceiling formula.
- `src/server/orchestrator/overlay-volume.ts` — daemon-side overlay mounts.
- `docs/264-docker-sandboxes-evaluation`, `docs/172-agent-containment`, `docs/263-compose-service-egress`, `docs/262-plugins`, `docs/229-auto-resource-sizing`, `docs/183-overlay-dep-store`, `docs/272-shared-cache-ownership`.

## Sources

Fetched 2026-09-06.

- Firecracker: [SPECIFICATION.md](https://github.com/firecracker-microvm/firecracker/blob/main/SPECIFICATION.md), [kernel-policy](https://github.com/firecracker-microvm/firecracker/blob/main/docs/kernel-policy.md), [jailer](https://github.com/firecracker-microvm/firecracker/blob/main/docs/jailer.md), [network-setup](https://github.com/firecracker-microvm/firecracker/blob/main/docs/network-setup.md), [snapshot-support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md), [issue #1180 host filesystem sharing](https://github.com/firecracker-microvm/firecracker/issues/1180), [PR #1351 virtio-fs](https://github.com/firecracker-microvm/firecracker/pull/1351), [issue #5687 generic vhost-user](https://github.com/firecracker-microvm/firecracker/issues/5687), [PR #6147](https://github.com/firecracker-microvm/firecracker/pull/6147), [test_boottime.py](https://github.com/firecracker-microvm/firecracker/blob/main/tests/integration_tests/performance/test_boottime.py), [releases](https://github.com/firecracker-microvm/firecracker/releases).
- Cloud Hypervisor: [README](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/README.md), [fs.md](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/fs.md), [threat-model](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/threat-model.md), [api.md](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/api.md), [release-notes](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/release-notes.md), [performance_tests.rs](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/performance-metrics/src/performance_tests.rs).
- Kata Containers: [installation.md](https://github.com/kata-containers/kata-containers/blob/main/docs/installation.md), [Limitations.md](https://github.com/kata-containers/kata-containers/blob/main/docs/Limitations.md), [networking design](https://github.com/kata-containers/kata-containers/blob/main/docs/design/architecture/networking.md), [virtio-fs how-to](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-use-virtio-fs-with-kata.md), [Docker-in-Kata how-to](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-run-docker-with-kata.md), [sizing overhead](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/how-to-size-sandbox-overhead-runtime-rs.md), [kata-deploy runtimeclasses.yaml](https://github.com/kata-containers/kata-containers/blob/main/tools/packaging/kata-deploy/helm-chart/kata-deploy/templates/runtimeclasses.yaml), [CLH runtime-rs config](https://github.com/kata-containers/kata-containers/blob/main/src/runtime-rs/config/configuration-clh-runtime-rs.toml.in), [issue #10661 Docker + Firecracker](https://github.com/kata-containers/kata-containers/issues/10661), [4.0.0](https://github.com/kata-containers/kata-containers/releases/tag/4.0.0), [4.1.0](https://github.com/kata-containers/kata-containers/releases/tag/4.1.0).
- gVisor: [security model](https://gvisor.dev/docs/architecture_guide/security/), [platforms](https://gvisor.dev/docs/architecture_guide/platforms/), [production guide](https://gvisor.dev/docs/user_guide/production/), [compatibility](https://gvisor.dev/docs/user_guide/compatibility/), [Docker in gVisor](https://gvisor.dev/docs/tutorials/docker-in-gvisor/), [performance](https://gvisor.dev/docs/architecture_guide/performance/), [FAQ (Linux only)](https://gvisor.dev/docs/user_guide/FAQ/).
- Docker Sandboxes: [install](https://docs.docker.com/ai/sandboxes/install/), [isolation](https://docs.docker.com/ai/sandboxes/security/isolation/), [`sbx ports`](https://docs.docker.com/reference/cli/sbx/ports/), [`sbx daemon`](https://docs.docker.com/reference/cli/sbx/daemon/), [`@docker/sbx-api` on npm](https://registry.npmjs.org/@docker/sbx-api), [`docker-sbx-api` on PyPI](https://pypi.org/project/docker-sbx-api/), [Desktop release notes (4.80.0 plugin removal)](https://docs.docker.com/desktop/release-notes/), [Why MicroVMs](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/).
- Nested virtualization: [AWS announcement 2026-02-16](https://aws.amazon.com/about-aws/whats-new/2026/02/amazon-ec2-nested-virtualization-on-virtual), [AWS user guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html), [GCE overview](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview), [Azure Dv5 feature table](https://learn.microsoft.com/en-us/azure/virtual-machines/sizes/general-purpose/dv5-series), [Hetzner Cloud FAQ](https://docs.hetzner.com/cloud/servers/faq), [DigitalOcean live migration](https://docs.digitalocean.com/products/droplets/details/live-migration/), [OVH FAQ](https://docs.ovhcloud.com/en/guides/public-cloud/cross-functional/faq-pci), [Apple `isNestedVirtualizationSupported`](https://developer.apple.com/documentation/virtualization/vzgenericplatformconfiguration/isnestedvirtualizationsupported), [docker/desktop-feedback#314](https://github.com/docker/desktop-feedback/issues/314), [WSL config](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).
- Measurements: [Depot — microVMs booting in under a second](https://depot.dev/blog/optimizing-microvm-boot-times), [Edera, "Goldilocks Isolation" (arXiv 2501.04580v2)](https://arxiv.org/abs/2501.04580), [AKS pod sandboxing overhead table](https://learn.microsoft.com/en-us/azure/aks/considerations-pod-sandboxing).
- Who runs what: [E2B](https://e2b.dev/blog/not-affected-by-copy-fail-heres-why), [Fly.io architecture](https://fly.io/docs/reference/architecture/), [Vercel Sandbox](https://vercel.com/docs/sandbox/concepts), [Blaxel](https://docs.blaxel.ai/Sandboxes/Overview), [Northflank](https://northflank.com/blog/how-to-spin-up-a-secure-code-sandbox-and-microvm-in-seconds-with-northflank-firecracker-gvisor-kata-clh), [Modal security](https://modal.com/docs/guide/security), [Anthropic — how we contain Claude](https://www.anthropic.com/engineering/how-we-contain-claude). The remote provider's sources are recorded on planning#204.
