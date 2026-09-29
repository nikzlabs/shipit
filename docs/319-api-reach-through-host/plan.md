---
issue: planning#621
title: Session containers must not reach the API through a host address — plan
description: Every session container gets the egress sidecar firewall in both egress modes; it refuses the host, private networks and the tailnet, and hosts that cannot run it stay on loopback.
---

# 319 — Plan

Implements [requirements.md](requirements.md). Citations are `(req N)`.

## Summary

The API guard knows a session's containers only by their address on the session network. A request that reaches the orchestrator through an address of the host arrives from a host address, and the guard treats it as the user. No check on the peer address can fix this, because Docker's port proxy and a host forwarder connect from one address for every caller.

So the fix is at the network layer, with the mechanism the user chose: the existing per-container egress sidecar firewall runs in **every** session container, in **both** egress modes (req 1, req 2, req 8). The firewall refuses the host, private networks and the tailnet — the **local block** (req 4). Contained mode keeps its allowlist after the block. Open mode accepts all other traffic, so internet access stays as it is (req 4). A granted SSH destination is the one exception, on its own port only (req 5). On a host that cannot run the sidecar, ShipIt stays on loopback (req 6).

## Verified facts

Each fact below was read at the source on 2026-09-29.

- The guard trusts any peer it does not know: `api-container-guard.ts:153`.
- Contained mode accepts the default gateway's /24, and the gateway is the host: `init-firewall.sh:82-89,109`. The /24 also holds every other session's agent on the shared orchestrator network. Compose services accept their session and egress subnets with the gateways in them: `compose-service-egress.ts:186-188,272-277`.
- Open mode installs no firewall at all: agent `container-lifecycle.ts:836`, Compose `session-container.ts:462-467` and `compose-service-egress.ts:123`, plugins `plugin-egress.ts:70-72`. The Compose hooks are wired only when contained: `service-manager-setup.ts:505-517`.
- `SESSION_EGRESS_ENFORCE=0` turns every firewall off (`egress-firewall-install.ts:15-17`). The installers set it only when their NET_ADMIN probe fails (`deployment/local/setup.sh:523-527`, `deployment/vps/setup.sh:729-777`), but nothing records why, and an operator can set it by hand.
- Containers that the agent starts through the Docker proxy are forced onto `shipit-session-<first 12>`, a plain bridge, with no firewall in either mode: `docker-proxy-sanitize.ts:324-327`, `container-lifecycle.ts:685-703`. The proxy's network checks accept any network with the session's label (`docker-proxy-auth.ts:22-35`), which the Compose egress network also carries.
- An SSH grant with an IP address enters the Tier A set as a /32 or /128 with no port (`ssh-hosts.ts:299-302`, `init-firewall.sh:117`). The port is stored (`credential-store.ts:119-124`) but `sshEgressTargets` reads only the address (`egress-allowlist.ts:337-348`). The connection is direct TCP from the agent container (`ssh-provision.ts:55-69`).
- Open-mode Compose services may add `NET_ADMIN` (`compose-generator.ts:135-136`), may set restart policies, and keep their own bridge networks (`compose-generator.ts:1885`). A restart gives a container a new network namespace without its firewall (`compose-service-egress.ts:34`); contained mode forces `restart: "no"` for this reason (`compose-generator.ts:1368-1372,1890`). The security checks run on the model Compose resolves (docs/318-compose-remaining-escapes), so interpolation cannot hide a value from them.
- The agent's second address on its Compose network is in neither guard lookup, so it reads as the user (planning#506, still open). The origin index lists only containers labelled `shipit-parent-session`, and only their IPv4 addresses (`session-container.ts:998-1014`).
- Before its firewall, the agent container runs only its entrypoint (ownership fixes, then `exec` of the worker: `docker/session-worker/entrypoint.sh`). The worker runs nothing from the workspace until the orchestrator sends it a command after the health check.
- The sidecar image has `iptables`, `ip6tables` and `ipset` (`Dockerfile.egress-sidecar:8`). No code in `src/` classifies private address ranges, and none reads the orchestrator's own port bindings.
- The VPS stack publishes only on `127.0.0.1` (`deployment/vps/docker-compose.yml:22-24`); its tailnet access is a host `socat` forwarder (`deployment/vps/tailscale.sh:208`). The local stack publishes on `${SHIPIT_BIND_ADDR:-127.0.0.1}` plus an optional tailnet overlay (`docker/local/prod/compose.yml:25-26`, `deployment/local/lib.sh:128-131`).
- The orchestrator's address changes when it is replaced, so the VPS stack reaches it by service name (`deployment/vps/docker-compose.yml:43-45`). A rule cannot pin that address.
- After an update, ShipIt replaces idle containers of the previous build and keeps those with live work or an always-on preview (`restart-turn-reattach.ts:60-110`).

