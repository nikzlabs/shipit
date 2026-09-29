---
issue: planning#621
title: Session containers must not reach the API through a host address — plan
description: Every session container gets the egress sidecar firewall in both egress modes; it refuses the host, private networks and the tailnet, and hosts that cannot run it stay on loopback.
---

# 319 — Plan

Implements [requirements.md](requirements.md). Citations are `(req N)`.

## Summary

The API guard knows a session's containers only by their address on the session network. A request that reaches the orchestrator through an address of the host arrives from a host address, and the guard treats it as the user. No check on the peer address can fix this, because Docker's port proxy and a host forwarder connect from one address for every caller.

So the fix is at the network layer, with the mechanism the user chose: the existing per-container egress sidecar firewall runs in **every** session container, in **both** egress modes (req 1, req 2). The firewall refuses the host, private networks and the tailnet — the **local block** (req 4). Contained mode keeps its allowlist after the block. Open mode accepts all other traffic, so internet access stays as it is (req 4). A granted SSH destination opens only its own port (req 5). On a host that cannot run the sidecar, ShipIt stays on loopback (req 6).

## Verified facts

Each fact below was read at the source on 2026-09-29.

- The guard trusts any peer it does not know: `api-container-guard.ts:153` (`if (!caller && !otherContainer) return;`).
- Contained mode accepts the default gateway's /24, and the gateway is the host: `init-firewall.sh:82-89,109`. Compose services also accept their session and egress subnets with the gateways in them: `compose-service-egress.ts:186-188,272-277`.
- Open mode installs no firewall at all: agent `container-lifecycle.ts:836`, Compose `session-container.ts:462-467` and `compose-service-egress.ts:123`, plugins `plugin-egress.ts:70-72`.
- `SESSION_EGRESS_ENFORCE=0` turns every firewall off (`egress-firewall-install.ts:15-17`). The installers set it only when their NET_ADMIN probe fails (`deployment/local/setup.sh:523-527`, `deployment/vps/setup.sh:729-777`), but nothing records why, and an operator can set it by hand.
- Containers that the agent starts through the Docker proxy are forced onto `shipit-session-<first 12>`, a plain bridge, with no firewall in either mode: `docker-proxy-sanitize.ts:324-327`, `container-lifecycle.ts:685-703`.
- An SSH grant with an IP address enters the Tier A set as a /32 or /128 with no port (`ssh-hosts.ts:299-302`, `init-firewall.sh:117`). The port is stored (`credential-store.ts:119-124`) but `sshEgressTargets` reads only the address (`egress-allowlist.ts:337-348`). The connection is direct TCP from the agent container (`ssh-provision.ts:55-69`).
- Open-mode Compose services may add `NET_ADMIN` (`compose-generator.ts:135-136`), may set restart policies, and keep their own bridge networks (`compose-generator.ts:1885`). A restart gives a container a new network namespace without its firewall (`compose-service-egress.ts:34`); contained mode forces `restart: "no"` for this reason (`compose-generator.ts:1368-1372,1890`).
- The agent's second address on its Compose network is in neither guard lookup, so it reads as the user (planning#506, still open). The origin index lists only containers labelled `shipit-parent-session` (`session-container.ts:998-1014`), and the agent does not carry that label.
- The sidecar image has `iptables`, `ip6tables` and `ipset` (`Dockerfile.egress-sidecar:8`). No code in `src/` classifies private address ranges, and none reads the orchestrator's own port bindings.
- The VPS stack publishes only on `127.0.0.1` (`deployment/vps/docker-compose.yml:22-24`); its tailnet access is a host `socat` forwarder (`deployment/vps/tailscale.sh:208`). The local stack publishes on `${SHIPIT_BIND_ADDR:-127.0.0.1}` plus an optional tailnet overlay (`docker/local/prod/compose.yml:25-26`, `deployment/local/lib.sh:128-131`).
- The VPS stack reaches the orchestrator by service name because its address changes when it is replaced (`deployment/vps/docker-compose.yml:43-45`). So a firewall rule cannot pin the orchestrator's address.

## Design

### 1. The local block (req 4)

Every session container's `OUTPUT` chain gets the same prefix, in this order, for IPv4 and IPv6:

