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

6. On a host that cannot enforce requirement 4 (for example rootless Docker, or a locked-down kernel), ShipIt is reachable only on loopback: it refuses to listen on any other address, and its setup does not install a forwarder to it. Access from the same machine, through Cloudflare Tunnel with Access, and through an SSH tunnel keeps working.

## Open questions

- An operator can make ShipIt public with no sign-in: the Cloudflare setup's `SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1`, or a bind address that the internet can reach. Then anyone on the internet gets the user's access, and so does a request from a session that goes out to the internet and comes back (requirement 1). Does ShipIt keep this opt-out as the operator's explicit choice and say that it sets requirement 1 aside, or remove the opt-out?
- In a session where the user turned on Docker access, the agent starts containers through ShipIt's Docker proxy. Today those containers get no firewall in either mode. Does ShipIt contain them like Compose services (requirements 1 and 4), or does the user's Docker-access grant accept that they can reach the machine?
- A Compose service that the user gives the Docker socket (docs/318-compose-remaining-escapes requirement 8) can control the machine, so no firewall can hold for it. Is that part of what the user accepts with the grant (ShipIt says so where it is turned on), or does ShipIt refuse the socket?

## Resolved questions

- 2026-09-29 — How does ShipIt tell the user's own requests apart from a session container's request that arrives on the same host address? The user rejected a one-time browser proof and a host network rule, and asked for networking options. From the eight options listed with the Astra role, the user chose: session containers cannot reach the host or private and tailnet networks in either egress mode, enforced by the existing per-container egress sidecar. The user asked that granted SSH destinations stay reachable. Requirements 4 and 5 were added.
- 2026-09-29 — On a host that cannot run the egress sidecar, does ShipIt refuse to listen on any address other than loopback, or listen there and show a warning? The user asked what would stop working (access from other devices over the tailnet or LAN, and the VPS Tailscale forwarder, on those hosts only), then chose the recommendation: refuse. Requirement 6 was added.