## Design

### 1. The local block (req 4)

Every session container's `OUTPUT` chain gets the same prefix, in this order, for IPv4 and IPv6:

1. Loopback, and replies on connections that already exist — as today. IPv6 neighbour discovery, or IPv6 stops working.
2. `SHIPIT-SSH`: each granted SSH destination, TCP to its port only (§4). First, so that a grant of the ShipIt host itself works on its port.
3. `SHIPIT-LOCAL`: first **drop** the host's own addresses (§5), each attached network's gateway, and broadcast and multicast destinations (they reach the host's bridge interface). Then **accept** only what this kind of container needs:
   - agent: TCP to the orchestrator network on the orchestrator's own ports (the API and, with Docker access, the Docker proxy). Not the whole subnet, because every other session's agent is on it. When the agent joins its own session's networks, their subnets.
   - Compose service: its session network and its egress network. Only this session's containers and the orchestrator are on them.
   - plugin holder: nothing. Its network is shared between sessions, and plugins need no local peer.
   - container started through the Docker proxy: the session's Docker networks.
4. `SHIPIT-BLOCK`: drop `10.0.0.0/8`, `100.64.0.0/10` (the tailnet), `169.254.0.0/16`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7` (includes the tailnet's IPv6 range), `fe80::/10`.
5. The mode's own rules: contained keeps its DNS rules, its allowlist set and policy `DROP`; open sets policy `ACCEPT`.

Because the block comes before the allowlist, an allowlisted name that resolves to a private address is refused too (req 4).

The installer sets the policy to `DROP` before it flushes the chain, and sets `ACCEPT` last in open mode. A reinstall therefore never leaves a moment with no block. Drops are inserted at the top of `SHIPIT-LOCAL` and accepts are appended, so a later network join can never put an accept in front of a drop.

The open policy uses only plain `iptables`/`ip6tables` rules, with no `ipset`. If IPv6 rules cannot be installed and the namespace has an IPv6 address outside link-local, the install fails, so IPv6 is never left open.

### 2. One install path, two policies (req 1, req 2)

`init-firewall.sh` takes `EGRESS_POLICY=open|contained`. Contained is today's behaviour plus the block. Open installs the block and policy `ACCEPT`; no resolver or proxy runs. The self-test checks that a private address and the gateway are refused.

| Egress limits for the session | Host can run the sidecar | Result |
|---|---|---|
| contained | yes | contained policy (today's allowlist + block) |
| open (session setting, global setting, or `SESSION_EGRESS_ENFORCE=0`) | yes | open policy (block only) |
| contained | no | refused to start, as today |
| open | no | no firewall, as today — and §7 keeps ShipIt on loopback |

`SESSION_EGRESS_ENFORCE=0` therefore means "egress limits off" and no longer "no firewall". Whether the host can run the sidecar is decided by a probe (§7), not by that variable.

The firewall is installed where contained mode installs it today, with the `contained` gates widened to "block active":

- **Agent container**: `createContainer` (`container-lifecycle.ts`), later network joins (`allowEgressToSessionNetwork`) and SSH changes (`reloadEgress`).
- **Compose services, including plugin services**: `containComposeServices` (`compose-service-egress.ts`), with the start preparation and containment hooks in `service-manager-setup.ts` wired whenever the block is active.
- **Plugin install and CLI containers**: the holder in `preparePluginNetns` (`plugin-egress.ts`).
- **Containers started through the Docker proxy**: the proxy's start and restart routes (§3a).

### 3. No route before the firewall

A container must not run with a route out before its firewall is in place. Contained mode already does this for Compose services: they start on an internal session network, and ShipIt connects the egress network only after the firewall is in. When the block is active, open mode uses the same set-up. Each part is needed for req 4:

- The session network is internal and services keep only it. A project's own bridge networks would give a route, and a gateway on the host, before the firewall.
- A restart policy is replaced by `restart: "no"`, because a restart runs the service in a new namespace with no firewall.
- A service that adds `NET_ADMIN` is refused with a message, because it could remove its own block. Contained mode already refuses every added capability.
- The reserved `shipit-egress-` label prefix is refused, because the containment pass uses those labels to tell its own sidecars apart.
- The other contained-only checks (non-root user, no lifecycle hooks, DNS reset, YAML and interpolation limits) protect the allowlist's resolver and proxy, which open mode does not run. They stay contained-only.

The trusted ops proxy (ShipIt's own image in an ops session) is skipped by the containment pass, as today; it stays on the internal session network only, so it has no route out.

The agent container starts on the orchestrator network and gets its firewall before its health check, as in contained mode today. In that interval only ShipIt's entrypoint and worker run (see Verified facts).

The plugin holder gets its firewall before the plugin starts in its namespace, as in contained mode today.

### 3a. Containers started through the Docker proxy (req 8)

The same rule — no route before the firewall — applied at the proxy:

- The session's Docker network (`shipit-session-<first 12>`) is created internal when the block is active, and a network that the agent creates through the proxy is made internal. A container therefore starts with no route out.
- The proxy refuses a restart policy, because a restart loses the firewall.
- The proxy refuses to connect a container to a ShipIt egress network (`shipit-egress-*`), and refuses a network name that starts with `shipit-`, because ShipIt finds its own networks by name.
- The proxy treats ShipIt's firewall sidecars as not the session's: they carry the session label but hold `NET_ADMIN` in its namespace. A container created with a `shipit-egress-` label is refused.
- On every start and restart through the proxy, ShipIt first disconnects the container from the egress network (a new namespace has no firewall), then lets Docker start it, pauses it, connects the egress network, installs the firewall, and unpauses it. If a step fails, ShipIt stops the container and the call fails.
- These containers get the open policy in both modes. They have no egress limits today, and req 8 asks for requirements 1 and 4, not for egress limits.
- The agent joins the session's Docker network, so it reaches its containers there by name. A port that such a container publishes on the host is on the machine, so the block refuses it (req 4).

### 4. SSH destinations (req 5)

`ResolvedEgressConfig` carries each granted destination as `{ address, port }`. The firewall builds `SHIPIT-SSH` from them: a name is resolved in the container's own DNS view when the rules are built, and each address is accepted for TCP to that port only. So the exception to the block is only the SSH port: a grant of the ShipIt host, a LAN machine or a tailnet machine opens that port and nothing else there.

Outside the block nothing changes: in contained mode a granted destination stays in the allowlist as today, so its DNS name resolves.

A grant or revoke reinstalls the firewall in the running agent container and then restores its joined networks — the path `applySshCidrs` already takes on a revoke — now in both modes.

A name's address is read when the rules are built. A change reaches the session at the next grant change or container start.

### 5. The host's own addresses

Private ranges cover the host's bridge, LAN and tailnet addresses. A public address on a host interface (typical on a VPS) is not in them. The orchestrator reads the host's addresses with a short run of the sidecar image in the host network namespace (`ip -o addr show`, no added capabilities), and gives them to every firewall install. A read is reused for 60 seconds, so a burst of service starts runs it once. If the orchestrator cannot read them, the install fails closed.

A public address that the host gains later reaches a running container's rules when that container is next created. A public address that the host does not hold on an interface (a cloud 1:1 NAT) is the internet: it reaches only what the internet reaches.

### 6. The API guard: the agent's second address (req 1)

The origin index also lists agent containers (label `shipit-session-id`), with every address they hold, IPv4 and IPv6; child containers get their IPv6 addresses indexed too. An agent's second address then resolves as that agent, with its own-session allowlist — the answer planning#506 proposed.

### 7. Hosts that cannot run the sidecar (req 6)

**The probe.** The sidecar image gets `probe-firewall.sh`. It installs the rule types the block uses in a network namespace of its own (`--network none`, `NET_ADMIN`). In the containerized runtime, the orchestrator runs it once at start through the Docker API; `RUNTIME_MODE=local` has no session containers and skips it. The block is active only if the sidecar image is configured and the probe passes. The probe decides req 6 only: each install still fails closed on its own (§1).

**The orchestrator refuses to listen on other addresses.** If the block is not active, the orchestrator reads its own container's port bindings (the container id from `/etc/hostname`, as `resolveOwnContainerIp` in `docker-proxy.ts` does). If a binding is on any address other than loopback, it logs which binding, why, and how to remove it, and exits. It cannot close one binding and keep the others, so it keeps none.

**Setup does not add an entrance.** The scripts run the same probe with the sidecar image:

- `deployment/local/lib.sh`, at every local start after the image build: if the probe fails, it leaves the tailnet overlay out of the Compose files (even when the file cannot be deleted) and replaces a non-loopback `SHIPIT_BIND_ADDR` with `127.0.0.1`, and says why. So an update on such a host starts on loopback instead of reaching the refusal above. `deployment/local/tailscale.sh` reads that result for its message instead of running its own probe.
- `deployment/vps/tailscale.sh`: if the probe fails, it stops with a message and installs nothing. The forwarder it installs runs the probe when it starts (at boot, or after Docker restarts) and does not forward while the probe fails.
- `deployment/vps/deploy.sh`: an update on a host where the probe fails stops a forwarder that an earlier `tailscale.sh` installed, because that forwarder predates the probe in the wrapper.

Cloudflare Tunnel connects to `127.0.0.1:4123` from the host, so it keeps working, as do the same machine and an SSH tunnel (req 6).

### 8. Docker Desktop (req 1, req 3)

On Docker Desktop (macOS, and Windows with WSL2), a container reaches the host's loopback through `host.docker.internal`, which resolves to a private address (`192.168.65.254` and `fdc4:f303:9324::254` on current releases, from Docker's documentation; not tested here). The block covers any private address, so it covers this path. But loopback alone does not satisfy req 1 there. So if the block is not active on Docker Desktop (`docker info` reports `Docker Desktop`), ShipIt refuses to start session containers, with a message. This follows from req 1 and req 3; the probe normally passes there.

### 8a. Public installs and the Docker socket (req 7, req 9)

Text only:

- Where an operator makes ShipIt public with no sign-in — the `SHIPIT_ALLOW_PUBLIC_UNAUTHENTICATED=1` branch of `deployment/vps/cloudflare.sh`, the final warning in `deployment/vps/setup.sh`, and the `SHIPIT_BIND_ADDR` text in `deployment/README.md` and `SECURITY-MODEL.md` — the text says that a session is then no different from any internet client, so ShipIt cannot keep it away from its own API (req 7).
- Where the user turns on `project.allowDockerSocket`, the setting's description says that a service with the socket controls this machine, so ShipIt cannot keep it away from the host or private networks (req 9).

### 9. Text that changes

- UI: the open-mode description ("Unrestricted outbound network access") says that open sessions reach the internet but not this machine, private networks or the tailnet.
- `src/server/shipit-docs/` (compose, ssh, sandbox and the environment pages where they describe open mode, Docker access or SSH grants) and the wiki (`wiki/sessions.md`, `wiki/repos-and-sandboxes.md`, `wiki/troubleshooting.md`).

### 10. Image builds (req 10)

Build steps of a Compose `build:`, and of `docker build` through the Docker proxy, run in the Docker builder's own sandboxes, not in a session container, so the block does not reach them. Requirement 10 leaves them to planning#512 (docs/291-contained-builds), which must also cover Open mode. Until then this is a known gap, and the docs do not claim that builds are blocked.

### 11. Rollout

A container that the previous build started and that ShipIt keeps across the update (live work, always-on preview) keeps its old rules until it is next created. All new containers get the block.

## Every install and access option (req 3)

| Install | Access option | Entrance | What stops a session container |
|---|---|---|---|
| Local, Linux | loopback | host `127.0.0.1` | Not reachable from a container. |
| Local, Linux | `SHIPIT_BIND_ADDR` | that address | Private address: `SHIPIT-BLOCK`. The host's own address: `SHIPIT-LOCAL`. |
| Local, Linux | tailnet | host tailnet address | `100.64.0.0/10` in `SHIPIT-BLOCK`. |
| Local, Docker Desktop | loopback | host loopback, reachable through `host.docker.internal` | Private range in `SHIPIT-BLOCK`; §8 if the block is not active. |
| Local, Docker Desktop | tailnet | host tailnet address | `SHIPIT-BLOCK`. |
| Local, WSL2 with Docker Engine | as Linux | as Linux | as Linux. |
| VPS | loopback | `127.0.0.1` | Not reachable from a container. |
| VPS | tailnet | `socat` on the tailnet address | `SHIPIT-BLOCK`. |
| VPS | Cloudflare with Access | public name, tunnel to loopback | The Access sign-in. |
| any | Cloudflare without Access, or a public bind address | public | Nothing: req 7 sets req 1 aside there, and ShipIt says so (§8a). |
| any | other services on the host | host addresses, gateways, `169.254.0.0/16` | `SHIPIT-LOCAL` and `SHIPIT-BLOCK`. |

## Not done, and why

- A one-time browser proof and a host firewall rule: the user rejected both (requirements.md, resolved questions).
- A check on the peer address: Docker's port proxy and host forwarders connect from one address for every caller.
- Pinning the orchestrator's address in the firewall: it changes when the orchestrator is replaced. The agent's rule names the orchestrator's ports on its network instead.
- A new entrypoint that replaces only the SSH rules: the existing reinstall path does the same job.
- A long cache of the host's addresses, or a loop that watches them: 60 seconds covers a burst of starts; §5 states what a later change does.
- A router container per session: a larger change than per-container rules, for the same result.
- Keeping open-mode Compose features that let a service run without its block (restart policies, `NET_ADMIN`, project bridge networks): req 4 applies in open mode too.

## Key files

- `docker/egress-sidecar/init-firewall.sh`, `allow-subnet.sh`, new `egress-lib.sh` and `probe-firewall.sh`; `docker/Dockerfile.egress-sidecar`, `image-checks.sh`.
- `src/server/orchestrator/egress-firewall-install.ts` (policy, host addresses, SSH targets, local accepts, probe), `egress-firewall.ts` (gateways).
- `container-lifecycle.ts`, `session-container.ts`, `compose-service-egress.ts`, `plugin-egress.ts`, `compose-generator.ts`, `service-manager-setup.ts`.
- `egress-allowlist.ts`, `index.ts` (SSH targets with ports).
- The origin index in `session-container.ts` (agent addresses, IPv6).
- `docker-proxy.ts`, `docker-proxy-sanitize.ts`, `docker-proxy-auth.ts`, and a new `docker-proxy-egress.ts` (§3a).
- New `local-block.ts`: the probe, the Docker Desktop check, and the startup refusal.
- `deployment/local/lib.sh`, `deployment/local/tailscale.sh`, `deployment/vps/tailscale.sh`, `deployment/vps/deploy.sh`, `deployment/vps/cloudflare.sh`, `deployment/vps/setup.sh`.
- `.github/workflows/ci.yml`: a job that installs the open policy in a real network namespace and checks what it refuses.

## Deployment checks

On the test machine (Linux, Docker 29, egress limits off, tailnet binding), before and after the change:

1. From an agent container and a Compose service in an open session: the tailnet address, the gateway, a LAN address and another session's agent are refused; an internet host is reachable.
2. The same in a contained session.
3. A granted SSH destination is reachable on its port and on no other port.
4. The session network path to the API still gets 403 for a user-only route, from the agent's primary and second address.
5. Before its firewall is in place, a service on the internal session network cannot reach the host through that network's gateway.
6. In a session with Docker access, a container started through the proxy is refused the same destinations, and the agent reaches it by name.
7. With the probe forced to fail, the orchestrator refuses to start while a tailnet binding exists, and `update.sh` starts it on loopback only.

Not testable on that machine: Docker Desktop (§8).
