---
issue: planning#621
title: Session containers must not reach the API through a host address
description: A request from a session's container that reaches the orchestrator through a host address or a host-side forwarder must not get the user's access.
---

# 319 — Session containers must not reach the API through a host address

The API container guard (`api-container-guard.ts`, docs/201-container-api-trust-boundary) knows a session's containers by their address on the session network. It treats any other caller as the user. On 2026-09-29 a test on a real install showed that a request from a session's container can reach the orchestrator through a host address, and then the guard treats it as the user (planning#621 has the result). The requirements below come from the user's threat model for docs/318-compose-remaining-escapes: *"Cross-session/host access should be fully prevented"* (requirement 7 there).

1. A request that starts in a session's container — its agent container or any service container — gets no more access to the orchestrator than the guard gives to that session's containers today. This is true whatever path the request takes: the session network, a published port on a host address, a forwarder on the host, or a path that leaves the host and comes back.

2. Requirement 1 is true in every egress mode (contained and open), because an install can turn egress limits off.

3. Requirement 1 is true for every install ShipIt supports: the local install on macOS, Linux, and WSL2, and the VPS install, each with its access options (loopback only, a configured bind address, tailnet, Cloudflare).

4. A session's containers cannot reach the machine that runs ShipIt, or addresses on private networks or the tailnet, in either egress mode. In open mode, internet access stays as it is today.

5. The exception to requirement 4 is the SSH destinations granted to a session: that session can reach each of them.

## Open questions

- On a host that cannot run the egress sidecar (rootless Docker, a locked-down kernel), requirement 4 cannot apply. Does ShipIt then refuse to listen on any address other than loopback, or listen there and show a warning? On Linux, containers cannot reach a loopback-only ShipIt (tested 2026-09-29); rootless Docker is not tested.

## Resolved questions

- 2026-09-29 — How does ShipIt tell the user's own requests apart from a session container's request that arrives on the same host address? The user rejected a one-time browser proof and a host network rule, and asked for networking options. From the eight options listed with the Astra role, the user chose: session containers cannot reach the host or private and tailnet networks in either egress mode, enforced by the existing per-container egress sidecar. The user asked that granted SSH destinations stay reachable. Requirements 4 and 5 were added.
