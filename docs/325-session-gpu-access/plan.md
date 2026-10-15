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

When both hold, the start command gets these additions:

- **`--config playwright-mcp-gpu.json`** — the server takes browser flags from a config file only. The file holds three:
  - `--use-angle=gl-egl` selects Mesa through EGL.
  - `--disable-gpu-compositing` keeps the page's composition in software, as it was. The GPU then draws WebGL and nothing else (req 11).
  - `--ignore-gpu-blocklist` — without it, a renderer that Chromium's blocklist refuses gives no WebGL context at all, not software.
- **`GALLIUM_DRIVER=d3d12`** in the server's environment. Mesa then tries Direct3D 12 and nothing else. Without the pin, a GPU fault makes Mesa draw on the CPU (`llvmpipe`), a third kind of picture. With it, EGL fails to start and Chromium goes back to SwiftShader, with pictures identical to those of a session with no GPU.
- **`GLIBC_TUNABLES`** in the server's environment, added for req 12: see [Uploads of texture and buffer data](#uploads-of-texture-and-buffer-data-req-12).

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
- **Each load compiles its shaders again.** Mesa's Direct3D 12 driver reports no program binary format and wrote nothing to Mesa's shader cache, so the browser has no linked program to keep on this route. A test page with 200 different programs took 4.5 to 5.1 s to link them on a first load (7.4 s in one browser of six) and 3.3 to 4.5 s on a reload. In software the reload links them in 0.13 to 0.15 s. The first draws of the 200 programs took 6.9 to 8.9 s more, on each load. The browser's GPU process used about one CPU core for all of it, almost all on its main thread. Two later browsers, which ran while other processes used the CPUs of the host, took about 1.5 times as long. None of the flags, environment variables and Mesa versions that were tried removed the repeat: see [Measured: shader compile on the GPU route](#measured-shader-compile-on-the-gpu-route).
- **The first WebGL context is slower.** A Chromium with the built-in browser's three flags and the pin, which makes the context immediately after its start, took 22 to 106 ms in six starts, against 7 to 9 ms in software. The session's own built-in browser, which was already in operation, took 16 ms. A Chromium with the GPU for the whole page took 171 to 379 ms.
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

Measured on 2026-10-10 on the same host, in a `granted` session container of an image built after this change. `/sbin/ldconfig -p` lists `libEGL.so.1`, and the image has the three packages in the versions above. There was no display, no `LD_LIBRARY_PATH` and no extracted package. The browser is Chromium 153.0.8010.12, the server is `@playwright/mcp` 0.0.80.

- **The session's own built-in browser reports `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL ES 3.1)` on `about:blank`** (req 8). This is the browser that the Claude Code CLI started for the agent's browser tools. Its server has `GALLIUM_DRIVER=d3d12` and `--config` with the path of `playwright-mcp-gpu.json`. Its Chromium has the three flags. Its GPU process has `libEGL.so.1`, `libEGL_mesa.so.0`, `libd3d12.so`, `libd3d12core.so` and `libdxcore.so` loaded. The server is the CLI's direct child, and Chromium is the server's child.
- **A Chromium with no display and no environment variable reports the card** with `--use-angle=gl-egl --ignore-gpu-blocklist`, as full Chrome and as the headless shell (req 9). It also does so with `--use-angle=gl-egl` alone. With default flags, and with `--use-angle=gl`, it reports SwiftShader.
- **Pages with no WebGL keep their picture** (req 11). Three screenshots were compared: the page of the first measurement, and the viewport and the full page of a second page with 3D transforms, `will-change`, a backdrop filter, a blend mode, a clip path, a mask, a 640×300 2D canvas and an `OffscreenCanvas`. Each screenshot is byte-identical from five browsers: the session's built-in browser, a `playwright-mcp` with the GPU command, a `playwright-mcp` with the old command (SwiftShader), a Chromium with default flags (SwiftShader), and a Chromium with the three flags. Without `--disable-gpu-compositing`, 51 % and 50 % of the pixels of the two viewport screenshots changed.
- **The picture of a WebGL page** is byte-identical from the built-in browser and from each other browser on the card. It differs from SwiftShader's picture in 20.7 % of the pixels, 87 of them by more than 16 levels of 255.
- **A page that draws WebGL frames continuously** (the page of the first measurement): SwiftShader 42 frames/s on 9.1 CPU cores; the GPU for WebGL only 60 frames/s on 0.28 to 0.30 cores; the GPU for the whole page 60 frames/s on 0.18 cores.
- **One start was slow.** The first Chromium that the session started itself took 1.3 s for its first WebGL context. It had the GPU for the whole page. The seven starts of that kind after it took 171 to 379 ms, and an empty shader cache did not bring the 1.3 s back. The cause was not found.
- **A second agent repeated part of this.** The independent review ran in the same container on the Codex CLI. It got the same renderers from a Chromium with no display, the same screenshot hashes from a default and a three-flag Chromium, the same pixel counts, and 245 against 294 MB of memory. It had no browser tools, so it observed no built-in browser of its own.
- **The check of the library needs the full path in some shells.** The reviewer's shell (the Codex CLI) had no `/sbin` in its `PATH`, so `ldconfig` was not found there, and `ldconfig -p | grep libEGL` then prints nothing, as it does when the library is absent. `environment.md` now gives `/sbin/ldconfig`.

### Measured: shader compile on the GPU route

Measured on 2026-10-11 on the same host, in a `granted` session container of the image that has the library: Docker Desktop/WSL2, an RTX 4090, Mesa 22.3.6, Chromium 153. The host's load average was 2 to 13 during the runs. A session of another repository asked the question. It reported that its three.js page compiled for about 15 s on each load in the built-in browser, and it asked if ShipIt can change that. None of the configurations below removed the repeated cost. That page itself was not run.

**The test page** links 200 different programs. Their sources are the 35 shader pairs that three.js 0.186.1 generates for a scene with its usual materials, lights and shadows: 4 to 104 kB of source for each pair. Each program gets a different constant, so no two are the same. The page measures two times: the link, from the first `linkProgram` to the last answer for `LINK_STATUS`, and the first draws, from the first draw with each program to a `readPixels` after the last. Each browser is a new Chromium, started through Playwright. It runs the page four times: a first load, two reloads with the same shaders, and one reload with different shader sources, which that browser did not have before. A row with more than one browser gives the range of them.

