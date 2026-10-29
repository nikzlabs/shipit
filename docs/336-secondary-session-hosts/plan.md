---
issue: planning#708
title: Secondary session hosts — design
description: How one ShipIt runs sessions on secondary machines through a host agent that connects out over a private network.
---

# Secondary session hosts — design

This design implements [requirements.md](./requirements.md) and cites it as (req N). Nothing here is built. File references are in `src/server/orchestrator/` unless the path says otherwise. They were checked on 2026-10-28.

## Summary

- One ShipIt has a main host and can have several secondary hosts (req 1). The main ShipIt stays the one place for the database, settings, credentials, chat and UI (req 5, 6).
- Each secondary host runs a **host agent**: one container that has that host's Docker socket and connects out to the main ShipIt over the private network (req 7).
- The main server never gets a secondary host's Docker API. It sends the host agent named actions, for example "create the containers of session S, with a GPU". The host agent makes every Docker request itself: ShipIt's own containers from fixed templates, and a repository's Compose services and plugin containers only after its own checks (req 13).
- All traffic between the main server and a session on a secondary host goes through the host agent's connection: worker calls, the event stream, the terminal, previews, and the session's own calls to the main server.
- A session gets its host before it is created and keeps it (req 9). The main host is the default (req 4, 17).

## Terms

- **Main host:** the machine that runs the ShipIt orchestrator. Its sessions run as they do today.
- **Secondary host:** another machine on which the main ShipIt runs sessions.
- **Host agent:** the process on a secondary host that runs that host's session containers for the main server.
- **Tunnel:** the one connection from a host agent to the main server. It carries many streams at the same time.

## Why this shape

| Other shape | Why not |
|---|---|
| The main server uses a secondary host's Docker API directly, over SSH or TCP | Full Docker API access is root access to that machine (req 13). |
| The main server reaches session containers by their IP addresses, through a Tailscale subnet route | Docker Desktop keeps container addresses inside its own VM, and the first GPU host runs Docker Desktop (`docs/325-session-gpu-access/plan.md:85`). Caller identity by IP also fails across hosts: an unknown caller passes as the user (`api-container-guard.ts:1`, `:153`). |
| Two full installs with one UI (the t3code model) | Settings and instructions would be in two places (req 5), and a session could not start a child on the other install (req 2). |
| Sessions stay on the main host and run commands on the secondary over SSH (docs/305-ssh-hosts) | Such a session is not a regular session on that host: no GPU in its containers, no previews there (req 3). |

A host agent that connects out needs no open port on the secondary host, and the tunnel itself tells the main server that the host is on (req 8). It should work the same on Docker Desktop and on Docker Engine; that is not verified yet (see "Not verified").

## 1. Hosts on the main server (req 1, 8, 12, 21)

A new `hosts` table holds the secondary hosts: an id, a name, the host's private-network address, the GPU setting (req 12) and the memory budget (req 21). The main host is not a row: an empty `host_id` on a session means the main host, and its GPU setting and memory budget stay where they are today (`advanced.sessionGpu`, `src/server/shared/settings-catalogue/global-settings.ts:220`; `advanced.memoryBudgetMb`, `credential-store.ts:806-808`).

- **Adding a host.** The user adds a host in Settings → Hosts with its name and private-network address, then installs the host agent on that machine. The main server accepts a tunnel only from an address in this table, on a listener bound to the private-network address. On a tailnet or another WireGuard network an address belongs to one device, so this needs no authentication of its own (req 7). Authentication between hosts is a later version.
- **State.** A host is on when its tunnel is up and its version handshake matched (section 2, "Updates"). The state is not stored; it comes from the tunnel.
- **State in the UI.** The host list, with each host's state, reaches the client in the bootstrap and on the global SSE stream (`/api/events`), as the session list does (`route-registry.ts:132`). The new-session screen and the session list read it.
- **Docker access (req 14)** is the one host setting that is not on the main server (req 5). See section 2.

## 2. Host agent (secondary host)

### What it is

