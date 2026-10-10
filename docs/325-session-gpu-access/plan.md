---
issue: planning#664
title: GPU access for session containers — design
description: How an install-wide switch gives the machine's NVIDIA GPU to a session's agent container, its Compose services and the containers the agent starts, and how Chrome and the built-in browser draw with it on WSL2.
---

# 325 — GPU access for session containers: design

**Requirements:** [`requirements.md`](./requirements.md). Numbers like (req 3) refer to entries there.

## Intent

A user who runs ShipIt in WSL2 (or on Linux) on a machine with an NVIDIA GPU wants the code their agent runs to use it: `nvidia-smi`, PyTorch with CUDA, a model server in the project's Compose file. Before this feature nothing in a session could: the agent container got no devices, Compose refused every device reservation, and the Docker proxy refused `DeviceRequests`.

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
4. **A pointer in the agent's prompt** — `prompts/skeleton.md`, in "Browser access": when the built-in browser draws on the GPU, and that the steps for a Chrome on the GPU are in `environment.md`. Before it, the prompt named only the built-in browser, and it listed `environment.md` with no word about the GPU. The text is the same in every session, so no prompt variant is new; the agent reads `$SHIPIT_GPU` when it needs to know. A notice at each start of a granted container was rejected: most tasks do not use the GPU.

