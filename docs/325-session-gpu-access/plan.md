---
issue: planning#664
title: GPU access for session containers — design
description: How an install-wide switch gives the machine's NVIDIA GPU to a session's agent container, its Compose services and the containers the agent starts.
---

# 325 — GPU access for session containers: design

**Requirements:** [`requirements.md`](./requirements.md). Numbers like (req 3) refer to entries there.

## Intent

A user who runs ShipIt in WSL2 (or on Linux) on a machine with an NVIDIA GPU wants the code their agent runs to use it: `nvidia-smi`, PyTorch with CUDA, a model server in the project's Compose file. Today nothing in a session can: the agent container gets no devices, Compose refuses every device reservation, and the Docker proxy refuses `DeviceRequests`.

## One mechanism for every container: Docker's GPU request

Every container gets the GPU the same way: the `DeviceRequests` entry that `docker run --gpus all` sends — `{ Driver: "", Count: -1, Capabilities: [["gpu"]] }`. Docker hands it to the NVIDIA runtime hook, which mounts the driver's libraries, `nvidia-smi` and the device nodes into the container. That one request works on all three hosts req 1 and req 4 name, with no code that knows which host it is on:

| Host | What makes the request work |
|---|---|
| WSL2, Docker Desktop (WSL 2 backend) | Built in. The hook passes `/dev/dxg` and `/usr/lib/wsl/lib` (CUDA through the Windows driver). |
| WSL2, Docker Engine inside the distro | The NVIDIA Container Toolkit, which has the same WSL path. |
| Native Linux | The NVIDIA Container Toolkit and the NVIDIA driver. |

Rejected: mapping `/dev/dxg` and binding `/usr/lib/wsl` by hand. It covers AMD and Intel through DirectX too, which the user ruled out (resolved question 2), it is WSL-only, and it is a second device path to secure.

The session image carries no CUDA toolkit. It does not need one: the hook brings the driver and `nvidia-smi`, and PyTorch's wheels bring their own CUDA runtime (req 2).

## The switch (req 5)

`advanced.sessionGpu` — a boolean in the settings catalogue (`global-settings.ts`), **off by default**, stored in the credential store like `advanced.enableSubAgents`. One declaration gives the Settings → Advanced toggle, `PUT /api/settings`, `shipit settings list/get`, and an agent proposal path; nothing else on the client changes. It sits beside the memory budget, the other row about the install rather than about a session's agent.

The orchestrator reads it once per container creation through a `gpuAccess` closure that `bootstrap-managers.ts` gives `SessionContainerManager` (the same route `resolveEgressConfig` takes). A change applies to every container created after it. A running container keeps the state it started with until it is next created.

## The agent container (req 1, 2, 6)

`createContainer` (`container-lifecycle.ts`) decides the session's GPU state before `docker create`, because a device request is part of `HostConfig`:

- **Switch off** → no request. State `off`.
- **Switch on** → create and start with the request. State `granted`.
- **Switch on, and that create or start fails** → remove the container, create and start it again without the request. State `unavailable`, with Docker's error as the reason (req 6).

The fallback runs on *any* failure of the GPU attempt, not on a matched error string. Docker's messages for a missing toolkit, a broken driver, a gVisor runtime without `nvproxy`, and a read-only rootfs the hook cannot write differ by host and version, and a list of them would turn the next unknown one into a session that cannot start — the one outcome req 6 forbids. The cost is one extra create when the start fails for a reason that is not the GPU; then the second attempt fails too and its error propagates as before, and the reason recorded for the first is the real error text, so a wrong attribution is visible.

The state is recorded on `SessionContainer.gpu` and, for the agent, in the container's environment: `SHIPIT_GPU=granted|unavailable|off` and, when unavailable, `SHIPIT_GPU_REASON`. After an orchestrator restart, adoption (`container-discovery.ts`) reads the state back from the container itself — `HostConfig.DeviceRequests` and that env — so the proxy and Compose keep the right answer across a ShipIt update without a label or a table.

### Warm-pool standbys (req 5)

A standby container is created before any session claims it, so one made before the switch flipped would give a new session the old answer. At claim time (`buildRunnerFactory`, `app-lifecycle.ts`) a standby whose GPU request disagrees with the switch is not claimed: the session takes the cold path and gets a fresh container. A non-standby container that is already running is not affected — that session is not new.

## Telling the user and the agent (req 6)

A `container_started` listener (`gpu-container-start.ts`, wired beside the egress one in `bootstrap-managers.ts`) acts when the container's state is `unavailable`:

