---
description: Architecture for running ShipIt as a multi-tenant managed service on Kubernetes with per-tenant namespace isolation, Sysbox DinD, and resource quotas.
---

# 062 — Managed ShipIt (Multi-Tenant Hosting)

High-level architecture for running ShipIt as a managed service with multiple untrusted tenants. This is the monetization path — users pay for a hosted ShipIt instance instead of running it themselves.

## How this relates to 061

[061-self-hosting](../061-self-hosting/plan.md) covers single-user self-hosted ShipIt where the user owns the machine. The threat model there is "protect the user from Claude mistakes." Docker socket passthrough is fine because the user already has root.

This doc covers a fundamentally different threat model: **protect tenants from each other**. A malicious or compromised Claude process in tenant A's session must not be able to read tenant B's files, access tenant B's containers, or exhaust shared resources. This changes almost every isolation decision.

## Threat Model

| Threat | Self-hosted (061) | Managed (this doc) |
|---|---|---|
| Claude reads other sessions' files | Low risk — same user | **Critical** — tenant data leak |
| Claude kills other containers | Annoying — same user | **Critical** — tenant DoS |
| Claude exhausts host resources | User's own problem | **Critical** — affects all tenants |
| Claude exfiltrates credentials | User's own creds | **Critical** — other tenants' creds |
| Claude escapes container | Full host access (user already has it) | **Critical** — multi-tenant breach |

## Architecture Overview

### Orchestration: Kubernetes

Docker Compose is sufficient for single-host self-hosted. Managed needs:

- **Per-tenant namespaces** — filesystem, network, and resource isolation enforced by the kernel, not by application code
- **Network policies** — tenant A's pods cannot reach tenant B's pods
- **Resource quotas** — per-tenant CPU/memory caps enforced by the scheduler
- **Pod security standards** — restricted profile, no privilege escalation, read-only root filesystem
- **Horizontal scaling** — add nodes as tenant count grows
- **Rolling updates** — deploy new ShipIt versions without downtime

A single Kubernetes cluster with namespace-per-tenant provides all of this out of the box.

### Session Isolation: Pods

Each session becomes a Kubernetes pod (or set of pods) instead of a Docker container managed by the Fastify orchestrator. The orchestrator talks to the Kubernetes API instead of the Docker API.

```
Kubernetes cluster
  ├── shipit-system namespace
  │     └── Orchestrator deployment (Fastify, auth, session metadata)
  │
  ├── tenant-alice namespace
  │     ├── session-abc pod (session worker + Claude CLI)
  │     │     └── user's code runs here
  │     └── session-def pod
  │
  └── tenant-bob namespace
        └── session-xyz pod
```

**Key differences from self-hosted:**
- Orchestrator doesn't manage container lifecycle directly — it creates/deletes pods via k8s API
- Network policies enforce that pods in `tenant-alice` cannot reach pods in `tenant-bob`
- Resource quotas per namespace cap total tenant resource usage
- Pod security context replaces Docker's `SecurityOpt` and capability flags

### Docker-in-Session: Two Options

For sessions that need Docker access (`capabilities.docker: true`):

#### Option A: Sysbox DinD

Viable for managed because **we control the nodes**. Install Sysbox on all worker nodes (Ubuntu, kernel 5.12+). Each Docker-enabled session pod runs with `runtimeClassName: sysbox-runc`, getting a fully isolated Docker daemon.

**Pros:** True isolation. Inner Docker is invisible to the host and other tenants. Full Docker compatibility.
**Cons:** Sysbox must be installed on nodes (CRI-O required, Ubuntu node images). ~300 MB overhead per session. Image cold start.

#### Option B: Kubernetes-Native Sidecar Pods

Instead of giving sessions a Docker daemon, translate Docker operations into Kubernetes operations. When a session's `docker-compose.yml` says "run postgres:16", the orchestrator creates a postgres pod in the tenant's namespace as a sidecar.

**Pros:** No nested Docker daemon. Uses k8s-native isolation. No Sysbox dependency.
**Cons:** Not 100% Docker-compatible — compose volumes, custom networks, and build contexts would need translation. Significant abstraction layer. The "fidelity" argument from 061 applies: this isn't the same as running Docker on a laptop.

#### Recommendation

