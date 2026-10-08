---
issue: planning#664
title: GPU access for session containers
description: Let a ShipIt install on WSL2 give the machine's GPU to the containers its sessions run in.
---

# GPU access for session containers

1. When ShipIt runs in WSL2 on a machine that has a GPU, the user can give the agent's containers access to that GPU.
2. With that access, code that the agent runs in a session can use the GPU — for example, a GPU check (`nvidia-smi` on an NVIDIA GPU) lists it, and a framework such as PyTorch finds it.

## Open questions

- Which containers get the GPU: only the agent's own session container, or also the project's Compose services and the containers that the agent starts itself through Docker?
- Which GPUs must work: NVIDIA (CUDA) only, or also the AMD and Intel GPUs that WSL2 exposes through DirectX? Must the same work on a native Linux install, or only on WSL2?
- How does the user turn GPU access on: one install-wide switch, automatically when ShipIt finds a GPU, or per repository?
- When GPU access is on but Docker cannot give a GPU (no driver, no NVIDIA Container Toolkit), does a new session start without a GPU and say why, or does it refuse to start?