| Chromium started with | Link, first load | Link, reload with the same shaders | First draws of the 200 programs |
|---|---|---|---|
| Default flags (SwiftShader), 2 browsers | 6.3 to 6.8 s | 0.13 to 0.15 s | 8.2 to 8.7 s, then 15.1 to 15.5 s on the reload |
| The built-in browser's three flags and the pin, 6 browsers | 4.5 to 5.1 s, and 7.4 s in one browser | 3.3 to 4.5 s | 6.9 to 8.9 s |
| The same, and `MESA_SHADER_CACHE_DISABLE=true` | 4.7 s | 3.4 to 3.5 s | 7.0 to 7.2 s |
| The same, and `MESA_SHADER_CACHE_DIR` on an empty directory, 2 browsers one after the other | 4.5 s | 3.3 to 3.7 s | 7.0 to 8.1 s |
| The same, and `--disable-gpu-program-cache` | 4.5 s | 3.7 to 3.8 s | 7.6 to 11.1 s |
| The three flags, no pin | 4.5 s | 3.6 s | 6.9 to 7.3 s |
| The GPU for the whole page (no `--disable-gpu-compositing`) | 6.9 s | 3.5 to 3.6 s | 7.4 to 10.3 s |
| The three flags and the pin, on Mesa 25.0.7 | 4.4 s | 3.4 s | 6.6 to 7.3 s |
| The three flags, and `GALLIUM_DRIVER=llvmpipe` | 5.3 s | 0.39 to 0.43 s | 43 to 49 s, then 0.17 to 0.19 s on the reload |

On the rows with the card, the reload with different sources linked in 4.4 to 5.1 s. So the smaller time of a reload with the same shaders depends on the sources. It is there with the browser's program cache on and off, and its cause was not examined.

