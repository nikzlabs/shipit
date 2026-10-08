---
issue: planning#664
title: GPU access for session containers — design
description: How an install-wide switch gives the machine's NVIDIA GPU to a session's agent container, its Compose services and the containers the agent starts, and how Chrome draws with it on WSL2.
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

Rejected as the way a container gets the device: mapping `/dev/dxg` by hand. It covers AMD and Intel through DirectX too, which the user ruled out (resolved question 2), it is WSL-only, and it is a second device path to secure. The `/usr/lib/wsl` directories are bound for a different reason, and only beside a granted request — see [Chrome on the GPU](#chrome-on-the-gpu-req-7).

The session image carries no CUDA toolkit. It does not need one: the hook brings the driver and `nvidia-smi`, and PyTorch's wheels bring their own CUDA runtime (req 2).

## The switch (req 5)

`advanced.sessionGpu` — a boolean in the settings catalogue (`global-settings.ts`), **off by default**, stored in the credential store like `advanced.enableSubAgents`. One declaration gives the Settings → Advanced toggle, `PUT /api/settings`, `shipit settings list/get`, and an agent proposal path; nothing else on the client changes. It sits beside the memory budget, the other row about the install rather than about a session's agent.

The orchestrator reads it once per container creation through a `gpuAccess` closure that `bootstrap-managers.ts` gives `SessionContainerManager` (the same route `resolveEgressConfig` takes). A change applies to every container created after it. A running container keeps the state it started with until it is next created — so an existing session also gets the change at its next container start. That is a design choice, not something req 5 asks: re-creating every running container when the switch moves would restart work the user did not ask to restart.

## The agent container (req 1, 2, 6)

`createContainer` (`container-lifecycle.ts`) decides the session's GPU state before `docker create`, because a device request is part of `HostConfig`:

- **Switch off** → no request. State `off`.
- **Switch on** → create and start with the request. State `granted`.
- **Switch on, and that create or start fails** → remove the container, create and start it again without the request. State `unavailable`, with Docker's error as the reason (req 6).

The GPU attempt's container id is not published to `sc.id` until it starts, so a failed start cannot read as the session's container exiting to the health monitor (`container-health.ts` ignores an event whose id is not `sc.id`). The attempt's id is held separately until the container is removed, and the create's failure cleanup removes it too if the first removal failed.

The fallback runs on *any* failure of the GPU attempt, not on a matched error string. Docker's messages for a missing toolkit, a broken driver, a gVisor runtime without `nvproxy`, and a read-only rootfs the hook cannot write differ by host and version, and a list of them would turn the next unknown one into a session that cannot start — the one outcome req 6 forbids. The cost is one extra create when the start fails for a reason that is not the GPU; then the second attempt fails too and its error propagates as before, and the reason recorded for the first is the real error text, so a wrong attribution is visible.

The state is recorded on `SessionContainer.gpu` and, for the agent, in the container's environment: `SHIPIT_GPU=granted|unavailable|off` and, when unavailable, `SHIPIT_GPU_REASON`. After an orchestrator restart, adoption (`container-discovery.ts`) reads the state back from the container itself — `HostConfig.DeviceRequests` and that env — so the proxy and Compose keep the right answer across a ShipIt update without a label or a table.

### Warm-pool standbys (req 5)

A standby container is created before any session claims it, so one made before the switch flipped would give a new session the old answer. At claim time (`buildRunnerFactory`, `app-lifecycle.ts`) a standby whose GPU request disagrees with the switch is not claimed: the session takes the cold path and gets a fresh container. A non-standby container that is already running is not affected — that session is not new.

The check reads `SessionContainer.standbyUnclaimed`, set when the container is created with the standby label and cleared by `claimStandby`, not the manager's standby set: `createStandby` registers the standby only after the create returns, and the create marks the container `running` one await before that, so a claim can land in between.

## Telling the user and the agent (req 6)

A `container_started` listener (`gpu-container-start.ts`, wired beside the egress one in `bootstrap-managers.ts`) acts when the container's state is `unavailable`:

- **User:** a persisted `warn` system notice in the transcript — "This session started without the GPU: …" — as a final row (`emitNoticePostTurn`, or `persistNoticeUnattached` with no runner). Not `emitNoticeInTurn`: a turn's setup runs `resetRunnerTurnState` after `running` is already true, which drops cards recorded in that window. No new card type.
- **Agent:** `appendPendingAgentNotice`, the one-time `[ShipIt]` prefix on the next turn that the data-retention sweep and the reroute notice use. The system prompt is untouched (prompt-cache contract); the env var is what a later turn reads.

The listener posts once per session and reason in this process, so a container recreated after idle reclaim does not repeat a notice the user already has. Each audience is recorded only once its write succeeded, so a failed write is tried at the next start. A changed reason, or a session that got the GPU in between, posts again.

**Known limit:** an interactive turn consumes pending agent notices while it builds its prompt, before it waits for the worker. A first message sent while a cold container is still starting can therefore go out without the notice, and the agent reads it on the next turn. The user's notice is not affected, and `$SHIPIT_GPU` is in the container from the start. Moving that consumption after the worker wait would change the path every pending notice takes, for one turn's delay.

## Compose services (req 3)

A service declares a GPU in standard Compose syntax — `deploy.resources.reservations.devices` with `capabilities: [gpu]`, or the service-level `gpus:` key. Both are checked on the resolved model (`validateServiceSettings`), in every mode:

- An entry is accepted only when it is a GPU request: `capabilities` names `gpu` (required in a reservation; Compose adds it for `gpus:`) and only NVIDIA's driver capabilities, `driver` is `nvidia` or absent, and there are no `options`. Anything else is refused, as every device reservation is today. `gpus` joins the classified fields. A `gpus:` entry's `capabilities` get an implicit `gpu`, because Compose adds it when it creates the container; a reservation must name it.
- A plugin fragment cannot request a GPU: its own key list (`plugin-compose.ts` `ALLOWED_SERVICE_KEYS`) has neither `deploy` nor `gpus`. Req 3 names the project's services, so nothing changes there.

The snapshot rewrite (`rewriteResolvedModel`) then applies the session's state. When a service asks for a GPU, `ServiceManager.prepareStart` first awaits the agent container's decision (`SessionContainerManager.gpuDecision`, which resolves at that container's `container_started`, or after two minutes with no state): without overlays, Compose starts without waiting for the worker, and would otherwise read an undecided state as no GPU. A project that asks for no GPU does not wait. **Granted:** the requests pass through, and Compose — running on the real socket, not through the proxy — creates the container with them. **Off or unavailable:** the rewrite deletes them and the service starts on the CPU, with a `[shipit]` line in that service's log saying why. Req 6 decides the unavailable case. The switch-off case is a design choice the requirements do not make: applying the same rule there means a project that declares a GPU still runs on a machine that cannot give it, instead of failing the whole file as it did before this feature.

## Containers the agent starts (req 3)

`sanitizeContainerCreate` (`docker-proxy-sanitize.ts`) still refuses `Devices` and `DeviceCgroupRules`. `DeviceRequests` is accepted when the session's state is `granted` and every entry is a GPU request (the same rule as Compose: driver `""` or `nvidia`, capabilities naming `gpu`, no options). The proxy then **rebuilds** each entry from the four fields it checked, because Docker matches JSON keys case-insensitively and a nested `"driver"` the check never read would otherwise reach the daemon (`docker-proxy-field-casing.ts`; `Count`, `DeviceIDs` and `Capabilities` join its guarded fields). A refused request names why: no GPU access in this session, with the state's reason.

docs/172-agent-containment refuses device fields because a child keeps `CAP_MKNOD`, so a wider device cgroup is a device it can create. A GPU request widens the cgroup to the GPU's own devices, which is exactly the access the switch grants; nothing else is opened.

## Chrome on the GPU (req 7)

### What was missing

Measured on 2026-10-08 in a `granted` session container on Docker Desktop/WSL2 (an RTX 4090, Windows driver 595.79). The GPU request gives a container the device and CUDA. OpenGL needs two more things from the host, and it got neither:

- **Chrome can use the system's Mesa.** Its default renderer is SwiftShader. Under Xvfb with `--use-angle=gl --ignore-gpu-blocklist` it reports `ANGLE (Mesa/X.org, llvmpipe …)`, in full Chrome and in the headless shell. Without a display it stays on SwiftShader, whatever the flags: its route to Mesa is GLX.
- **Mesa tries its D3D12 driver first and falls back to `llvmpipe`.** The image's Mesa (22.3.6, a dependency of Xvfb) opens `libdxcore.so`, which the hook mounts, and `libd3d12.so`, which it does not.
- **With `libd3d12.so` and `libd3d12core.so` on the loader path, D3D12 finds the card and then misses its driver.** It reads the NVIDIA adapter through `/dev/dxg` and opens `/usr/lib/wsl/drivers/nv_dispi.inf_amd64_…/libnvwgf2umx.so`, the card's Direct3D user-mode driver. The hook mounts eight files from that directory, for CUDA and `nvidia-smi`, and this is not one of them.

So a container needs the DirectX runtime in `/usr/lib/wsl/lib` and the whole driver store in `/usr/lib/wsl/drivers`.

### The mechanism

1. **Two read-only binds** — `gpuGraphicsBinds()` (`session-gpu.ts`) gives those two directories at their own paths, where D3D12 looks for them. No setting and no GPU state is new (req 5): the binds follow the request.
2. **Two links in the worker images** — `libd3d12.so` and `libd3d12core.so`, from `/usr/lib/wsl/lib` into `/usr/lib`. Mesa and DirectX open them by bare name. `/usr/lib` is in the loader's built-in path, and it is not the multiarch directory the hook mounts into, so a later hook that mounts one of them cannot meet a link there. Off WSL2 the links dangle and Mesa falls back to `llvmpipe`, as before.
3. **Xvfb and xauth, installed by name** — they were in the image only as dependencies of Playwright, and the documented way to start Chrome now depends on them.

**The binds are an attempt of their own** (`startWithGpu`, `container-lifecycle.ts`). A container that has the GPU today must not lose it to two mounts that could not be tried on a real host before they shipped. So the order is: the request with the binds; if that create or start fails, the request alone; if that fails too, no request — the fallback of req 6, unchanged, and with the second failure as its reason. A container that started on the middle step is `granted`, and `SHIPIT_GPU_GRAPHICS_REASON` in its environment holds Docker's error for the first, so the agent can say why Chrome is on the CPU. The cost is one more failed attempt at each container start on a WSL2 host whose GPU does not work at all.

**The binds are for WSL2 only**, decided from the kernel release (`os.release()` names `microsoft` or `wsl`). The orchestrator and the session containers run on one Docker host, so they share a kernel — verified by observation: a session container reports `…-microsoft-standard-WSL2`. A forwarded Docker socket to another machine would break that, and so would a custom WSL2 kernel with neither word in its name; both leave a session as it is today. They are `Binds`, not `Mounts`: where the daemon can write, Docker creates a bind source that does not exist, and a `Mounts` entry always fails the create. That is also why the kernel is checked — off WSL2 every GPU host would get two empty directories, or one more failed attempt.

Rejected for the loader path: `LD_LIBRARY_PATH` in the container's environment, which is what Microsoft's sample uses — one command that sets its own value loses the GPU with no message. And an `ld.so.conf.d` entry — the cache must be rebuilt after the bind exists, which a read-only rootfs cannot do.

### What the answers leave out

The resolved questions of 2026-10-08 keep req 7 to a Chrome the agent starts, WebGL, and the agent's container on WSL2. So:

- **The built-in browser** (`playwright-mcp.ts`) is unchanged and draws in software. It has no display, and a fault in the GPU path would reach every browser check of every GPU session.
- **Compose services and containers the agent starts** get no binds. The Compose rewrite and the proxy would each have to add a host path to a container they do not own the image of.
- **Native Linux** is unchanged: the request names `gpu` only, so the hook mounts no graphics libraries.
- **WebGPU** needs Vulkan, and the image has no Vulkan driver for the card.

Two side effects, where the path works. Every OpenGL program that uses Mesa in a granted WSL2 container draws on the GPU, not only Chrome; `LIBGL_ALWAYS_SOFTWARE=1` is the way back, and `environment.md` says so. And the driver store holds the drivers of every adapter of the machine, so Mesa can also reach an integrated Intel or AMD adapter that the device already exposed. That is not required (resolved question 2) and not tested; `MESA_D3D12_DEFAULT_ADAPTER_NAME` selects the adapter.

## What is not verified here

The tests drive fakes. One real host was observed on 2026-10-08, Docker Desktop with the WSL 2 backend: a session container created with the switch on has `SHIPIT_GPU=granted`, and `nvidia-smi` lists the card. Not yet checked: Docker Engine + the toolkit in WSL2, and native Linux; `SESSION_READONLY_ROOTFS=1` and `SESSION_SECCOMP=1`; and what `docker compose config` writes for `gpus: all` (the check accepts both the string and the list form). The fallback means a failure on any of these leaves a session without the GPU, not a session that cannot start.

For req 7, each step up to the driver load was run in that container. The last step could not be, because the driver file is only on the host. Not yet checked:

- That with the two binds Mesa reports `D3D12 (…)`, and that Chrome draws with it. Until then req 7 is built, not met, and `environment.md` and the wiki say so to the agent.
- That a container starts with the binds, and that CUDA still works in it. The hook mounts its eight files into `/usr/lib/wsl/drivers/<store>/`, which is then already a read-only mount. Microsoft's WSLg container sample (`samples/container/Containers.md`) runs `--gpus all` with `-v /usr/lib/wsl:/usr/lib/wsl` — the same paths, but a writable bind, so it does not settle the read-only case. If the start fails, the container starts with the GPU alone and `SHIPIT_GPU_GRAPHICS_REASON` says why.
- The image's half: that the two links resolve in a built image and that Mesa follows them. In the measurement the libraries were on `LD_LIBRARY_PATH`.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — `advanced.sessionGpu`.
- `src/server/orchestrator/session-gpu.ts` — the request, the state type, env, adoption read-back, the GPU-request check shared by Compose and the proxy, the WSL2 graphics binds.
- `src/server/orchestrator/container-lifecycle.ts` — request, fallback, state, the graphics attempt.
- `docker/Dockerfile.session-worker.prod`, `Dockerfile.session-worker.dev` — the DirectX links, Xvfb; `session-gpu-dockerfiles.test.ts` keeps them on the bound directory.
- `src/server/orchestrator/session-container.ts` — `gpuAccess` option, `standbyGpuOutOfDate`, `gpuDecision`.
- `src/server/orchestrator/container-discovery.ts` — state on adoption.
- `src/server/orchestrator/app-lifecycle.ts` — standby mismatch; proxy `SessionInfo.gpu`.
- `src/server/orchestrator/gpu-container-start.ts` — user and agent notices.
- `src/server/orchestrator/compose-generator.ts`, `service-manager.ts`, `service-manager-setup.ts` — Compose check, strip, log line.
- `src/server/orchestrator/docker-proxy-sanitize.ts`, `docker-proxy-field-casing.ts`, `docker-proxy-helpers.ts` — proxy.
- Docs: `src/server/shipit-docs/environment.md`, `compose.md`, `wiki/settings-and-accounts.md`, `wiki/installing-and-updating.md`, `deployment/README.md`.
