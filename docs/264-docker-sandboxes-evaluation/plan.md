---
issue: planning#372
title: Docker Sandboxes evaluation
description: Whether Docker's microVM agent sandboxes (the sbx CLI) are useful for ShipIt session isolation, Docker-access sessions, or plugin execution.
---

# 264 — Docker Sandboxes evaluation

## Recommendation

**Do not adopt, and do not plan a migration.** Keep Docker Sandboxes on the
watch list, gated on two events:

1. Docker ships a documented **programmatic API** (daemon or HTTP), not just the
   `sbx` CLI.
2. ShipIt decides it needs a **hardware isolation boundary** for repo-authored
   code — plugin execution (docs/262) or repo-declared BuildKit builds, which
   docs/263 explicitly leaves outside its service-network policy.

The capability we would be buying is a kernel boundary. The cheapest form of
that is already wired: `SESSION_RUNTIME=runsc` selects gVisor per session
container (`container-hardening.ts`, control 1), default-OFF and operator
opt-in. It needs no orchestrator rewrite. If a *hardware* boundary later proves
necessary, compare Sandboxes against a direct Firecracker / Cloud Hypervisor
design at that point, because ShipIt needs server-side control and `sbx` is a
workstation tool.

## What Docker Sandboxes is

Announced as Docker's isolation layer for coding agents. The facts that matter
here, from Docker's own docs and engineering blog (sources below), as of
2026-08:

| Aspect | Behavior |
|---|---|
| Isolation | One microVM per sandbox, own kernel, custom cross-platform VMM (Hypervisor.framework / WHP / KVM) |
| Docker access | Each microVM carries its **own Docker daemon** — real `build`/`run`/`compose` with no socket mount and no privileged container |
| Control surface | The `sbx` CLI only: `run`, `exec`, `ls`, `ports`, `template`, `setup`. No API or daemon is documented |
| Filesystem | Host directories mounted as workspaces; extra workspaces mount at their absolute host path, `:ro` supported |
| Networking | Isolated by default; reach a service by publishing a port to the **host** (`--publish`, or `sbx ports` later) |
| Persistence | Installed packages, images, and config survive stop/restart; removal deletes everything in the sandbox |
| Linux requirements | Ubuntu 24.04+, KVM enabled by the CPU, user in the `kvm` group, nested virtualization required inside a VM |
| Account | Docker sign-in required. CLI free for commercial use; central network/filesystem/MCP policy is a paid subscription |

## What ShipIt already has

Session isolation in ShipIt is not a single mechanism; it is a stack, and each
layer has dependents:

- **Egress containment** — the Tier A/B/C sidecar policy, plus per-service
  network-namespace holders for Compose runtime services (docs/263).
- **Docker access without a socket** — `docker-proxy.ts`. Sessions get a real
  Docker CLI pointed at a proxy that rejects `--privileged` and host mounts and
  scopes every resource by session label. It identifies the caller by **bridge
  source IP**, which is why `NET_RAW` is dropped.
- **Trust boundaries** — the orchestrator's API against container callers
  (docs/201) and the worker's API against non-own-agent callers (docs/251),
  both built on network position: loopback means "my own agent", bridge plus
  bearer token means "the orchestrator".
- **Kernel-tier hardening, opt-in** — gVisor runtime, a custom seccomp profile,
  and read-only rootfs, all default-OFF (`container-hardening.ts`).

## Where Sandboxes would genuinely help

1. **A hostile-code tier.** Plugin code (docs/262) and repo-declared build steps
   run on the shared host kernel. A microVM gives a boundary that containers,
   seccomp, and capability drops cannot give. gVisor narrows this surface;
   it does not remove it.
2. **Deleting `docker-proxy.ts` for Docker-access sessions.** That proxy exists
   only because a session must not touch the host daemon. A private in-VM daemon
   makes the whole allowlist, the create-payload sanitizer, and the label
   scoping unnecessary for those sessions.
3. **Local and single-machine modes.** `sbx` targets exactly the
   one-developer-workstation shape, which is where `RUNTIME_MODE=local`
   dogfooding lives.

## Why it does not fit ShipIt today

1. **No programmatic control surface.** Docker documents a CLI. The orchestrator
   drives containers through the Docker API with labels, resource limits,
   volumes, networks, health, and events — `container-lifecycle.ts`,
   `container-config-builder.ts`, `container-discovery.ts`, `container-health.ts`.
   Shelling out to `sbx` per operation is a downgrade, and it sits badly with
   the HTTP-only control rule.
2. **The orchestrator would have to host a hypervisor.** The orchestrator itself
   runs in a container. Starting microVMs from there means `/dev/kvm`
   passthrough and extra privilege on the very process whose blast radius we are
   trying to shrink — and the deployment host must support nested
   virtualization, which many cloud instance types do not.
3. **The networking model is inverted.** The preview proxy dials the session
   container's bridge IP (`{sessionId}--{port}` subdomain routing, docs/175),
   and the orchestrator dials the worker at `9100` on that same bridge. A
   sandbox instead publishes ports to the host. Both paths, and the source-IP
   identity that docs/201 and `docker-proxy.ts` rely on, would need redesign.
4. **We lose sight of Compose services.** Preview status, the service registry,
   `shipit service logs`, and docs/263's per-service namespace holders all
   require the orchestrator to address service containers directly. Inside a
   sandbox those containers belong to a daemon the orchestrator cannot see.
5. **Account and licensing friction.** Every host signs in to a Docker account,
   and centrally-managed network/filesystem policy — the part that would matter
   for a multi-tenant deployment — is a paid product.

## What would change the answer

- Docker publishes a stable sandbox API with lifecycle, exec, port, and event
  control comparable to the Docker Engine API.
- ShipIt commits to running repo-authored plugin or build code, and review
  concludes gVisor plus seccomp is not a sufficient boundary for it.
- A deployment target appears where nested virtualization is guaranteed and
  cheap.

## Key files (existing ShipIt mechanisms this compares against)

- `src/server/orchestrator/container-hardening.ts` — gVisor / seccomp / read-only rootfs opt-ins.
- `src/server/orchestrator/docker-proxy.ts` — session-scoped Docker API allowlist.
- `src/server/orchestrator/compose-service-egress.ts` — contained Compose service startup (docs/263).
- `src/server/orchestrator/container-lifecycle.ts` — container creation, networks, runtime selection.

## Sources

- [Why MicroVMs: The Architecture Behind Docker Sandboxes](https://www.docker.com/blog/why-microvms-the-architecture-behind-docker-sandboxes/)
- [Docker Sandboxes](https://docs.docker.com/ai/sandboxes/)
- [Docker Sandboxes — Usage](https://docs.docker.com/ai/sandboxes/usage/)
- [Docker Sandboxes — Install](https://docs.docker.com/ai/sandboxes/install/)
- [`sbx` CLI reference](https://docs.docker.com/reference/cli/sbx/)