1. Loopback, and replies on connections that already exist — as today.
2. `SHIPIT-LOCAL`: first **drop** the host's own addresses (§5), each attached network's gateway, and broadcast and multicast destinations; then **accept** the subnets of the ShipIt networks this container is on (the orchestrator network, the session network, the egress network). This is the only way to the orchestrator, and there the guard knows the caller.
3. `SHIPIT-SSH`: accept each granted SSH destination, TCP to its port only (§4).
4. `SHIPIT-BLOCK`: drop `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (the tailnet), `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` (includes the tailnet's IPv6 range), `fe80::/10`. IPv6 neighbour discovery is accepted before this, or IPv6 stops working.
5. The mode's own rules: contained keeps its DNS rules, its allowlist set and policy `DROP`; open sets policy `ACCEPT`.

Because the block comes before the allowlist, an allowlisted name that resolves to a private address is refused too (req 4). Drops are inserted at the top of `SHIPIT-LOCAL` and accepts are appended, so a later network join can never put an accept in front of a drop.

The open policy uses only plain `iptables`/`ip6tables` rules, with no `ipset`, so it does not depend on kernel set support.

### 2. One install path, two policies (req 1, req 2)

`init-firewall.sh` takes `EGRESS_POLICY=open|contained`. Contained is today's behaviour plus the block. Open installs the block and policy `ACCEPT`, and no resolver or proxy runs. Its self-test checks that a blocked address is refused.

The choice per container:

| Egress limits for the session | Host can run the sidecar | Result |
|---|---|---|
| contained | yes | contained policy (today's allowlist + block) |
| open (session setting, global setting, or `SESSION_EGRESS_ENFORCE=0`) | yes | open policy (block only) |
| contained | no | refused to start, as today |
| open | no | no firewall, as today — and §7 keeps ShipIt on loopback |

`SESSION_EGRESS_ENFORCE=0` therefore means "egress limits off" and no longer "no firewall". Whether the host can run the sidecar is decided by a probe (§7), not by that variable.

Where the firewall is installed — the same places as contained mode today, with the `contained` gates widened to "block active":

- **Agent container**: `createContainer` (`container-lifecycle.ts`), and later network joins (`allowEgressToSessionNetwork`).
- **Compose services, including plugin services**: `containComposeServices` (`compose-service-egress.ts`).
- **Plugin install and CLI containers**: the holder in `preparePluginNetns` (`plugin-egress.ts`).
- **Containers started through the Docker proxy**: pending the second open question in requirements.md.

### 3. No route before the firewall

A container must not run with a route out before its firewall is in place. Contained mode already solves this for Compose services: they start on an internal session network, and ShipIt connects the egress network only after the firewall is in. When the block is active, open mode uses the same set-up:

- The session network is internal, services keep only the session network, and a restart policy is replaced by `restart: "no"`, as in contained mode.
- A service that adds `NET_ADMIN` is refused with a message, because it could remove its own block. Contained mode already refuses every added capability.
- The reserved `shipit-egress-` label prefix is refused, because the containment pass uses those labels to tell its own sidecars apart.
- The other contained-only checks (non-root user, no lifecycle hooks, DNS reset, YAML restrictions) protect the allowlist's resolver and proxy, which open mode does not run. They stay contained-only.

The agent container starts on the orchestrator network and gets its firewall before its first health check, as in contained mode today. Only ShipIt's own worker runs in that interval.

The plugin holder gets its firewall before the plugin starts in its namespace, as in contained mode today.

### 4. SSH destinations (req 5)

`ResolvedEgressConfig` carries each granted destination as `{ address, port }`. The firewall builds `SHIPIT-SSH` from them: a name is resolved in the container's own DNS view when the rules are built, and each address is accepted for TCP to that port only. A grant of the ShipIt host therefore opens only its SSH port.

IP destinations no longer enter the Tier A set, which opened every port. Names stay in the resolver's allowlist in contained mode, because the resolver refuses any name that is not on it.

A grant or revoke replaces `SHIPIT-SSH` in the running container (a new `set-ssh.sh` entrypoint). This replaces the reinstall that `applySshCidrs` ran on a revoke. It works in both modes.

A name's address is read when the rules are built. A change reaches the session at the next grant change or container start.

### 5. The host's own addresses

Private ranges cover the host's bridge, LAN and tailnet addresses. A public address on a host interface (typical on a VPS) is not in them. The orchestrator reads the host's addresses with a short run of the sidecar image in the host network namespace (`ip -o addr show`, no added capabilities), caches the result for ten minutes, and gives it to every firewall install. If it cannot read them, the install fails closed.

A public address that the host does not hold on an interface (a cloud 1:1 NAT) is the internet: it reaches only what the internet reaches.

### 6. The API guard: the agent's second address (req 1)

The origin index also lists agent containers (label `shipit-session-id`), with every address they hold. An agent's second address then resolves as that agent, with its own-session allowlist — the answer planning#506 proposed. The block makes the session network the only way to the orchestrator, so this closes the last path there.

### 7. Hosts that cannot run the sidecar (req 6)

**The probe.** The sidecar image gets `probe-firewall.sh`. It installs one rule in a network namespace of its own (`--network none`, `NET_ADMIN`). At start the orchestrator runs it once through the Docker API. It passes only if the sidecar image is configured and the rule installs.

**The orchestrator refuses to listen on other addresses.** If the probe fails, the orchestrator reads its own container's port bindings (the container id from `/etc/hostname`, as `resolveOwnContainerIp` in `docker-proxy.ts` does). If a binding is on any address other than loopback, it logs which binding, why, and how to remove it, and exits. It cannot close one binding and keep the others, so it keeps none.

**Setup does not add an entrance.** The scripts run the same probe with the sidecar image:

- `deployment/local/lib.sh` (every local start, after the image build): if the probe fails, it does not write the tailnet overlay, and it replaces a non-loopback `SHIPIT_BIND_ADDR` with `127.0.0.1`. It says why in both cases. So an update on such a host starts on loopback instead of reaching the refusal above.
- `deployment/local/tailscale.sh` and `deployment/vps/tailscale.sh`: if the probe fails, they stop with a message and install nothing.

Cloudflare Tunnel connects to `127.0.0.1:4123` from the host, so it keeps working, as do the same machine and an SSH tunnel (req 6).

### 8. Docker Desktop (req 1, req 3)

On Docker Desktop (macOS, and Windows with WSL2), a container reaches the host's loopback through `host.docker.internal`. Those addresses are private (`192.168.65.0/24`, `fdc4:f303:9324::/48` on current releases), so the block covers them. But loopback alone does not satisfy req 1 there. So if the probe fails on Docker Desktop (`docker info` reports `Docker Desktop`), ShipIt refuses to start session containers, with a message. This follows from req 1 and req 3; the probe normally passes there.

### 9. What users see

- Open sessions keep internet access, but cannot reach this machine, private networks or the tailnet. The UI text "Unrestricted outbound network access" changes to say so.
- Open-mode Compose: `NET_ADMIN` is refused, restart policies are replaced, and project networks are replaced by the session network — as in contained mode.
- Contained mode: an allowlisted host with a private address is not reachable.
- An SSH grant opens only its port.
- A host that cannot run the sidecar is reachable only on loopback.

`src/server/shipit-docs/` (environment, ssh, preview/compose where they describe open mode) and the wiki (`wiki/sessions.md`, `wiki/troubleshooting.md`) change in the same PR.

## Every install and access option (req 3)

| Install | Access option | Entrance | What stops a session container |
|---|---|---|---|
| Local, Linux | loopback | host `127.0.0.1` | Not reachable from a container. |
| Local, Linux | `SHIPIT_BIND_ADDR` | that address | Private address: `SHIPIT-BLOCK`. The host's own address: `SHIPIT-LOCAL`. |
| Local, Linux | tailnet | host tailnet address | `100.64.0.0/10` in `SHIPIT-BLOCK`. |
| Local, Docker Desktop | loopback | host loopback, reachable through `host.docker.internal` | Private range in `SHIPIT-BLOCK`; §8 if the sidecar cannot run. |
| Local, Docker Desktop | tailnet | host tailnet address | `SHIPIT-BLOCK`. |
| Local, WSL2 with Docker Engine | as Linux | as Linux | as Linux. |
| VPS | loopback | `127.0.0.1` | Not reachable from a container. |
| VPS | tailnet | `socat` on the tailnet address | `SHIPIT-BLOCK`. |
| VPS | Cloudflare with Access | public name, tunnel to loopback | The Access sign-in. |
| any | Cloudflare without Access, or a public bind address | public | First open question in requirements.md. |
| any | other services on the host | host addresses, gateways, `169.254.0.0/16` | `SHIPIT-LOCAL` and `SHIPIT-BLOCK`. |

## Not done, and why

- A one-time browser proof and a host firewall rule: the user rejected both (requirements.md, resolved questions).
- A check on the peer address: Docker's port proxy and host forwarders connect from one address for every caller.
- Pinning the orchestrator's address in the firewall: it changes when the orchestrator is replaced.
- A router container per session: a larger change than per-container rules, for the same result.
- A probe in the VPS forwarder at each start: req 6 is about what setup installs. The orchestrator's own check covers its own bindings at each start.

## Key files

- `docker/egress-sidecar/init-firewall.sh`, `allow-subnet.sh`, new `set-ssh.sh` and `probe-firewall.sh`; `docker/Dockerfile.egress-sidecar`.
- `src/server/orchestrator/egress-firewall-install.ts` (policy, host addresses, SSH targets, probe), `egress-firewall.ts` (gateways).
- `container-lifecycle.ts`, `session-container.ts`, `compose-service-egress.ts`, `plugin-egress.ts`, `compose-generator.ts`, `service-manager-setup.ts`.
- `egress-allowlist.ts`, `index.ts` (SSH targets with ports).
- `api-container-guard.ts` callers and the origin index in `session-container.ts` (agent addresses).
- New `local-block.ts`: the probe, the Docker Desktop check, and the startup refusal.
- `deployment/local/lib.sh`, `deployment/local/tailscale.sh`, `deployment/vps/tailscale.sh`.
- `.github/workflows/ci.yml`: a job that installs the open policy in a real network namespace and checks what it refuses.

## Deployment checks

On the test machine (Linux, Docker 29, egress limits off, tailnet binding), before and after the change:

1. From an agent container and a Compose service in an open session: the tailnet address, the gateway, a LAN address and `host.docker.internal` are refused; an internet host is reachable.
2. The same in a contained session.
3. A granted SSH destination is reachable on its port and on no other port.
4. The session network path to the API still gets 403 for a user-only route, from the agent's primary and second address.
5. Before its firewall is in place, a service on the internal session network cannot reach the host through that network's gateway.
6. With the probe forced to fail, the orchestrator refuses to start while a tailnet binding exists, and `update.sh` starts it on loopback only.