A container image built from this repository. It holds the modules of the orchestrator's container layer — container creation, egress firewall, Compose, plugins, overlay volumes, Docker events, memory statistics, disk reclaim, adoption — and a small server for the tunnel. It mounts the host's Docker socket and one data directory. That directory holds the host's session folders: workspaces, `/persist`, uploads, credentials and state.

It starts with `docker compose up -d` on the secondary host. A config file on the host gives the main server's address, the host's name, and the Docker-access setting.

### What the host agent decides by itself

The main server cannot change any of these:

- **ShipIt's own containers** — the session worker, the Docker-capable worker, the egress containers, the Compose helper and the ops proxy (`templates-ops.ts:7-52`) — come only from the host agent's templates. They keep today's hardening: `CapDrop ALL` with five `CapAdd` (`container-lifecycle.ts:839-841`), `no-new-privileges` (`container-lifecycle.ts:834-836`), and resource limits sized from this host's memory and CPUs. Today the limits come from the orchestrator's own `os.totalmem()` and `os.cpus()` (`container-config-builder.ts:84-108`), which would be the wrong machine.
- **A repository's Compose services and plugin containers** use the repository's or the plugin's own images, as today. The host agent reads the repository's files on its own disk and runs today's checks on them itself: the Compose validation that refuses `privileged` and the other dangerous settings (`compose-generator.ts:1416` onward), and the plugin container settings (`plugin-cli-run.ts:494-520`, `plugin-install.ts:417-450`). The main server cannot send it a finished Compose model or container settings.
- **Mounts** come only from the session's own folders under the data directory.
- **`NET_ADMIN`** goes only to the egress containers, inside the session's own network namespace (`egress-firewall-install.ts:182-217`).
- **A GPU** goes to a container only when the main server asks for one and this host's Docker can give it. Today's request is `session-gpu.ts:7-19`; the host agent reports whether its Docker gave the GPU, as the session's GPU state does today (docs/325-session-gpu-access).
- **Docker for a session** only when this host's Docker-access setting allows it (req 14). The ops proxy only in its exact template (`compose-generator.ts:893-924`).
- **Git** runs only as one of the typed `WorkspaceGit` operations (section 4). The host agent finds the workspace and the uid from its own session record. It never accepts raw git arguments, `-c` options, environment variables or spawn options from the main server, and it refuses a git call that would run as root.

### Actions

| Action | Code that runs on the host (today in the orchestrator) |
|---|---|
| Prepare and remove a session's folders; write a file into its credentials, SSH or uploads folder; report changes to its token files | `session-agent-credentials.ts`, `ssh-provision.ts:87-110`, `services/files.ts:190-225`, `session-token-publisher.ts` |
| Create, start, stop and destroy a session's containers | `container-lifecycle.ts:645-1085` (create), `:1160-1295` (teardown) |
| Install or reload a session's egress rules. Inputs: allowed hosts, CIDRs, SSH targets | `egress-firewall-install.ts`, `egress-reload.ts:26-60` |
| Run Compose for a session: config, build, up, stop, down, ps, logs | `compose-generator.ts`, `compose-helper.ts`, `compose-cli.ts` |
| Run a plugin command or a plugin install for a session | `plugin-cli-run.ts`, `plugin-install.ts` |
| Run a typed `WorkspaceGit` operation on a session's workspace, as the session's uid (section 4). A clone, fetch or push carries a credential for that one operation | `GitManager` through `safeSimpleGit` (`src/server/shared/git-hooks-guard.ts`), as the orchestrator runs it today |
| Open a stream to a session's worker (port 9100), or to a preview target that the session's Compose state lists | new |
| Report Docker events, memory use and disk state | `container-health.ts:84-89`, `docker-memory.ts` |
| Stop an idle container; prune disk | `idle-enforcer.ts` decides on the main server; `steady-state-reclaim.ts`, `startup-janitor.ts`, `tier-escalation.ts` run on the host |

The inputs are names and data — a session id, a list of hosts to allow, the bytes of a file — never Docker settings. A main server that someone broke into can do what any ShipIt user can do: start sessions on the host, and read or change their files. It cannot get root access to the host (req 13). The one exception is Docker access that the user allows on that host (req 13, 14).

### The session-facing listener

