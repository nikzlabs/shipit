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

## Open questions

## Resolved questions

- 2026-10-08 — Which containers get the GPU? The user chose everything in a session: the agent's own container, the project's Compose services, and the containers that the agent starts itself through Docker (req 3).
- 2026-10-08 — Which GPUs and hosts must work? The user chose NVIDIA (CUDA) on WSL2 and on native Linux (req 4). AMD and Intel GPUs through WSL2's DirectX device are not part of this feature.
- 2026-10-08 — How does the user turn GPU access on? The user chose one install-wide switch in Settings, off by default; when it is on, every new session gets the GPU (req 5). Rejected: automatic when a GPU is found, and per repository in `shipit.yaml`.
- 2026-10-08 — What happens when the switch is on but Docker cannot give a GPU? The user chose: the session starts without the GPU, and ShipIt says why (req 6). Rejected: refuse to start the session.