- **User:** a persisted `warn` system notice in the transcript — "This session started without the GPU: …" — through the existing notice helpers (`emitNoticeInTurn` / `emitNoticePostTurn` / `persistNoticeUnattached`). No new card type.
- **Agent:** `appendPendingAgentNotice`, the one-time `[ShipIt]` prefix on the next turn that the data-retention sweep and the reroute notice use. The system prompt is untouched (prompt-cache contract); the env var is what a later turn reads.

The listener posts once per session and reason in this process, so a container recreated after idle reclaim does not repeat a notice the user already has. A changed reason, or a session that got the GPU in between, posts again.

## Compose services (req 3)

A service declares a GPU in standard Compose syntax — `deploy.resources.reservations.devices` with `capabilities: [gpu]`, or the service-level `gpus:` key. Both are checked on the resolved model (`validateServiceSettings`), in every mode:

- An entry is accepted only when it is a GPU request: `capabilities` names `gpu` (required in a reservation; Compose adds it for `gpus:`) and only NVIDIA's driver capabilities, `driver` is `nvidia` or absent, and there are no `options`. Anything else is refused, as every device reservation is today. `gpus` joins the classified fields.
- A plugin fragment cannot request a GPU: its own key list (`plugin-compose.ts` `ALLOWED_SERVICE_KEYS`) has neither `deploy` nor `gpus`. Req 3 names the project's services, so nothing changes there.

The snapshot rewrite (`rewriteResolvedModel`) then applies the session's state. **Granted:** the requests pass through, and Compose — running on the real socket, not through the proxy — creates the container with them. **Off or unavailable:** the rewrite deletes them and the service starts on the CPU, with a `[shipit]` line in that service's log saying why. That covers the switch-off case the same way req 6 covers the unavailable one: a project that declares a GPU still runs on a machine that cannot give it, instead of failing the whole file as it does today.

## Containers the agent starts (req 3)

`sanitizeContainerCreate` (`docker-proxy-sanitize.ts`) still refuses `Devices` and `DeviceCgroupRules`. `DeviceRequests` is accepted when the session's state is `granted` and every entry is a GPU request (the same rule as Compose: driver `""` or `nvidia`, capabilities naming `gpu`, no options). The proxy then **rebuilds** each entry from the four fields it checked, because Docker matches JSON keys case-insensitively and a nested `"driver"` the check never read would otherwise reach the daemon (`docker-proxy-field-casing.ts`; `Count`, `DeviceIDs` and `Capabilities` join its guarded fields). A refused request names why: no GPU access in this session, with the state's reason.

docs/172-agent-containment refuses device fields because a child keeps `CAP_MKNOD`, so a wider device cgroup is a device it can create. A GPU request widens the cgroup to the GPU's own devices, which is exactly the access the switch grants; nothing else is opened.

## What is not verified here

This repository's session containers have no GPU and no Docker CLI, so the tests drive fakes. Not yet checked on a real host: that the request starts a container on Docker Desktop/WSL2, on Docker Engine + the toolkit in WSL2, and on native Linux; that it works with `SESSION_READONLY_ROOTFS=1` and `SESSION_SECCOMP=1`; and what `docker compose config` writes for `gpus: all` (the check accepts both the string and the list form). The fallback means a failure on any of these leaves a session without the GPU, not a session that cannot start.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — `advanced.sessionGpu`.
- `src/server/orchestrator/session-gpu.ts` — the request, the state type, env, adoption read-back, the GPU-request check shared by Compose and the proxy.
- `src/server/orchestrator/container-lifecycle.ts` — request, fallback, state.
- `src/server/orchestrator/session-container.ts` — `gpuAccess` option, `gpuOutOfDate`.
- `src/server/orchestrator/container-discovery.ts` — state on adoption.
- `src/server/orchestrator/app-lifecycle.ts` — standby mismatch; proxy `SessionInfo.gpu`.
- `src/server/orchestrator/gpu-container-start.ts` — user and agent notices.
- `src/server/orchestrator/compose-generator.ts`, `service-manager.ts`, `service-manager-setup.ts` — Compose check, strip, log line.
- `src/server/orchestrator/docker-proxy-sanitize.ts`, `docker-proxy-field-casing.ts`, `docker-proxy-helpers.ts` — proxy.
- Docs: `src/server/shipit-docs/environment.md`, `compose.md`, `wiki/settings-and-accounts.md`, `deployment/README.md`.