The host agent is each session's `SHIPIT_HOST` (section 3), so session containers can reach it. That listener only forwards session calls to the main server. None of the host agent's actions can be reached from it, so a repository's code cannot use the host agent's Docker socket.

### Docker access (req 14)

Sessions can get two kinds of Docker today, and the one setting covers both:

- the agent's Docker through ShipIt's filtering Docker proxy, which `compose.docker-socket` alone gives (`container-config-builder.ts:47`);
- the raw socket for Compose services, which also needs the repository setting `project.allowDockerSocket`: the grant is wired in `service-manager.ts:1534`, and `compose-generator.ts:935-937` checks the two together. A service with the raw socket controls the machine (`src/server/shipit-docs/compose.md`, "What not to do").

When the setting is off, the host agent refuses both. A session whose repository asks for Docker then starts without it and says why.

The setting is in the host agent's config file on the host (req 14). The host agent sends it when the tunnel opens, and Settings → Hosts shows it without a control to change it. If the main server kept it, a main server that someone broke into could turn it on and get root access to the host, which req 13 forbids. Req 5 names this setting as its one exception.

### Updates (req 15)

The host agent and the images on its host are updated on the host. The install script brings them to a ShipIt version and builds the images, as `deployment/local/lib.sh:224-226` does today. When the tunnel opens, the host agent sends its build id; the main server compares it with its own and shows a host with a different version as off. The main server never sends code to a host agent. A later version can let the main server ask a host agent to update itself to the main server's version; the host agent still gets the code from the release, not from the main server.

## 3. Tunnel and traffic

The host agent opens one WebSocket to the main server's host listener (section 1), which is separate from the browser API. Each request, SSE stream or WebSocket that crosses the tunnel is one stream on that connection.

The tunnel is not a browser connection, so the rule "WebSocket lifecycle must not affect server behavior" (`CLAUDE.md`) does not cover it: its loss means that the host is off, and the main server shows that. It still destroys nothing: the sessions and their containers stay on the host (section 6).

| Traffic | Today | For a session on a secondary host |
|---|---|---|
| Main server → worker: agent control, files, install, the `/events` SSE stream | Plain HTTP to `containerIp:9100` with the worker token (`container-lifecycle.ts:923-924`, `worker-http.ts:100`) | A stream through the tunnel. The host agent connects to the container on its host and adds the worker token, which stays on the host. |
| Terminal | POST in, `terminal_data` out on `/events` (`container-session-runner.ts:1269-1279`, `:1917`) | The same, through the tunnel. |
| Previews | `preview-proxy.ts` connects to a Compose service IP or to the agent container's IP (`preview-proxy.ts:534-540`, `service-manager.ts:773-780`) | The main server's proxy asks the host agent for a stream to "session S, port P", and the host agent finds the target. WebSocket upgrades and the HMR patch work as today, because the main server's proxy still handles them (`preview-proxy.ts:404-449`, `:49-60`). |
| Session → main server: the `shipit` CLI, git credentials, SSH signing, egress decisions | To `SHIPIT_HOST:SHIPIT_PORT`; the main server finds the caller by its source IP (`api-container-guard.ts:143`) | To the host agent's session-facing listener, which forwards the call through the tunnel with the session's callback token (section 4). |

**Callback checks.** For every call that arrives through a tunnel, before any other routing, the main server checks three things: the callback token belongs to the session the call names; that session is on this tunnel's host; and the route is one that a session may call (`containerAccessible`, `api-container-guard.ts:184-196`). A call that fails any check is refused. A call from a tunnel is never handled as the user.

Preview traffic passes through the main server, so a web game on the workstation loads its files through the main server. A preview proxy on the secondary host can fix that later. It is not in this version.