**The binds are an attempt of their own** (`startWithGpu`, `container-lifecycle.ts`). A container that has the GPU must not lose it to two mounts, and they are measured on one kind of host only ([Measured on the host](#measured-on-the-host)). So the order is: the request with the binds; if that create or start fails, the request alone; if that fails too, no request — the fallback of req 6, unchanged, and with the second failure as its reason. A container that started on the middle step is `granted`, and `SHIPIT_GPU_GRAPHICS_REASON` in its environment holds Docker's error for the first, so the agent can say why Chrome is on the CPU. The cost is one more failed attempt at each container start on a WSL2 host whose GPU does not work at all.

**The binds are for WSL2 only**, decided from the kernel release (`os.release()` names `microsoft` or `wsl`). The orchestrator and the session containers run on one Docker host, so they share a kernel — verified by observation: a session container reports `…-microsoft-standard-WSL2`. A forwarded Docker socket to another machine would break that, and so would a custom WSL2 kernel with neither word in its name; both leave a session as it is today. They are `Binds`, not `Mounts`: where the daemon can write, Docker creates a bind source that does not exist, and a `Mounts` entry always fails the create. That is also why the kernel is checked — off WSL2 every GPU host would get two empty directories, or one more failed attempt.

Rejected for the loader path: `LD_LIBRARY_PATH` in the container's environment, which is what Microsoft's sample uses — one command that sets its own value loses the GPU with no message. And an `ld.so.conf.d` entry — the cache must be rebuilt after the bind exists, which a read-only rootfs cannot do.

### What the answers leave out

The resolved questions of 2026-10-08 keep req 7 to a Chrome the agent starts, WebGL, and the agent's container on WSL2. So:

- **The built-in browser** was left out, and drew in software, until the user asked for it on 2026-10-10: see [The built-in browser, and a browser with no display](#the-built-in-browser-and-a-browser-with-no-display-req-8-to-11).
- **Compose services and containers the agent starts** get no binds. The Compose rewrite and the proxy would each have to add a host path to a container they do not own the image of.
- **Native Linux** is unchanged: the request names `gpu` only, so the hook mounts no graphics libraries.
- **WebGPU** needs Vulkan, and the image has no Vulkan driver for the card.

Two side effects, where the path works. Every OpenGL program that uses Mesa in a granted WSL2 container draws on the GPU, not only Chrome; `LIBGL_ALWAYS_SOFTWARE=1` is the way back, and `environment.md` says so. And the driver store holds the drivers of every adapter of the machine, so Mesa can also reach an integrated Intel or AMD adapter that the device already exposed. That is not required (resolved question 2) and not tested; `MESA_D3D12_DEFAULT_ADAPTER_NAME` selects the adapter.

### Measured on the host

Measured on 2026-10-09 in a session container created after the update, on the host of the first measurement: Docker Desktop/WSL2, an RTX 4090, Windows driver 595.79, Mesa 22.3.6, Chromium 153 (Playwright build 1243).

- **The container started on the first attempt.** `SHIPIT_GPU=granted` and no `SHIPIT_GPU_GRAPHICS_REASON`. Both binds are read-only, and the hook put its eight files on top of the read-only driver store. `nvidia-smi` lists the card, and `cuInit` returns 0 with one device.
- **The links resolve, with no `LD_LIBRARY_PATH`.** A GLX program under Xvfb reports `D3D12 (NVIDIA GeForce RTX 4090)`. `LD_DEBUG=files` shows `libd3d12.so` and `libd3d12core.so` from `/usr/lib`, `libdxcore.so` from the hook's mount, and `libnvwgf2umx.so` from the driver store.
- **Chrome reports `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL 4.2)`** under Xvfb with the two flags: full Chrome headless and headed, and the headless shell. Three at one time all got it.
- **The GPU does the work.** A 1024×1024 fragment shader with 400 loop iterations for each pixel took 1.2 ms for each frame on D3D12, 16 ms on `llvmpipe` and 123 ms on SwiftShader. The pictures are not identical: the shape covers 235,114 pixels on the GPU and 235,160 on each CPU renderer, and the three checksums differ. So a pixel comparison across renderers is not exact.
- **The built-in browser reported SwiftShader** in that container. Req 8 changed that later.

What each part of the start command does, from the same runs:

| Display | Flags | Headless Chrome | Headed Chrome |
|---|---|---|---|
| Xvfb | `--use-angle=gl --ignore-gpu-blocklist` | D3D12 (the card) | D3D12 (the card) |
| Xvfb | `--use-angle=gl` | D3D12 (the card) | — |
| Xvfb | `--ignore-gpu-blocklist`, or none | SwiftShader | D3D12 (the card) |
| none | both | SwiftShader | — |
| Xvfb, `LIBGL_ALWAYS_SOFTWARE=1` | both | `llvmpipe` | `llvmpipe` |
| Xvfb, `LIBGL_ALWAYS_SOFTWARE=1` | `--use-angle=gl` | no WebGL context | — |
| Xvfb, `LIBGL_ALWAYS_SOFTWARE=1` | none | — | SwiftShader |

A dash is a case that was not run. Headed Chrome selects Mesa by itself; headless Chrome needs `--use-angle=gl`. The rows with `LIBGL_ALWAYS_SOFTWARE=1` are why `environment.md` gives both flags for each start: Chrome's blocklist refuses `llvmpipe`, so without the second flag a container that lost the mounts shows no WebGL or SwiftShader, and not the renderer that says why.

## The built-in browser, and a browser with no display (req 8 to 11)

### One library gives both

Chrome with no display stayed on SwiftShader for one reason. Its route to Mesa with no display is EGL, and the image had only Mesa's GLX, which came with Xvfb. `libegl1` adds Mesa's EGL over the same Direct3D 12 driver: three small packages (`libegl1`, `libegl-mesa0`, `libwayland-client0`). With it, `--use-angle=gl-egl` reaches the card with no display and no environment variable (req 9). The built-in browser uses the same library (req 8), so it needs no virtual display.

The library is in the loader's normal path, so that the flags are sufficient. That is the user's choice, and it makes the one exception of req 10: see [A session with no GPU](#a-session-with-no-gpu-req-10).

### The built-in browser's start

`builtInBrowserUsesGpu` (`playwright-mcp.ts`) decides once for the container, when the module loads: `$SHIPIT_GPU` is `granted`, and `/usr/lib/libd3d12.so` resolves. That is the image's link, and it resolves only where `gpuGraphicsBinds` mounted DirectX. No setting is read (req 8). A container keeps its GPU state and its mounts for life, so the answer cannot become stale.

When both hold, the start command gets two additions:

- **`--config playwright-mcp-gpu.json`** — the server takes browser flags from a config file only. The file holds three:
  - `--use-angle=gl-egl` selects Mesa through EGL.
  - `--disable-gpu-compositing` keeps the page's composition in software, as it was. The GPU then draws WebGL and nothing else (req 11).
  - `--ignore-gpu-blocklist` — without it, a renderer that Chromium's blocklist refuses gives no WebGL context at all, not software.
- **`GALLIUM_DRIVER=d3d12`** in the server's environment. Mesa then tries Direct3D 12 and nothing else. Without the pin, a GPU fault makes Mesa draw on the CPU (`llvmpipe`), a third kind of picture. With it, EGL fails to start and Chromium goes back to SwiftShader, with pictures identical to those of a session with no GPU.

In each other container, the command is the one from before this change, byte for byte (req 10). A test holds it to that.

| The container has | Renderer of the built-in browser | Its pictures |
|---|---|---|
| The GPU, the DirectX mounts, the EGL library | D3D12 (the card) | A page with no WebGL: identical to software. WebGL: drawn by the GPU |
| The same, but the card's driver cannot start | SwiftShader | Identical to software |
| The same, but no EGL library — a container of an image older than this change | SwiftShader | Identical to software |
| No GPU, or a host that is not WSL2 | SwiftShader, from the old command | Identical to software |

The server is still the process that `sh` becomes, and Chromium is still its child, so `browser-reclaim.ts` finds the browser as before.

Rejected:

- **A virtual display for the built-in browser.** It works (D3D12 through GLX). But each server gets one more process, an Xvfb of 64 to 90 MB, and a display that is not there gives no WebGL context at all, so the start would need a fallback of its own.
- **The library in a private directory.** It makes no exception to req 10, but each browser then needs two environment variables, and the build must keep the extracted versions equal to Mesa's.
- **A setting**, for the install or for a repository, and **the GPU for the whole page**: the user's decisions (resolved questions of 2026-10-10). With the GPU for the whole page, 51 % of the pixels of a page with no WebGL changed.

### A session with no GPU (req 10)

The built-in browser of such a session starts with the old command. The library is in its image, though. Measured in an imitation of a container with no GPU — DirectX libraries that cannot load — with and without the library:

| Chromium started with | Without the library | With the library |
|---|---|---|
| Default flags, `--use-gl=egl`, `--enable-gpu --ignore-gpu-blocklist`, or `--use-angle=vulkan` | SwiftShader | SwiftShader |
| `--use-angle=gl-egl --ignore-gpu-blocklist` | SwiftShader | `llvmpipe` |
| `--use-angle=gl-egl` | SwiftShader | No WebGL context |

The last two rows are the exception that the user accepted. `--use-angle=gl` on an X display already behaves like this. Other programs that use EGL now find Mesa where they found no library.

### Known limits

- **Pictures of WebGL content change.** In the test page, 21 % of the pixels differed from SwiftShader's, 87 of them by more than 16 levels of 255. The way back for the built-in browser is the GPU access switch. For one software picture in a GPU session, the agent starts its own Chrome with default flags; `environment.md` says so.
- **The reclaim of a browser that still renders measures CPU** (docs/315-browser-cpu-between-turns). On the GPU a WebGL page uses much less of it, so a light page can stay below the threshold and continue to draw on the GPU between turns. The page of the measurement stayed above it.
- **The first WebGL context is slower:** 22 to 106 ms in a browser that started a moment before, against 7 to 9 ms in software. In the session's own built-in browser, which was already in operation, it took 16 ms.
- **Each built-in browser uses about 50 MB more memory:** 291 to 295 MB against 243 to 246 MB for its process tree on `about:blank` with one WebGL context, and 288 to 292 MB against 237 to 239 MB with none. The browser's GPU process loads the card's driver when it starts.

The numbers in the last two items are from [the image that has the library](#measured-after-the-update-on-the-image-that-has-the-library). With the extracted packages the measurement before it gave 55 to 83 ms and about 80 MB.

### Measured for req 8 to 11

Measured on 2026-10-10 in a `granted` session container on the host of the earlier measurements: Docker Desktop/WSL2, an RTX 4090, Mesa 22.3.6, Chromium 153. The container's image had no EGL library, and the session had no root. So the three Debian packages (`libegl1` 1.6.0-1, `libegl-mesa0` 22.3.6-1+deb12u2, `libwayland-client0` 1.21.0-1) were extracted into scratch space and named with `LD_LIBRARY_PATH` and `__EGL_VENDOR_LIBRARY_DIRS`. "With the library" below means that.

- **A real `playwright-mcp`, started with the command that `playwright-mcp.ts` gives in that container, reports `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL ES 3.1)` on `about:blank`** with the library. Without the library it reports SwiftShader. In both cases its screenshot of a page with no WebGL (text, gradients, shadows, SVG, a 2D canvas, a blur filter) is byte-identical to the screenshot from the old command.
- **A Chromium with no display reports the card** with `--use-angle=gl-egl`, as full Chrome and as the headless shell. `--use-angle=gl` with no display stays on SwiftShader. `libgles2` is not necessary.
- **The pictures:** each renderer gave the same picture in two runs. The GPU's WebGL picture is the same through EGL and through GLX.
- **A page that draws WebGL frames continuously** (1024×768, 60 loop iterations for each pixel): SwiftShader 37 frames/s on 9.2 CPU cores; the GPU for WebGL only 60 frames/s on 0.33 cores; the GPU for the whole page 60 frames/s on 0.21 cores.
- **A driver that cannot start:** SwiftShader, and both pictures byte-identical to software. Two cases gave this: DirectX libraries that cannot load, with the pin, and `GALLIUM_DRIVER` set to a name that Mesa does not have.
- **Mesa on the CPU, without the pin:** `llvmpipe` with `--ignore-gpu-blocklist`, and no WebGL context without it.

### Measured after the update, on the image that has the library

Measured on 2026-10-10 on the same host, in a `granted` session container of an image built after this change. `ldconfig` lists `libEGL.so.1`, and the image has the three packages in the versions above. There was no display, no `LD_LIBRARY_PATH` and no extracted package. The browser is Chromium 153.0.8010.12, the server is `@playwright/mcp` 0.0.80.

- **The session's own built-in browser reports `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL ES 3.1)` on `about:blank`** (req 8). This is the browser that the Claude Code CLI started for the agent's browser tools. Its server has `GALLIUM_DRIVER=d3d12` and `--config` with the path of `playwright-mcp-gpu.json`. Its Chromium has the three flags. Its GPU process has `libEGL.so.1`, `libEGL_mesa.so.0`, `libd3d12.so`, `libd3d12core.so` and `libdxcore.so` loaded. The server is the CLI's direct child, and Chromium is the server's child.
- **A Chromium with no display and no environment variable reports the card** with `--use-angle=gl-egl --ignore-gpu-blocklist`, as full Chrome and as the headless shell (req 9). It also does so with `--use-angle=gl-egl` alone. With default flags, and with `--use-angle=gl`, it reports SwiftShader.
- **Pages with no WebGL keep their picture** (req 11). Three screenshots were compared: the page of the first measurement, and the viewport and the full page of a second page with 3D transforms, `will-change`, a backdrop filter, a blend mode, a clip path, a mask, a 640×300 2D canvas and an `OffscreenCanvas`. Each screenshot is byte-identical from five browsers: the session's built-in browser, a `playwright-mcp` with the GPU command, a `playwright-mcp` with the old command (SwiftShader), a Chromium with default flags (SwiftShader), and a Chromium with the three flags. Without `--disable-gpu-compositing`, 51 % and 50 % of the pixels of the two viewport screenshots changed.
- **The picture of a WebGL page** is byte-identical from the built-in browser and from each other browser on the card. It differs from SwiftShader's picture in 20.7 % of the pixels, 87 of them by more than 16 levels of 255.
- **A page that draws WebGL frames continuously** (the page of the first measurement): SwiftShader 42 frames/s on 9.1 CPU cores; the GPU for WebGL only 60 frames/s on 0.28 to 0.30 cores; the GPU for the whole page 60 frames/s on 0.18 cores.
- **One start was slow.** The first Chromium that the session started itself took 1.3 s for its first WebGL context. The 13 starts after it took 22 to 379 ms, and an empty shader cache did not bring the 1.3 s back. The cause was not found.

## What is not verified here

The tests drive fakes. One real host was observed, Docker Desktop with the WSL 2 backend: a session container created with the switch on has `SHIPIT_GPU=granted`, `nvidia-smi` lists the card, and req 7 holds ([Measured on the host](#measured-on-the-host)). Not yet checked: Docker Engine + the toolkit in WSL2, and native Linux; `SESSION_READONLY_ROOTFS=1` and `SESSION_SECCOMP=1`; and what `docker compose config` writes for `gpus: all` (the check accepts both the string and the list form). The fallback means a failure on any of these leaves a session without the GPU, not a session that cannot start.

For req 7, two cases are not checked. Docker Engine + the toolkit in WSL2 can treat the two binds differently from Docker Desktop: if the start fails there, the container starts with the GPU alone and `SHIPIT_GPU_GRAPHICS_REASON` says why. And no machine with a second adapter was tried: the image's Mesa has `MESA_D3D12_DEFAULT_ADAPTER_NAME`, but its effect was not seen, because this machine gives Mesa one adapter.

For req 8, 9 and 11, one host, one image and one agent CLI were observed after the update: Docker Desktop with the WSL 2 backend, and the built-in browser that Claude Code starts. The adapters of the other four CLIs take the same start command from the one constant `PLAYWRIGHT_MCP_ARGS`, but their built-in browsers were not observed.

For req 10, no real container with no GPU and no native Linux host was seen. Before the update both were imitated with DirectX libraries that cannot load. After the update, the old command ran in a `granted` container, where it reports SwiftShader with the library in the image. A session with GPU access off was not started, because the switch is the user's and it changes each new session of the install.

The claim that a page with no WebGL keeps its picture comes from three test pages: the two of the measurements, and one with more 2D canvas and `OffscreenCanvas` drawing that the independent review of the change ran.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — `advanced.sessionGpu`.
- `src/server/orchestrator/session-gpu.ts` — the request, the state type, env, adoption read-back, the GPU-request check shared by Compose and the proxy, the WSL2 graphics binds.
- `src/server/orchestrator/container-lifecycle.ts` — request, fallback, state, the graphics attempt.
- `docker/Dockerfile.session-worker.prod`, `Dockerfile.session-worker.dev` — the DirectX links, Xvfb, the EGL library; `session-gpu-dockerfiles.test.ts` keeps them on the bound directory.
- `src/server/session/agents/playwright-mcp.ts`, `playwright-mcp-gpu.json` — when the built-in browser draws on the GPU, and its start command and flags.
- `src/server/orchestrator/session-container.ts` — `gpuAccess` option, `standbyGpuOutOfDate`, `gpuDecision`.
- `src/server/orchestrator/container-discovery.ts` — state on adoption.
- `src/server/orchestrator/app-lifecycle.ts` — standby mismatch; proxy `SessionInfo.gpu`.
- `src/server/orchestrator/gpu-container-start.ts` — user and agent notices.
- `src/server/orchestrator/prompts/skeleton.md` — the pointer from "Browser access" to the Chrome steps.
- `src/server/orchestrator/compose-generator.ts`, `service-manager.ts`, `service-manager-setup.ts` — Compose check, strip, log line.
- `src/server/orchestrator/docker-proxy-sanitize.ts`, `docker-proxy-field-casing.ts`, `docker-proxy-helpers.ts` — proxy.
- Docs: `src/server/shipit-docs/environment.md`, `compose.md`, `wiki/settings-and-accounts.md`, `wiki/installing-and-updating.md`, `deployment/README.md`.