- **The driver reports no program binary format.** `GL_NUM_PROGRAM_BINARY_FORMATS` is 0 on Mesa's Direct3D 12 driver and 1 on `llvmpipe`, in 22.3.6 and in 25.0.7. With no format, a linked program cannot be read back from the driver. With `--disable-gpu-program-cache`, the reload linked in 3.7 to 3.8 s, which is in the range of the row above it. The `llvmpipe` row is the control: the same Mesa, the same EGL and the same browser back end, a driver that reports one format, and a reload that links in 0.4 s.
- **The driver wrote nothing to Mesa's shader cache.** With `MESA_SHADER_CACHE_DIR` on an empty directory, the Direct3D 12 driver left 0 files there: from the browser on 22.3.6, and from Mesa with no browser on 22.3.6 and on 25.0.7. `llvmpipe` left 601 files, and a second process then compiled and linked the 200 programs in 0.24 s against 3.2 s. `llvmpipe` in the browser wrote the default directory also, so the directory was not the obstacle.
- **Mesa with no browser has the same cost.** A script that calls EGL and OpenGL ES directly, with the same sources, took on average 14 to 19 ms to compile and link a program and 32 to 37 ms for its first draw (six runs, 50 to 400 programs). The average did not change with the count. Each new process with the same shaders paid the first draws again. Four runs of this script on 22.3.6 ended with a crash. Two of them left no result and are not in these numbers. The script does not destroy its EGL context. In the second pass, with 20 programs, two of nine runs on 25.0.7 ended with a crash at their exit (`corrupted double-linked list`), after their result line. The nine runs on the card with 22.3.6 did not.
- **In that script, the link is Mesa's compiler and the first draws are the card's driver.** A sampler read the instruction pointer of the script's main thread each 2 ms in one run, with `GALLIUM_THREAD=0` so that the driver's work is on that thread. In the compile and the link, 69 to 72 % of the samples were in Mesa and 27 to 31 % in the C library. In the first draws, 58 % were in `libnvidia-gpucomp.so` and 27 % in `libnvwgf2umx.so`, which are NVIDIA's compiler and NVIDIA's Direct3D driver, and 6 % in Mesa. The sampler reads the innermost function only, so the C library's share has no caller. No browser process was sampled.
- **In the browser it is about one CPU core, on the main thread of the GPU process.** On the rows with the card, the CPU time of that process was within 0.2 s of the elapsed time of each run of the page. In two browsers the time of each thread was read: the main thread had 82 to 99 % of it, and Mesa's driver thread had about 2 s in two of the eight runs.
- **A page that animates got few frames during the link.** The test page sends all its programs and then asks for `LINK_STATUS` of each one. It waits there, and no animation frame ran during the link. A page that asks for `LINK_STATUS` later was not tried. The route lists `KHR_parallel_shader_compile`, and SwiftShader does not. When the page drew nothing in its frames and waited on `COMPLETION_STATUS_KHR` between them, about 60 frames ran each second while it had sent 128 programs or fewer, or when it sent 200 programs in groups of 25 to 100. With 129 or more sent at once, its first `COMPLETION_STATUS_KHR` call took almost all of the link, and one or two frames ran. That limit is a count, not a size of source. When the page drew into its canvas in each frame, as a page that animates does, it got about one frame for each group that it sent: 29 to 41 frames each second with groups of 1 program, and gaps of 0.5 to 2.3 s with groups of 25 to 100. During the first draws, the page got one frame for each group of draws. See [Frames during the link and the first draws](#frames-during-the-link-and-the-first-draws).
- **The link and the first draws together were shorter than in software in 23 of the 24 runs** with the built-in browser's flags: 10.4 to 13.0 s, against 14.4 to 15.7 s. The run with the slow link took 16.2 s. In software the reload saves the link, but the first draws then take 15 s, so that run is not shorter.
- **Two first links were slow.** One of the six browsers with the built-in browser's flags linked in 7.4 s on its first load, and the browser with the GPU for the whole page in 6.9 s. Their reloads were not slow in that way: 3.5 to 4.5 s. The cause was not found.
- **Mesa 25.0.7 did not remove the cost** (one browser). Its times are at the low end of the row for 22.3.6, or a little below it. The packages of Debian's `bookworm-backports` were extracted into scratch space and named with `LD_LIBRARY_PATH`, and the browser's GPU process had that library loaded. With no browser it took on average 14 to 17 ms to compile and link a program and 33 to 34 ms for its first draw (three runs). With no `GALLIUM_DRIVER`, a direct EGL program got `llvmpipe` from 25.0.7 and the card from 22.3.6, so req 9 needs a new measurement before a move to that version.
- **The session's own built-in browser shows the same pattern.** With 60 programs it took 1.6 s to link them, then 1.0 s on a second load, and 3.3 s, then 2.8 s, for the first draws.
- **Runs with more CPU load on the host were slower.** A second pass on the same day ran from [the files in the repository](#to-repeat-it), while other containers used the CPUs. The host has 32 CPU threads. The card was also in use by other processes: between the runs, `nvidia-smi` showed 20 to 40 % use. The first pass did not record the card's use. The load average was read at the start and at the end of a run, not during it. The GPU browsers below had the built-in browser's flags and 200 programs.
  - One browser at a load average of 15 to 17 took 8.0 s to link on its first load, 5.6 to 7.0 s on a reload with the same shaders, and 10.5 to 13.3 s for the first draws: 18.0 to 19.7 s together.
  - Two browsers a few minutes later, at a load average of 8, took 10.7 to 13.8 s together. Seven of their eight runs were in the range of the first pass.
  - One browser that ran while 12 busy processes used CPUs in its own container took 16.5 to 18.7 s together. The container has a limit of 14 CPUs. The limit held its processes for 0.9 s in total, in 52 periods, during that browser and a direct Mesa run after it.
  - In the eight slow runs, the main thread of the GPU process had CPU time for 98.6 to 99.5 % of the elapsed time. So the added time was almost all CPU time of that thread. Its cause was not examined. These runs do not show that the CPU load is the cause: the load and the card's use changed between the runs, and no run had an idle host.
  - The load average does not predict the slow result: in the first pass, a browser that started at a load average of 12 took 11.7 to 12.3 s.
  - A SwiftShader browser at a load average of 10 took 16.4 to 18.8 s together. Mesa with no browser, at 6 to 12, took 16 ms to compile and link a program and 38 to 40 ms for its first draw.
  - In the third pass, the two control browsers of [the frame measurement](#frames-during-the-link-and-the-first-draws) ran two times: at a load average of 1.1 to 1.4 in a first run, and 3.2 to 5.1 in the final run. They took 10.3 to 12.3 s together. The first pass had 10.4 to 13.0 s.

#### Frames during the link and the first draws

Measured on 2026-10-11 in a third pass, in the same `granted` container on the same host, with [the files in the repository](#to-repeat-it): one run of `run-groups.sh`, 38 browsers, and then two browsers with groups of 1 and 5 programs. Each browser had the built-in browser's three flags and the pin, and ran the page four times, as above. The host's load average was 1.0 to 5.1, and `nvidia-smi` showed 0 to 100 % use of the card, which includes other processes. A frame here is a call of the page's `requestAnimationFrame` callback, and its time is read in the call. The longest gap is the longest time with no frame, from the start of the phase to its end.

The page draws nothing in its frames:

| The page, with 200 programs | Link | Frames during the link | Longest gap in the link | First draws | Frames during the first draws | Longest gap in the first draws | Load average |
|---|---|---|---|---|---|---|---|
| Sends all, then asks for `LINK_STATUS` (control) | 3.3 to 5.1 s | 0 | 3.3 to 5.1 s | 7.2 to 7.5 s | 0 | 7.2 to 7.5 s | 4.6 to 5.1 |
| Sends all, then waits on `COMPLETION_STATUS_KHR` (control) | 3.3 to 4.5 s | 1 | 3.2 to 4.4 s | 6.9 to 7.2 s | 0 | 6.9 to 7.2 s | 3.2 to 4.6 |
| Groups of 25, first draws with 1 program for each frame | 3.4 to 4.6 s | 203 to 276, 60/s | 17 to 18 ms | 7.9 to 8.4 s | 200, 24 to 25/s | 116 to 136 ms | 2.5 to 3.2 |
| Groups of 50, 1 for each frame | 3.5 to 5.0 s | 207 to 299, 60/s | 21 to 50 ms | 8.2 to 8.6 s | 200, 23 to 24/s | 138 to 152 ms | 2.5 to 3.7 |
| Groups of 100, 1 for each frame | 3.4 to 5.1 s | 204 to 306, 59 to 60/s | 38 to 53 ms | 8.0 to 8.4 s | 200, 24 to 25/s | 122 to 162 ms | 3.5 to 4.7 |
| Groups of 50, 3 for each frame | 3.4 to 4.5 s | 203 to 271, 60/s | 18 to 27 ms | 7.1 to 7.3 s | 67, 9.2 to 9.5/s | 234 to 249 ms | 2.0 to 3.3 |
| Groups of 50, 10 for each frame | 3.2 to 4.4 s | 195 to 263, 60/s | 17 to 19 ms | 6.9 to 7.0 s | 20, 2.8 to 2.9/s | 402 to 432 ms | 1.7 to 2.2 |

The page draws into its canvas in each frame, as a page that animates does (`--animate`):

| The page, with 200 programs unless given | Link | Frames during the link | Longest gap in the link | Load average |
|---|---|---|---|---|
| Sends all, then asks for `LINK_STATUS` | 3.3 to 4.4 s | 0 | 3.3 to 4.4 s | 1.1 |
| Groups of 1 (200 groups) | 4.9 to 7.7 s | 200 to 220, 29 to 41/s | 67 to 195 ms | 2.8 to 3.7 |
| Groups of 5 (40 groups) | 5.1 to 6.2 s | 40 to 70, 8 to 11/s | 389 to 450 ms | 3.7 to 5.1 |
| Groups of 25 (8 groups) | 3.4 to 4.6 s | 8 to 11 | 476 to 674 ms | 1.0 to 1.8 |
| Groups of 50 (4 groups) | 3.3 to 4.4 s | 4 to 6 | 841 to 1436 ms | 1.6 to 2.0 |
| Groups of 100 (2 groups) | 3.3 to 4.5 s | 2 | 1693 to 2317 ms | 1.4 to 1.7 |
| Sends 100, 128 or 129, then waits on `COMPLETION_STATUS_KHR` | 1.6 to 3.1 s | 1 | all of the link | 2.2 to 5.1 |

- **A page that draws nothing in its frames keeps them during the link when it sends its programs in groups.** It sends a group, waits on `COMPLETION_STATUS_KHR` of that group between animation frames, then sends the next group. In each of the 20 loads with groups of 25 to 100, about 60 frames ran each second, and the longest gap was 17 to 53 ms.
- **A page that draws into its canvas in each frame got about one frame for each group.** So its longest gap grew with the size of the group, and groups of 25 to 100 did not keep its frames. With 100 to 129 programs sent at once, it got one frame. Its `COMPLETION_STATUS_KHR` calls took 1 ms or less, so it waited at another place, which was not examined. With groups of 1, it got 29 to 41 frames each second, and the link took 4.9 to 7.7 s, against 3.3 to 4.6 s with groups of 25 to 100.
- **During the first draws, the page got one frame for each group of draws.** With the draw option, it draws with a number of programs, calls `fenceSync`, and waits between animation frames until the fence is signaled. In each of the 40 loads with this option, the count of frames during the first draws was equal to the count of groups, so the fence was already signaled in the first frame after each group. In the two browsers with groups of 1 and 5 for the link, which ran after the series, the first draws took 8.2 to 12.2 s, with gaps of up to 484 ms. The cause was not examined. The page draws into its canvas. First draws into a framebuffer that is not the canvas were not tried.
- **The first draws took about 1 s more with one program for each frame.** In the series they took 7.8 to 8.6 s with one program for each frame, against 6.9 to 7.5 s in one loop and 6.9 to 7.3 s with 3 or 10 for each frame.
- **The limit of the poll mode is 128 programs, not a size of source.** The page sends all its programs, draws nothing in its frames, and waits on `COMPLETION_STATUS_KHR`. Three sets of pairs were used: all 35 pairs (4 to 104 kB of source each), the 16 pairs below 50 kB (4 to 35 kB), and the 13 pairs above 90 kB (100 to 104 kB). The load average was 1.1 to 3.3.

  | Pairs | Kept about 60 frames each second (longest gap) | One or two frames |
  |---|---|---|
  | All 35 | 100, 110, 120 and 128 programs, 6.1 to 7.9 MB (33 to 53 ms) | 129, 130, 140 and 150 programs, 8.0 to 9.2 MB |
  | The 16 small ones | 120, 127 and 128 programs, 3.1 to 3.3 MB (19 to 31 ms) | 129, 130, 150, 200, 300 and 400 programs, 3.3 to 10.3 MB |
  | The 13 large ones | 60, 80, 100, 120 and 128 programs, 6.2 to 13.2 MB (33 to 82 ms) | 129 and 130 programs, 13.3 to 13.4 MB |

  Each count has four loads of one browser, and all four loads of a count gave the same result. So 128 programs with 13.2 MB of source kept their frames, and 129 programs with 3.3 MB did not. The limit does not follow the time of the link either: 129 small programs linked in 0.4 to 0.7 s, and 128 large ones in 4.2 to 5.3 s.
- **With 129 programs or more, the page waited in one `COMPLETION_STATUS_KHR` call.** In each of those 52 loads, the longest call was the call for the first program, in the first frame after the send. It took 0.34 to 5.6 s: all of the link except 21 to 162 ms, most of which the page used to send its programs and to wait for that frame. With 128 or fewer, no call took 1 ms. Why the call waits from 129 programs was not examined.
- **A first run of the series** read the time of a frame from the timestamp that `requestAnimationFrame` gives, which is the start of the frame and can be earlier than the call, and it had no `--animate` runs. It ran at a load average of 1.1 to 22, and it gave the same limit of 128 programs with each set of pairs and one frame for each group of first draws. In one of its 20 loads with groups, the link had a gap of 1.1 s, in which the page's own calls did not wait; the final run did not show it.

#### To repeat it

The files are in [`shader-compile-probe/`](shader-compile-probe/). The result files are not in the repository: they are in the scratch space of the session that measured, and they go when that session goes. The commands are for a session container where `echo $SHIPIT_GPU` prints `granted`. They download three.js from the npm registry. In the repository they write only files that the folder's `.gitignore` names. Outside it, the shell scripts write test cache directories in `/tmp`, and the `llvmpipe` browser of `run-all.sh` writes Mesa's default cache in `~/.cache/mesa_shader_cache`.

```bash
cd docs/325-session-gpu-access/shader-compile-probe
npm pack three@0.186.1 && tar -xzf three-0.186.1.tgz package/build
node run-link.mjs capture --capture        # writes sources.json: the 35 shader pairs

# One browser: a first load, two reloads, and a reload with different sources.
G="--use-angle=gl-egl --ignore-gpu-blocklist --disable-gpu-compositing"
node run-link.mjs gpu --env=GALLIUM_DRIVER=d3d12 $G > results-one.txt
node run-link.mjs gpu-poll --env=GALLIUM_DRIVER=d3d12 $G --mode=poll --n=100 >> results-one.txt
python3 show.py results-one.txt

# The rows of the table, and Mesa with no browser.
./run-all.sh > results-200.txt
MESA25_LIB="$HOME/mesa25/usr/lib/x86_64-linux-gnu" ./run-direct.sh > results-direct.txt

# The frames: the controls, the groups, and the counts around the limit of the poll mode.
./run-groups.sh > results-groups.txt
python3 show.py results-groups.txt

# The sampler.
gcc -O1 -o psample psample.c
mkdir -p raw && rm -f raw/phases.txt
PHASE_LOG=raw/phases.txt GALLIUM_THREAD=0 GALLIUM_DRIVER=d3d12 ./psample raw/samples.txt python3 mesa_direct.py --n 200 --phased --fast-exit
python3 sample_shares.py raw/samples.txt raw/phases.txt
```

- `run-link.mjs` takes `playwright-core` from the session image (`/opt/agent-cli/node_modules`). `PLAYWRIGHT_FROM` names another `node_modules` directory. `--n` sets the number of programs, `--mode` how the page links them (`sync`, `poll` or `groups`), `--group` the size of a group, `--draw-group` the number of first draws before each wait on a fence (0: all in one loop), `--pairs` the set of pairs (`all`, `small` or `large`), and `--animate` makes the page draw in each frame. `N` sets the number of programs for `run-all.sh` and `run-direct.sh`.
- `MESA25_LIB` is the `usr/lib/x86_64-linux-gnu` directory of the packages `mesa-libgallium`, `libegl-mesa0`, `libgbm1`, `libgl1-mesa-dri` and `libglx-mesa0` (25.0.7-2~bpo12+1) and `libdrm2`, `libdrm-amdgpu1` and `libdrm-intel1` (2.4.123-1~bpo12+1) from Debian's `bookworm-backports`, extracted with `dpkg -x`. The path in the command is an example. With no `MESA25_LIB`, `run-direct.sh` does not do the runs on that Mesa.
- A run that fails, crashes or has a program that does not link gives a `## FAILED` line with its exit status, and the shell script then exits with 1. The JSON lines that the run printed before that stay in the output, so a crash at the exit of `mesa_direct.py` leaves its result.
- Each line of `run-link.mjs` has the host's 1-minute load average at the start and the end of the load (`loadavg`), and the card's use from `nvidia-smi` each 500 ms during it (`cardUse`: min, mean and max in %, or null with no `nvidia-smi`). The direct Mesa runs of `run-direct.sh` print the load average only at their start. The result files of the first two passes do not have these fields.
- The final run of `run-groups.sh` did not have the groups of 1 and 5 for the page that animates. Those two browsers ran after it, with the same commands. After them, only the stop of `nvidia-smi` in `run-link.mjs` changed: it now also stops a sampler that does not end in 2 s. On 2026-10-15 it also started to find the GPU process by the libraries of its renderer, because Chromium 155 does not name that process on its command line ([Measured after the update](#measured-after-the-update-req-12)). The first run of the series had earlier versions of `link.html` and `run-groups.sh`. Its result files are also in the scratch space of the session that measured.
- For the samples of the first pass, `sample_shares.py` prints the shares that are given above.

What the files do:

- **The sources.** A page hooks `shaderSource`, `attachShader` and `linkProgram`, then renders one three.js scene two times: eleven mesh materials (standard, physical, Phong, Lambert, toon, basic, matcap, normal) with textures, an instanced mesh, a ground plane, points, line segments and a sprite, under a directional light and a spot light that cast shadows, a point light, a hemisphere light, an ambient light, fog, tone mapping and an environment map. The different pairs among its `linkProgram` calls are the 35.
- **The 200 programs.** Program *i* takes pair *i* modulo the number of pairs in the set: 35 for all pairs, 16 for the small ones (below 50 kB of source) and 13 for the large ones (above 90 kB). Two `#define` lines after `#version 300 es` give it a number and a set number, and a line before the last `}` of the fragment shader adds a value from the two to `gl_FragColor`. The set number is 1 for the first three runs of a browser and 2 for the fourth.
- **The browsers.** `chromium.launch({ channel: "chromium", headless: true, chromiumSandbox: false, args, env })` from `playwright-core`, one page of 480×320, with `page.reload()` between the runs. The page asks for `LINK_STATUS` after it has sent all 200 links. Two of the six browsers of the second row waited on `COMPLETION_STATUS_KHR` first, and so did one of the two SwiftShader browsers, where the extension is absent and the wait does nothing.
- **The frames.** The page counts the calls of its `requestAnimationFrame` callback in two phases: the link, from before the first send to the last `LINK_STATUS` answer, and the first draws, from the first draw to the end of the `readPixels` after the last. It reads the time in each call, and the longest gap counts to the end of the phase. The page of the second pass used the timestamp that `requestAnimationFrame` gives and did not count to the end of the phase, so in its result files a phase in which the frames stopped has a short gap. With `--animate`, a small program that is linked before the measurement draws one triangle into the canvas in each call, with a value that changes with the time. In the group mode the page sends a group, waits on `COMPLETION_STATUS_KHR` of that group between animation frames, then sends the next. With `--draw-group`, it draws with that number of programs, calls `fenceSync` and `flush`, and waits between animation frames until the fence is signaled. Each line also gives the longest send of programs (`longestSendMs`), the longest round of `COMPLETION_STATUS_KHR` calls in one frame (`longestPollMs`), and the longest single call with its place in the round (`longestCallMs`, `longestCallAt`).
- **Mesa with no browser.** Python and `ctypes`: `eglGetPlatformDisplay` with Mesa's surfaceless platform, an OpenGL ES 3.0 context on a pbuffer, the functions from `eglGetProcAddress`, and the same 200 sources.

## Uploads of texture and buffer data (req 12)

### What was slow, and where the time went

A session of another repository reported that each page load of its three.js game took 18 to 22 s on the GPU route, 11.8 s of it in one `texSubImage3D`: a WebGL 2 texture array of 145 layers of 256 × 256 RGBA8 pixels (36.2 MB). Measured on 2026-10-13 in a `granted` session container on the host of the earlier measurements (Docker Desktop/WSL2, an RTX 4090, a Ryzen 9 5950X, Mesa 22.3.6, glibc 2.36, Chromium 153), with [the files in the repository](#to-repeat-the-upload-measurement). Each number below has the renderer and the host's CPU pressure (`some avg10` of `/proc/pressure/cpu`) of its run.

**The time is one `memcpy` in Mesa, and the card does not make it wait.**

- **The page.** `texStorage3D`, one `texSubImage3D` and a `readPixels` took 8.3 to 11.9 s in five browsers on the card (pressure 0.00 to 2.43) and 0.07 to 0.08 s in two browsers on SwiftShader (0.30 and 2.75). The renderer on the card was `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL ES 3.1)`, and `OpenGL 4.2` in the one browser that used GLX under Xvfb. One of the five was the session's own built-in browser: 8.4 s (0.08).
- **The calls.** `gl-call-times.so` logged each OpenGL call of the browser's GPU process into Mesa. The whole time was in four `glTexSubImage3D` calls: one for all 145 layers, which the page did not make, then the page's data in parts of 63, 63 and 19 layers. In one run they took 5264, 2141, 2619 and 824 ms (pressure 6.36). The browser made no `glFramebufferTextureLayer` call, so it cleared no layer, and a `glFinish` took 4 ms.
- **The thread.** During the 5264 ms call, the thread had 5193 ms of user time, 40 ms of system time and 0 page faults. So it did not wait for the card, and it did not wait in the kernel.
- **The stack.** gdb attached to the GPU process 30 times during one upload. All 30 stacks of the main thread were `__memcpy_avx_unaligned_erms ← util_copy_box ← u_default_texture_subdata ← st_TexSubImage`. An earlier run with 40 attaches gave the same.
- **Mesa with no browser.** `upload-direct` makes the same calls through EGL. `glTexSubImage3D` of the array took 4079 to 5279 ms in three runs (pressure 0.00 to 7.19). One 2D texture of the same bytes, 4096 × 2320 pixels, took 126 to 136 ms. 145 separate 2D textures of 256 × 256 pixels took 4627 to 5503 ms. Its renderer was `D3D12 (NVIDIA GeForce RTX 4090)`, `OpenGL ES 3.1 Mesa 22.3.6`.

**The cause is one CPU instruction on one kind of memory.** A texture upload in Mesa's Direct3D 12 driver maps a staging buffer, copies the data into it with `memcpy`, and lets the card copy from there (`d3d12_transfer_map` in `d3d12_resource.cpp`: `PIPE_USAGE_STREAM`, which `d3d12_bufmgr.cpp` makes a `D3D12_HEAP_TYPE_UPLOAD` buffer). Direct3D 12 documents the CPU pages of an upload heap as write-combined on a card with its own memory ([`GetCustomHeapProperties`](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-getcustomheapproperties(uint_d3d12_heap_type))); the memory type itself was not read here. `upload-direct copy` maps such a buffer and times copy methods into it, in MB each second (pressure 1.43):

| Destination | `rep movsb` | AVX2 stores | glibc `memcpy`, chunks of 4 to 256 KiB | glibc `memcpy`, chunks of 1 to 2 KiB and of 512 KiB to 4 MiB |
|---|---|---|---|---|
| Upload heap (a `STREAM_DRAW` array buffer) | 6 to 9 | 280 to 309 | 7 to 9 | 243 to 306 |
| Read-back heap (a pixel unpack buffer) | 6216 to 15925 | 5847 to 10348 | 7906 to 9641 | 3985 to 9436 |
| `malloc` memory | 7973 to 14706 | 7883 to 9586 | 8231 to 9542 | 5044 to 9657 |

glibc's `memcpy` uses `rep movsb` from its `x86_rep_movsb_threshold`, which the loader reports as 0x840 (2112 bytes) on this CPU, up to a second limit that the table puts between 256 and 512 KiB. One layer of 256 × 256 RGBA8 pixels is one `memcpy` of 262144 bytes, so each layer is in that range. The 36 MB 2D texture is one `memcpy` above it. That is all of the difference between the two: 7 MB each second against 300.

Three smaller facts from the same runs:

- **Chromium's `gl.finish()` is a flush.** A page that times an upload to `gl.finish()` sees only the part that Chromium made it wait for. For 32 layers the page read 14 ms to `gl.finish()` and 1063 ms to a `readPixels` after it (pressure 0.82).
- **An upload of 16 MiB or more was copied two times.** Chromium sent the data to its GPU process in parts: 62 layers (15.5 MiB) were one Mesa call, and 64 layers were two calls of 63 and 1. When there was more than one part, Mesa got one more call before them, for the full level and from another address: 64, 63 and 1 layers took 1990, 1745 and 27 ms (pressure 0.61). That is why the reported times were not in proportion to the layers. On Mesa 25.0.7 the browser did not make that call.
- **The same copy serves other uploads.** See the table of [the mechanism](#the-mechanism-one-tunable-of-the-c-library).

### The mechanism: one tunable of the C library

`GLIBC_TUNABLES=glibc.cpu.x86_rep_movsb_threshold=0x40000000` moves the first limit to 1 GiB, so `memcpy` takes its vector loop for each size that it gave to `rep movsb`. The constant is `GPU_GRAPHICS_GLIBC_TUNABLES` (`shared/gpu-graphics-env.ts`), and it reaches a browser in two ways:

1. **In the container's environment** — `GPU_GRAPHICS_ENV` (`session-gpu.ts`) goes into `Env` on the attempt that has the graphics binds, and on no other (`startWithGpu`, `container-lifecycle.ts`). A container that started without the binds has no Mesa on the card, so it gets no variable. Each process of the container inherits it, and so does a browser that the agent starts for a test, with no step in the test (req 9, req 12). `claude/adapter.ts` gives the CLI the worker's whole environment; the other adapters were not read for this.
2. **In the built-in browser's start command** — `playwrightMcpArgs` exports it beside the pin. In this session the CLI gave its MCP server the container's environment (`SHIPIT_GPU` was in it), so under Claude Code the export repeats the first way. Codex needs it: it gives an MCP server only the variables that its config names, and `writeMcpConfig` (`codex/adapter.ts`) names `PLAYWRIGHT_BROWSERS_PATH` alone. The other three adapters were not read for this.

glibc ignores a tunable name that it does not know, with no message. So `gpu-graphics-env.test.ts` asks the loader (`ld.so --list-tunables`) for the value, where the machine has an x86-64 glibc that can answer.

Measured with the variable, on the same host and day:

| Upload in Chromium, to the answer of a `readPixels` | No variable | With the variable |
|---|---|---|
| The array, one call (the report) | 8286 to 11886 ms, 5 pages of 3 browsers (pressure 0.00 to 2.35) | 263 to 301 ms, 5 pages of 3 browsers (1.00 to 5.71) |
| The array, one call for each layer | 13984 ms (9.66) | 352 ms (5.71) |
| 145 separate 2D textures of 256 × 256 | 7280 ms (15.07) | 256 ms (4.67) |
| One 2D texture of 1100 × 1100, 4.6 MB | 670 ms (12.26) | 31 ms (4.67) |
| 145 `DYNAMIC_DRAW` buffers of 256 KiB | 4940 ms (10.40) | 268 ms (4.67) |
| One 2D texture of 4096 × 2320 | 391 ms (15.07) | 299 ms (5.71) |
| 145 `STATIC_DRAW` buffers of 256 KiB | 165 ms (10.40) | 151 ms (4.67) |
| The array, 32 layers | 1063 ms (0.82) | 45 ms (0.36) |
| The array, 64 layers | 3964 ms (0.67) | 173 ms (0.36) |
| The array, GLX under Xvfb (`OpenGL 4.2`) | 9270 ms (2.43) | 288 ms (0.97) |

- **A real `playwright-mcp`, started with the new command and an environment of `PATH` and `HOME` only,** took 387 and 367 ms for the array (pressure 0.04). Its renderer was the card, and its server had both variables. The session's own built-in browser, which has the old command, took 8388 ms (0.08).
- **Mesa with no browser:** `glTexSubImage3D` of the array took 126 ms, against 4079 to 5279 ms, and the 145 separate textures 256 ms, against 4627 to 5503 ms. `memcpy` wrote the upload heap at 287 to 309 MB each second for each chunk size.
- **`memcpy` on `malloc` memory measured the same on this CPU.** Three runs each way: 39 to 55 GB each second in a window of 256 KiB with and without the variable, 31 to 41 in a window of 4 MiB, and 5.3 to 7.9 against 4.8 to 8.0 in a window of 40 MB.
- **What stays:** the card's memory takes 300 MB each second on this route, so an upload costs about 3.5 ms for each MB, and two times that where the browser copies it two times. `memset` uses `rep stosb`, which wrote the upload heap at 7 to 9 MB each second with and without the variable. No upload of the table was slow with the variable, and the driver's source has no `memset` of mapped memory, so the fill instruction has no tunable here.

Rejected:

- **The variable for the built-in browser only, and a line in `environment.md` for each other browser.** It changes fewer processes. But the report came from a test's own browser, and req 9 says that such a browser needs its flags and no variable.
- **The variable in the image (`ENV` in the Dockerfiles).** It would change `memcpy` in each session of each host, for a fault that only a container with the mounts can have.
- **A newer Mesa.** 25.0.7 from Debian's `bookworm-backports`, extracted into scratch space: `glTexSubImage3D` of the array took 4922 ms with no browser (pressure 0.28) and 120 ms with the variable. In Chromium the array took 4797 to 6721 ms (0.52 to 2.13), in three Mesa calls of 2153, 2182 and 592 ms for 63, 63 and 19 layers, so each layer cost what it costs on 22.3.6, and 164 to 187 ms with the variable. The GPU process had `libgallium-25.0.7-2~bpo12+1.so` loaded.
- **Another ANGLE back end.** `--use-angle=gl` reaches the same Mesa through GLX (last row of the table). `--use-angle=vulkan` gave SwiftShader: Debian's `mesa-vulkan-drivers` has no Direct3D 12 driver (`dzn`), in 22.3.6 and in 25.0.7 (`libvulkan_intel`, `_lvp`, `_radeon`, and in 25.0.7 `_gfxstream` and `_virtio`). A `dzn` built from source was not tried.
- **Chromium flags.** None was tried: the time is in Mesa's copy, after Chromium and ANGLE made their calls.

glibc's own source later stopped `rep movsb` in `memcpy` on Zen 3 and Zen 4 cores, for a different fault of the instruction ([bug 30994](https://sourceware.org/bugzilla/show_bug.cgi?id=30994)). An image on a glibc with that change was not measured.

### The shader link, asked with req 12

The user asked if the shader link has a remedy that `environment.md` does not name. None was found in the configurations that were tried. Measured on the same day with [the shader probe](#to-repeat-it), 200 programs, the built-in browser's flags and the pin, one browser each way, at a load average of 11.5 to 15:

| | Link, first load | Link, reloads | First draws |
|---|---|---|---|
| No variable | 5.4 s | 4.2 to 5.2 s | 7.9 to 8.3 s |
| With the variable | 5.5 s | 4.5 to 7.0 s | 8.2 to 13.3 s |

- **The variable did not remove the link or the first draws.** One browser each way on a host with load cannot show a small change, but the 4 to 5 s of the link and the 8 s of the first draws stayed. So that cost is not the copy.
- **A sample of the browser's GPU process shows where it is.** gdb attached 289 times during the four loads of one browser, and 285 attaches gave a stack. 47 % of the stacks were in `d3d12_get_gfx_pipeline_state`, which a draw calls, and almost all of those ended in `libnvidia-gpucomp.so` (86) and `libnvwgf2umx.so` (39): NVIDIA's compiler and its Direct3D driver. 18 % were Mesa's GLSL compiler and linker, 7 % its conversion to DXIL, and 17 % had no Mesa frame and were in Chromium's own binary, which holds ANGLE's shader translator. This agrees with the sampler of the direct Mesa script above, and it is the first sample of a browser process.
- **The driver and DirectX asked for no cache file in that run.** `strace` of the direct Mesa script with 20 programs showed no path of a cache. Outside libraries, Mesa and the driver asked for `drirc` files, `/dev/dri` and the EGL vendor file. So this configuration has no cache that a writable directory would turn on. A cache that another setting turns on was not looked for.

### Measured after the update (req 12)

Measured on 2026-10-15 on the same host, in a `granted` session container that an orchestrator with this change created. `SHIPIT_GPU_GRAPHICS_REASON` was not set, and the container's environment had `GLIBC_TUNABLES=glibc.cpu.x86_rep_movsb_threshold=0x40000000`; the loader reported that value for `glibc.cpu.x86_rep_movsb_threshold`. The image had Mesa 22.3.6 and glibc 2.36 as before, and Chromium 155.0.8059.12 (Playwright build 1247) instead of 153. The host's load average was 10 to 11 from other containers. Each run reported `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 4090), OpenGL ES 3.1)`.

| Browser | Upload, to the answer of a `readPixels` | Time | CPU pressure |
|---|---|---|---|
| Started by `run-upload.mjs`, no variable given by hand | The array, one call (the report) | 348 ms | 0.14 |
| The same | The array, one call for each layer | 312 ms | 0.14 |
| The same | One 2D texture of 4096 × 2320 | 272 ms | 0.11 |
| The same | 145 separate 2D textures of 256 × 256 | 275 ms | 0.11 |
| The same | One 2D texture of 1100 × 1100, 4.6 MB | 33 ms | 0.11 |
| The same | 145 `STATIC_DRAW` buffers of 256 KiB | 177 ms | 0.11 |
| The same | 145 `DYNAMIC_DRAW` buffers of 256 KiB | 321 ms | 0.11 |
| Started by `run-upload.mjs` with `--env=GLIBC_TUNABLES=` (the control) | The array, one call | 17197 ms | 5.70 |
| The session's own built-in browser, through `browser_evaluate` | The array, one call, two times on one page | 523 and 334 ms | 16.54, read after the two |

- **The browser that a test starts inherits the variable.** `run-upload.mjs` gives the browser `{ ...process.env }`, and the variable came from the container's environment.
- **The built-in browser starts with it.** Its `playwright-mcp` server had `GLIBC_TUNABLES` and `GALLIUM_DRIVER=d3d12` in its environment. So did its GPU process, which had `libEGL_mesa.so.0`, `libd3d12.so`, `libd3d12core.so`, `libdxcore.so` and `libnvwgf2umx.so` loaded.
- **The control shows that the variable is what makes the difference.** Without it, the array took 17.2 s, against 8.3 to 11.9 s on 2026-10-13 at a lower pressure. A sample of 12 stacks of a slow upload of 64 layers found `__memcpy_avx_unaligned_erms ← util_copy_box ← u_default_texture_subdata ← st_TexSubImage` in 9 of them.
- **Chromium 155 hides the type of its GPU process, as Playwright starts it.** It forks that process from a zygote, so its command line has `--type=zygote`, not `--type=gpu-process`. That was true in the built-in browser and in a Chromium that Playwright started, on the card and on SwiftShader. With `--no-zygote`, the same Chromium named the process again (a run of the independent review). The probe files found the GPU process by its command line, and the shader probe then read no CPU time for it: a run of the old `run-link.mjs` gave `gpuProcCpuS` null and no libraries. `run-link.mjs` and `sample-gpu-process.sh` now also accept a Chromium process that has the renderer's libraries loaded: `libd3d12.so` or Mesa's on the card, `libvk_swiftshader.so` on SwiftShader. ANGLE is in the `chrome` binary, so it marks no process. With that change, the shader probe read a CPU time for the GPU process on the card and on SwiftShader. The review compared the process that each script picked with the GPU process that Chromium reports, on the card, on SwiftShader and on `llvmpipe`, with the built-in browser in operation: they were the same in each case.
- **Each process of a browser had the main process's environment.** In three Chromiums started with a marker variable and with `GLIBC_TUNABLES` empty or set, on the card and on SwiftShader, the GPU process had the same two values as the main process. So `environment.md` tells the agent to read the main process, which is the child of the program that started the browser.

### To repeat the upload measurement

The files are in [`texture-upload-probe/`](texture-upload-probe/). They write only what the folder's `.gitignore` names. The commands are for a session container where `echo $SHIPIT_GPU` prints `granted`.

```bash
cd docs/325-session-gpu-access/texture-upload-probe
G="--use-angle=gl-egl --ignore-gpu-blocklist"
T=glibc.cpu.x86_rep_movsb_threshold=0x40000000

# The uploads in Chromium. In a container that has the remedy, take the variable out for the first run.
node run-upload.mjs no-variable --cases=all --env=GLIBC_TUNABLES= $G > results.txt
node run-upload.mjs variable --cases=all --env=GLIBC_TUNABLES=$T $G >> results.txt
python3 show.py results.txt

# Mesa with no browser: the uploads, then the copy methods into mapped memory.
gcc -O2 -o upload-direct upload-direct.c -ldl
GLIBC_TUNABLES= ./upload-direct all
GLIBC_TUNABLES=$T ./upload-direct all

# The OpenGL calls of the browser's GPU process, in raw/gltime.<pid>.log.
gcc -O1 -fPIC -shared -o gl-call-times.so gl-call-times.c -ldl
mkdir -p raw
node run-upload.mjs logged --env=GLIBC_TUNABLES= --env=LD_PRELOAD=$PWD/gl-call-times.so --env=GLTIME_DIR=$PWD/raw $G

# The stacks. GDB_ROOT holds gdb and the debug symbols, extracted with dpkg -x.
GDB_ROOT=$HOME/gdb-root ./sample-gpu-process.sh raw/stacks 30 -- \
  node run-upload.mjs sampled --env=GLIBC_TUNABLES= --env=LD_PRELOAD=$PWD/gl-call-times.so --env=GLTIME_DIR=$PWD/raw $G
python3 stack-shares.py raw/stacks
```

- `run-upload.mjs` takes `playwright-core` from the session image, as the shader probe does. `--cases` names the uploads (`all` is the seven of the table), `--layers` the number of layers, textures or buffers, and `--runs` the pages for each case.
- `GDB_ROOT` had these Debian 12 packages: `gdb-minimal`, `libdebuginfod1`, `libipt2`, `libxxhash0`, `libelf1`, `libdw1`, `libbabeltrace1` and `libc6-dbg` from `bookworm`, and `libgl1-mesa-dri-dbgsym`, `libegl-mesa0-dbgsym` and `libglapi-mesa-dbgsym` from `bookworm-debug`. The session has no root, so they were extracted and not installed.
- gdb can attach only to a process that has `gl-call-times.so` preloaded. The kernel's `ptrace_scope` is 1, and Chromium gives its one `PR_SET_PTRACER` place to its crash handler; the library keeps that place open.
- Each attach stops the browser, so an upload that is sampled takes much longer: 40 s with 30 attaches.
- The numbers above are from an earlier form of these files, in the scratch space of the session that measured. The files in the repository ran after that: `run-upload.mjs` for the table of the seven uploads, and the logger, the sampler and `upload-direct array` one time each.

## What is not verified here

For req 12, one host and one CPU were observed, and the game of the session that asked was not run: its repository is private to that session. So that the game's 11.8 s goes away is a conclusion from the same calls on a page with no game. One container that an orchestrator with this change created was observed ([Measured after the update](#measured-after-the-update-req-12)), on Docker Desktop with the WSL 2 backend and the Claude Code CLI; the built-in browsers of the other CLIs were not observed with it. Whether `rep movsb` is slow on this memory with another CPU, an Intel one for example, was not measured; there the variable changes which `memcpy` path runs and was not timed. The part of the game's load that it reports as the link of 16 programs (4.1 s) was not explained: the shader probe gives 21 to 27 ms for the link of a program, and a time that a page reads around a link can hold an upload before it.

The tests drive fakes. One real host was observed, Docker Desktop with the WSL 2 backend: a session container created with the switch on has `SHIPIT_GPU=granted`, `nvidia-smi` lists the card, and req 7 holds ([Measured on the host](#measured-on-the-host)). Not yet checked: Docker Engine + the toolkit in WSL2, and native Linux; `SESSION_READONLY_ROOTFS=1` and `SESSION_SECCOMP=1`; and what `docker compose config` writes for `gpus: all` (the check accepts both the string and the list form). The fallback means a failure on any of these leaves a session without the GPU, not a session that cannot start.

For req 7, two cases are not checked. Docker Engine + the toolkit in WSL2 can treat the two binds differently from Docker Desktop: if the start fails there, the container starts with the GPU alone and `SHIPIT_GPU_GRAPHICS_REASON` says why. And no machine with a second adapter was tried: the image's Mesa has `MESA_D3D12_DEFAULT_ADAPTER_NAME`, but its effect was not seen, because this machine gives Mesa one adapter.

For req 8, 9 and 11, one host, one image and one agent CLI were observed after the update: Docker Desktop with the WSL 2 backend, and the built-in browser that Claude Code starts. The adapters of the other four CLIs take the same start command from the one constant `PLAYWRIGHT_MCP_ARGS`, but their built-in browsers were not observed.

For req 10, no real container with no GPU and no native Linux host was seen. Before the update both were imitated with DirectX libraries that cannot load. After the update, the old command ran in a `granted` container, where it reports SwiftShader with the library in the image. A session with GPU access off was not started, because the switch is the user's and it changes each new session of the install.

The claim that a page with no WebGL keeps its picture comes from three test pages: the two of the measurements, and one with more 2D canvas and `OffscreenCanvas` drawing that the independent review of the change ran.

For the shader compile, one host, one card and one test page were observed, and the page of the session that asked was not run. So the result is for the configurations that were tried: two Mesa versions, the two cache variables of Mesa, the browser's program cache flag, the pin, and the GPU for the whole page. Mesa versions after 25.0.7 were not tried, no Chromium ran on 25.0.7 without the pin, and the cache directory was checked from the browser on 22.3.6 only. A Vulkan route was not tried: Debian's `mesa-vulkan-drivers` has no Direct3D 12 driver (`dzn`), in 22.3.6 and in 25.0.7. The cause of the two slow first links was not found.

The second pass of the shader compile had no idle host. The load came from other containers and, in one run, from 12 busy processes in the same container, and it changed during the runs. So the slower runs have four browsers behind them and no cause. From the files in the repository, `run-all.sh` and `run-direct.sh` ran with 20 programs only, to see that they work. The other browsers of the second pass ran one at a time: with 200 programs for the times, and with 20 to 200 programs for the frames.

The third pass had no idle host either: the load average was 1.0 to 5.1 in the final run and 1.1 to 22 in the first run, and the card was in use. The limit of 128 programs was seen with this page, Chromium 153 and the built-in browser's route only, and its cause was not examined. So was the result that a page that draws in each frame gets about one frame for each group; where that page waited was not examined. In the group mode, no group was larger than 100 programs. Not tried: a page that draws into a canvas that is not on the screen, or into a framebuffer that is not the canvas, during the link or the first draws; a page that does more drawing in each frame than one triangle; and the frames of the session's own built-in browser. The cause of the 1.1 s gap in one load of the first run was not found.

## Key files

- `src/server/shared/settings-catalogue/global-settings.ts` — `advanced.sessionGpu`.
- `src/server/orchestrator/session-gpu.ts` — the request, the state type, env, adoption read-back, the GPU-request check shared by Compose and the proxy, the WSL2 graphics binds.
- `src/server/orchestrator/container-lifecycle.ts` — request, fallback, state, the graphics attempt.
- `docker/Dockerfile.session-worker.prod`, `Dockerfile.session-worker.dev` — the DirectX links, Xvfb, the EGL library; `session-gpu-dockerfiles.test.ts` keeps them on the bound directory.
- `src/server/session/agents/playwright-mcp.ts`, `playwright-mcp-gpu.json` — when the built-in browser draws on the GPU, and its start command and flags.
- `src/server/shared/gpu-graphics-env.ts` — the C library tunable for uploads to the card (req 12); `GPU_GRAPHICS_ENV` in `session-gpu.ts` puts it into the container, and `playwright-mcp.ts` into the built-in browser's start.
- `docs/325-session-gpu-access/texture-upload-probe/` — the upload page and its driver, the direct Mesa program, the OpenGL call logger and the stack sampler of [the upload measurement](#to-repeat-the-upload-measurement).
- `docs/325-session-gpu-access/shader-compile-probe/` — the test page, the browser driver, the frame series, the direct Mesa script and the sampler of [the shader compile measurement](#to-repeat-it).
- `src/server/orchestrator/session-container.ts` — `gpuAccess` option, `standbyGpuOutOfDate`, `gpuDecision`.
- `src/server/orchestrator/container-discovery.ts` — state on adoption.
- `src/server/orchestrator/app-lifecycle.ts` — standby mismatch; proxy `SessionInfo.gpu`.
- `src/server/orchestrator/gpu-container-start.ts` — user and agent notices.
- `src/server/orchestrator/prompts/skeleton.md` — the pointer from "Browser access" to the Chrome steps.
- `src/server/orchestrator/compose-generator.ts`, `service-manager.ts`, `service-manager-setup.ts` — Compose check, strip, log line.
- `src/server/orchestrator/docker-proxy-sanitize.ts`, `docker-proxy-field-casing.ts`, `docker-proxy-helpers.ts` — proxy.
- Docs: `src/server/shipit-docs/environment.md`, `compose.md`, `wiki/settings-and-accounts.md`, `wiki/installing-and-updating.md`, `deployment/README.md`.