**Encryption.** Req 7 requires a private network that encrypts, such as a tailnet or another WireGuard network. So the tunnel needs no TLS of its own in this version (planning#672 item 2). ShipIt cannot see whether a network encrypts, so the host-agent install guide says that a plain LAN is not supported.

## 4. Work that leaves the main server's disk

Today the main server works directly on session folders. For a session on a secondary host those folders are on that host. Three changes, from planning#672:

1. **A callback token for each session** (planning#672 item 1). Each session gets a token, stored in the main server's database and given to its worker. Every call from the session carries it, and section 3 checks it. This keeps docs/319-api-reach-through-host req 1 true across hosts.
2. **Git** (planning#672 item 3). The main server runs git in session workspaces at 84 call sites in 29 files; for example `ws-handlers/post-turn.ts:178`, `services/pre-turn-reset.ts:246`, `services/claim-session.ts:123`, and `api-routes-git.ts`. They move behind one `WorkspaceGit` interface of typed operations, and so do the raw git spawns, such as the auto-commit's (`src/server/shared/git.ts:507-512`):
   - On the main host, it keeps today's direct git.
   - On a secondary host, the host agent runs the same `GitManager` code in its own process, with today's guard from docs/266-orchestrator-git-trust-boundary: git runs as the session's uid from the session's protected identity record, never as root; `safe.directory` stays narrow; and the project's hooks run only on the auto-commit. It works when the worker is down, for example after a crash or an idle reclaim. This guard protects the orchestrator today, which also has the Docker socket (docs/266-orchestrator-git-trust-boundary req 11). It protects the host agent only when these conditions hold:
     - The host agent runs as root, because git drops uid only from root (`src/server/shared/git-tree-uid.ts:34`). It refuses a git call when the uid would be root or cannot be found.
     - Session uids cannot open the Docker socket, and cannot read or write the host agent's config file, which holds the Docker-access setting (req 14).
     - The global git config stays readable and holds no token, and a token stays in a root-only file, as today (`git-config.ts:60-75`). A clone, fetch or push gets a credential for that one operation from the main server, as data.
     - The main server can call only the typed operations (section 2).
   - What stays open, as on the main host today: sessions share one uid, so code that a repository's git config runs in one session can reach the workspaces of the other sessions on the same host (docs/266-orchestrator-git-trust-boundary req 13).
   - Git does not run in a one-shot container. docs/266-orchestrator-git-trust-boundary rejected that as its option C: the post-turn commit would then also depend on Docker starting a container (its req 6), and every git call would wait for a container start. For example, the PR poller runs local git for each session with an open PR every 15 or 120 seconds, depending on the session's state (`pr-polling-supervisor.ts:6-7`, `:36-60`; `pr-status-poller.ts:750-770`).
3. **Session folders and files** (planning#672 item 4). Credentials, SSH config, uploads and `/persist` are written through a `SessionHost` interface, which also covers the containers and the folders of a session: direct work on the main host, host-agent actions on a secondary host. The host agent watches the session's token files and reports changes, as `session-token-publisher.ts` does today.

**Clones.** On the main host the claim clones a new session's workspace from the bare cache with `git clone --local`, before the session's containers exist (`services/claim-session.ts:275-315`, `repo-git.ts:201-217`). On a secondary host the claim asks the host agent to do it: the host agent clones from GitHub into the new session's folder as the session's uid, with a credential for that one clone, and then sets up the branch as the claim does today. A secondary host has no bare cache in this version, so each session there downloads and keeps its own full copy of the repository's objects. For scale, the packs of this checkout of ShipIt's repository are about 100 MB; the download size of a fresh clone was not measured. A cache on each host can come later, if download time or disk use calls for it.

## 5. Placement

- **The host comes first.** A session's host is chosen before the session is created, because creating a session also creates its folders (`services/claim-session.ts:280`). The claim takes the host and makes the folders on that host. The `host_id` column on `sessions` is written in that step and never changed (req 9). An empty value means the main host.
- **New-session screen (req 8, 10).** A host picker next to the role, harness and model pickers (`src/client/components/MessageInput/MessageInput.tsx:1340-1411`). Hosts that are off are grayed out.
  - On `/new`, ShipIt claims a warm draft on the main host at once (`src/client/hooks/useSessionActivation.ts:92-142`). When the user picks a secondary host, ShipIt discards that draft and claims a new one on the chosen host.
  - Secondary hosts keep no warm pool in this version, so their sessions start cold.
- **Child sessions (req 2, 16 to 18).**
  - `shipit session create` gets `--request-gpu`, parsed with the other flags (`src/server/session/agent-shim/shipit-session.ts:59-80`) and sent to the spawn route (`api-routes-session-spawn.ts:211`).
  - The spawn service (`services/child-sessions.ts:171`) asks the placement strategy for a host before it claims.
  - The first strategy: a GPU request goes to a host that is on, has the GPU setting on, and has room in its memory budget. Every other child goes to the main host (req 17).
  - Nothing else names a host for a child: not a role (req 10), and not a flag (`--host` is a later version).
- **Refusals (req 19, 22, 23).**
  - No GPU host is on: the spawn route refuses with 409 before it claims. The CLI says why, and the parent's chat shows the `session_spawn_failed` card (`api-routes-session-spawn.ts:333-378`).
  - Docker on the chosen host cannot give the GPU: the host agent does not fall back to a container without the GPU. Today's fallback (`container-lifecycle.ts:880-913`) stays for sessions that did not request a GPU (docs/325-session-gpu-access req 6).
  - For a GPU request, the spawn starts the child's container before it graduates the draft and dispatches the first turn. Today the order is graduate (`services/child-sessions.ts:497`), then create the runner (`:518`), then dispatch (`:535`). When the container cannot get the GPU, the spawn discards the draft and its folders and refuses. Tests cover both refusals: no GPU host on, and a GPU that Docker cannot give.
  - The refusal message and `src/server/shipit-docs/sessions.md` tell the agent that it may start the session again without `--request-gpu`, but only when the user insists (req 23).

## 6. A host that is off (req 8, 9, 11)

- A host is off when its tunnel is down. It turns gray at once.
- Its sessions stay on it (req 9). The session list shows them as "host off".
- **One check for every way in.** A host-off check sits in front of each path that can start work in a session, before anything is written:
  - a user message, in `handleSendMessage` (`ws-handlers/send-message.ts:105`);
  - an agent message, in `deliverSessionMessage` (`services/child-sessions.ts:733`), which both `sendChildMessage` and an approved proposed message (`api-routes-propose-session-message.ts:254`) reach, before it stores the card;
  - turns that ShipIt starts by itself — schedules, CI fixes, conflict fixes — which skip such a session and log it.

  Today an agent message always goes to the inbox; refusing it for a host that is off is the one new refusal (req 11). A refusal that the chat shows as a card is persisted with `emitChatCard` (`CLAUDE.md`, "Chat transcript content MUST be persisted").
- **The composer** shows why it is disabled: a new "host off" reason beside today's model-provider reason (`src/client/utils/chat-runnable.ts:35-41`).
- **A turn that is running when the tunnel drops** keeps running on the host. When the tunnel comes back, the main server reconnects to the worker's `/events` stream from the last event it saw (`sse-connection-manager.ts:78`) and catches up.
- **Post-turn work after an outage.** A turn can end while its tunnel is down. The post-turn lease ends after 120 seconds (`post-turn-hold.ts:1`), and the local commit must come before the queue drains (`turn-executor.ts:1262`; `CLAUDE.md`, "Post-turn flow", invariants 1 and 2). So the main server records in its database that the session owes its post-turn steps. It records this when the tunnel drops during a turn or during its post-turn work, and when a post-turn git call fails because the tunnel is down. When the tunnel comes back, it runs them — the commit through `WorkspaceGit` first — before it lets the session's queue continue. Today a failed commit still lets the queue drain (`turn-executor.ts:1355-1368`), so the record is cleared only when the commit has run with the tunnel up; a commit that fails for another reason is handled as today. Running the auto-commit again is safe, because on a clean tree it does nothing (`src/server/shared/git.ts:355-360`). The PR card and the auto-push run after that commit, as today.
- **When the tunnel comes back,** the host agent sends its full container list. The main server reattaches the sessions, as adoption does after a restart (`container-discovery.ts:105-174`), and the host turns on.

## 7. Subsystems for each host

| Subsystem | Today (one host) | With secondary hosts |
|---|---|---|
| Docker events | One subscription on the local socket (`container-health.ts:84-89`) and one router with one backstop listing (`service-event-router.ts:215-263`) | The host agent runs the subscription and one backstop listing on its host, and sends the same routed events through the tunnel. No per-session polling (`CLAUDE.md`, "Compose service status is event-driven"). A failed listing marks only that host's sessions; today it marks every session (`service-event-router.ts:237-246`). |
| Compose | The CLI on the orchestrator's daemon; files in the session folder (`compose-cli.ts`, `compose-helper.ts`) | Runs in the host agent, where the files are. |
| Memory budget (req 21) | One budget; statistics summed over every container on the local daemon (`docker-memory.ts`, `startup-monitors.ts:71-98`) | One budget for each host, from that host's statistics. The main server's idle enforcer decides for each host, and the host agent stops containers. |
| Warm pool | One warm session for each repository, on the main host (`warm-pool-manager.ts:221-318`) | Main host only. |
| Disk | Janitor, tier escalation and steady-state reclaim on `stateDir` (`startup-janitor.ts`, `tier-escalation.ts`, `steady-state-reclaim.ts`) | Each host agent runs them on its data directory. The main server tells it which sessions exist. |
| Caches | Bare repository cache, dependency cache and overlay dependency store on `stateDir` (`session-dir-factory.ts:47-69`, `overlay-volume.ts`) | Dependency cache and overlay dependency store for each host. No bare cache on secondary hosts in this version. |
| Ops session (req 20) | Read-only Docker through the ops proxy, and the host journal (`container-lifecycle.ts:446-447`, `:335-346`) | The same template on the chosen host, built by its host agent. |

## 8. What does not change on the main host

Sessions on the main host keep today's code: direct Docker, direct git, direct files, and caller identity by IP. The first steps only put that code behind the `SessionHost` and `WorkspaceGit` interfaces. A later version could run the main host through a local host agent too, for one code path. These requirements do not need it.

## Phases

| Phase | Content | Size (estimate) |
|---|---|---|
| 1 | First, with no change that the user can see: the callback token for each session, and the `SessionHost` and `WorkspaceGit` interfaces with today's code as the main-host implementation. Then the host agent, the tunnel with its callback checks, the hosts table and Settings → Hosts, the host picker with grayed-out hosts, placement before the claim, the host-off checks and the post-turn catch-up, worker, terminal, preview and callback traffic, git and files on the host, and events, Compose, egress, memory budget, disk and the GPU setting for each host. After this phase the user can start GPU sessions on the workstation by hand. | XL |
| 2 | `--request-gpu`, the placement strategy, the refusals and the retry. Docker access for each host, with the Docker proxy in the host agent. Ops sessions on secondary hosts. With this phase every requirement except req 15 is met. | M |
| 3 (priority 2) | The main server can ask a host agent to update itself (req 15). | S |

## Not verified

- The host agent on Docker Desktop with WSL2: that its container can join session networks and reach session containers, as the orchestrator does on its own host.
- The address that the main server sees for a tunnel from a Docker Desktop container through Tailscale on Windows. It must match the address in the hosts table.
- How far back the worker's `/events` stream can replay after a long tunnel outage.
- The host journal mounts of an ops session on Docker Desktop, where the "host" is Docker Desktop's VM.
- Preview speed for a web game through the main server.
- On Docker Desktop and on Docker Engine: that a session's uid cannot open the Docker socket in the host agent's container, and that git can drop to the session's uid on the host agent's data directory.
- The download size of a fresh clone with no bare cache.

## Key files (today)

`container-lifecycle.ts`, `session-container.ts`, `container-config-builder.ts`, `egress-firewall-install.ts`, `docker-proxy.ts`, `compose-generator.ts`, `compose-helper.ts`, `compose-cli.ts`, `service-manager.ts`, `container-health.ts`, `service-event-router.ts`, `idle-enforcer.ts`, `warm-pool-manager.ts`, `worker-http.ts`, `api-container-guard.ts`, `preview-proxy.ts`, `repo-git.ts`, `ws-handlers/post-turn.ts`, `services/claim-session.ts`, `services/child-sessions.ts`, `api-routes-session-spawn.ts`, `turn-executor.ts`, `src/server/session/agent-shim/shipit-session.ts`, `src/client/components/MessageInput/MessageInput.tsx`.
