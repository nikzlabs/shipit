---
issue: planning#664
title: GPU access for session containers
description: Let a ShipIt install on WSL2 or Linux give the machine's NVIDIA GPU to the containers its sessions run in.
---

# GPU access for session containers

1. When ShipIt runs in WSL2 on a machine that has a GPU, the user can give the agent's containers access to that GPU.
2. With that access, code that the agent runs in a session can use the GPU — for example, a GPU check (`nvidia-smi` on an NVIDIA GPU) lists it, and a framework such as PyTorch finds it.
3. GPU access reaches everything that a session runs: the agent's own container, the project's Compose services that declare a GPU, and the containers that the agent starts itself in a session with Docker access.
4. NVIDIA GPUs must work through CUDA, on WSL2 and on a native Linux install.
5. One install-wide switch in ShipIt's Settings turns GPU access on and off. It is off by default. When it is on, every new session gets the GPU.
6. When the switch is on but Docker cannot give a GPU, a new session starts as normal without the GPU, and ShipIt tells the user and the agent that the GPU is not available, and why.
7. With GPU access on WSL2, a Chrome that the agent starts in its own container can draw WebGL with the GPU: a page that asks Chrome for its WebGL renderer gets the machine's GPU, not a software renderer.

8. With GPU access on WSL2, ShipIt's built-in browser — the one the agent's browser tools use — can draw WebGL with the GPU: on `about:blank`, a page that asks it for its WebGL renderer gets the machine's GPU, not a software renderer.
9. With GPU access on WSL2, a headless browser that the agent starts in its own container with no display has a way to draw WebGL with the GPU.
10. A session with no GPU, and a session on a host that is not WSL2, behave as they did before requirements 8 and 9: the built-in browser draws in software.

## Open questions

- Is GPU drawing in the built-in browser the default for a session that has the GPU, or a setting? If it is a setting, is it for the install or for a repository, and is it on or off at the start? The user said on 2026-10-10 that this decision is theirs: a picture drawn on a GPU is not the same as one drawn in software, and some sessions commit pictures that a browser draws.
- Does the built-in browser use the GPU for WebGL only, or for the whole page? Req 8 names WebGL. The answer decides which pictures change.
- Which way does a browser with no display get (req 9): an EGL library in the session image, so that the browser's flags are sufficient, or the documented `xvfb-run -a`? The EGL way is not measured yet.

## Resolved questions

- 2026-10-08 — Which containers get the GPU? The user chose everything in a session: the agent's own container, the project's Compose services, and the containers that the agent starts itself through Docker (req 3).
- 2026-10-08 — Which GPUs and hosts must work? The user chose NVIDIA (CUDA) on WSL2 and on native Linux (req 4). AMD and Intel GPUs through WSL2's DirectX device are not part of this feature.
- 2026-10-08 — How does the user turn GPU access on? The user chose one install-wide switch in Settings, off by default; when it is on, every new session gets the GPU (req 5). Rejected: automatic when a GPU is found, and per repository in `shipit.yaml`.
- 2026-10-08 — What happens when the switch is on but Docker cannot give a GPU? The user chose: the session starts without the GPU, and ShipIt says why (req 6). Rejected: refuse to start the session.
- 2026-10-08 — Which Chrome must draw with the GPU? The user chose a Chrome that the agent starts itself, for example for a test, a benchmark or a script (req 7). ShipIt's built-in browser, which the agent's browser tools use, is not part of this requirement.
- 2026-10-08 — Which graphics must run on the GPU in Chrome? The user chose WebGL (req 7). WebGPU is not part of this requirement.
- 2026-10-08 — Where must Chrome on the GPU work? The user chose the agent's own container on WSL2 (req 7). A native Linux install, Compose services, and containers that the agent starts through Docker are not part of this requirement.