Option A (Sysbox) for managed. The platform constraints that make Sysbox awkward for self-hosted (must be Linux, specific kernel, can't use Docker Desktop) don't apply when we control the infrastructure. We pick Ubuntu nodes with the right kernel and install Sysbox as part of cluster provisioning. The isolation benefit is worth the overhead in a multi-tenant context.

Option B is interesting as a future optimization for sessions that don't need full Docker fidelity (e.g., just want to run a database sidecar), but it's a much larger abstraction effort.

### Credential Isolation

Self-hosted mounts a shared `/credentials` volume into all sessions. Managed needs per-tenant secrets:

- Kubernetes Secrets per namespace, mounted as volumes into session pods
- Orchestrator never stores tenant credentials on its own filesystem
- Claude CLI auth token is injected as an env var, not a file
- GitHub tokens are per-tenant, stored in the tenant's namespace

### Network Egress

Self-hosted trusts the user's network. Managed needs egress controls:

- Default deny egress from session pods
- Allowlist: npm registry, PyPI, GitHub, Docker Hub, Claude API
- Per-tenant egress overrides for custom registries or APIs
- NetworkPolicy enforcement (Calico or Cilium CNI)

### Storage

Self-hosted uses Docker volumes on the host. Managed needs:

- PersistentVolumeClaims per session (or per tenant with subdirectories)
- Storage class with encryption at rest
- Backup/restore for tenant data
- Volume size limits per tenant

---

## What Changes in the Codebase

| Component | Self-hosted (current) | Managed |
|---|---|---|
| Session lifecycle | `SessionContainerManager` → Docker API | New `K8sSessionManager` → Kubernetes API |
| Container config | `ContainerConfig` → `docker.createContainer()` | `PodSpec` → `k8s.createNamespacedPod()` |
| Preview proxy | Routes to Docker bridge IPs | Routes to k8s Service ClusterIPs |
| Auth | Single-user Claude OAuth | Multi-tenant auth (OAuth per tenant, API keys) |
| Credential storage | Shared volume | k8s Secrets per namespace |
| Resource limits | Docker `HostConfig` | k8s ResourceRequirements + namespace ResourceQuota |
| Docker-in-session | Socket passthrough | Sysbox runtime class |

The `capabilities.docker` API in `shipit.yaml` stays the same — projects don't change. The orchestrator's implementation of that capability changes entirely.

### Abstraction Boundary

The existing `SessionRunner` interface (doc 055) is the right seam. `ContainerSessionRunner` currently proxies to a Docker container's HTTP API. A `K8sSessionRunner` would proxy to a pod's HTTP API — same interface, different transport. The orchestrator's `SessionRunnerRegistry` doesn't care which implementation is behind the interface.

Similarly, `SessionContainerManager` encapsulates container lifecycle. A `K8sSessionManager` implementing the same shape (create, destroy, list, health check) would slot in via dependency injection.

---

## What Doesn't Change

- **Session worker code** — the Fastify server inside each session is identical. It doesn't know if it's in a Docker container or a k8s pod.
- **Client code** — the React app talks to the orchestrator via HTTP/WS. It doesn't know about the backend topology.
- **`shipit.yaml` format** — projects declare capabilities and resources the same way.
- **Claude CLI integration** — same NDJSON protocol, same process management.
- **Git operations** — same worktree lifecycle, same push/pull mechanics.

---

## Open Questions

1. **Tenant model.** One namespace per user? Per organization? Per subscription tier? This affects resource quota granularity and billing.

2. **Orchestrator topology.** Single orchestrator deployment serving all tenants (simpler, single point of failure) vs per-tenant orchestrator pods (stronger isolation, more complex)?

3. **Session persistence across restarts.** k8s pods are ephemeral by default. Do we need StatefulSets or just PVCs for workspace data?

4. **Cold start latency.** Pod scheduling + image pull + session worker startup. Acceptable? Need pod warm pools?

5. **Cost model.** Per-session-minute? Per-tenant-month? Resource-based (CPU/memory/storage)?

6. **Migration path.** Can a self-hosted ShipIt deployment be "upgraded" to managed, or are they separate installs? Probably separate — the orchestration model is too different.

7. **Sysbox on managed k8s.** EKS/GKE/AKS all have constraints (CRI-O, Ubuntu nodes, no secure boot on AKS). Self-managed k8s (e.g., on bare metal or raw VMs) avoids these but adds operational burden. Which is the right starting point?
