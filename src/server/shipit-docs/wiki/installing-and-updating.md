# Installing, updating, and reaching ShipIt

This page has two readers.

**If you are inside a ShipIt session**, the user is asking about the install
that is running them. You cannot change it from in here — a session container
has no reach over its host. Answer the question, name the panel where the
control is, and where there is no control, say that the step needs an agent with
a shell on the host machine. That is still not work for the user to type.

**If you are on the user's own machine with a shell**, this is yours to do. The
user asked you to install or update ShipIt because they would rather not run
installer commands themselves. Ask them the questions, then run it.

## Installing

Two paths, and the difference is what the machine is for.

| Path | For | Result |
|---|---|---|
| **Local** | A laptop or desktop. macOS, Linux, or Windows via WSL2. | Installed under `~/.shipit`, running detached at `http://localhost:4123`, bound to loopback only |
| **VPS** | An always-on Linux server, Ubuntu 24.04 | Same, plus an access layer (Cloudflare Tunnel with Zero Trust sign-in, Tailscale, or both) and updates from the UI |

Both need Docker — Docker Desktop, or Docker Engine with the Compose v2 plugin —
but they differ in who provides it. The **VPS** installer runs as root on an
Ubuntu host and installs Docker Engine and the Compose plugin itself if they are
missing. The **local** installer does not: it checks, and tells the user how to
get Docker, because installing Docker Desktop on someone's laptop is not its
call.

### Doing it for the user

The installers are built to be run by an agent. Do it in this order.

**1. Read the questions before deciding anything.** Both installers print their
own questions as JSON and exit. This needs no root, writes nothing, clones
nothing, and installs nothing, so it is safe to run before the user has even
decided to install:

```bash
# Local
bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh) --describe

# VPS — the one-liner shape cannot take an argument, so use the variable
SHIPIT_DESCRIBE=1 bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/vps/setup.sh)"
```

Each question carries its options, its default, the variable that answers it,
and whether it is always asked or only in one case.

**2. Put every question to the user, and use their answer.** Collect the
conditional ones up front — an install that has started cannot stop to ask. Two
answers matter more than the rest:

- **Which agent CLIs to install.** They are baked into the images, so this is an
  install-time choice, not a setting. Changing it later means editing the answer
  and running the deploy again.
- **Agent network containment**, asked only on a host that cannot run the
  containment sidecar. Answering `off` there means a prompt-injected agent could
  send credentials out. Leaving it unanswered keeps containment **on** — an
  agent cannot switch it off by omitting the question, and you should not try.

**3. Run the install with the answers as variables.** It is the same command
everyone else uses; an answered question is simply never asked.

```bash
SHIPIT_HARNESSES=claude,codex \
  bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)
```

Every answer variable is tabulated in
[`deployment/README.md`](https://github.com/nikzlabs/shipit/blob/stable/deployment/README.md).
The Cloudflare API token among them is a secret: export it for the one command,
and never write it to a file, a log, or a commit.

### Which agent CLIs

A harness is an agent CLI plus the adapter that normalizes its events. The
default set is **Claude Code, Codex, and OpenCode**; Grok Build and Antigravity
are offered but not preselected, so an update never adds a CLI to the images
behind the user's back. Narrowing the set is worth it if image size or build
time matters.

Two things users are surprised by, so say them before they find out:

- **There is nothing in Settings that adds or removes a harness.** It is a build
  input. Changing it means editing `SHIPIT_HARNESSES` in the env file
  (`~/.shipit/.shipit.env` locally, `/etc/shipit/shipit.env` on a VPS) and
  re-running the deploy.
- **An installed harness still needs credentials** — an account or an API key
  connected in Settings → Integrations — before it can run a turn.

## Sizing the machine

Every active session runs its own container, and so does every Compose service
in the user's project. **8 GB of RAM is the floor, 16 GB is comfortable.** A
machine that is too small does not fail loudly; it reclaims idle sessions more
aggressively, which the user experiences as sessions that keep losing their
previews.

Inside ShipIt, the memory budget that decides that reclaim is a setting the
user owns. Do not guess its value — `shipit settings list` prints it.

## Updating

**Which path applies depends on how ShipIt was installed, so establish that
first.** Settings → Advanced → Software Updates has **Check for Updates** on
every install, but the **Update Now** button that follows it appears only on an
install that manages its own updates — the VPS path. A local install can see
that an update exists and cannot apply it from the UI; it updates by running
`~/.shipit/deployment/local/update.sh` on the host.

So, from inside a session: tell the user what their install can do, and if it is
the local kind, say the update needs an agent with a shell on that machine
rather than leaving them at a button that is not there.

**Release channels**, chosen in the same panel:

- **Stable** — only vetted, tagged releases. The default for new installs.
- **Edge** — every merge to `main`. For people who want changes early.

Moving from edge to a stable release that is *behind* the running code is a
downgrade, and ShipIt warns before applying it, because older code may not read
newer on-disk data cleanly.

**"Will updating interrupt what I'm working on?"** Not immediately. A deploy
deliberately does not kill running session containers — they keep the image they
started on until they go idle, and new sessions get the new one right away. The
one case where that bites is a **newly added agent CLI**: a session that was
already open is running a container without it, and a turn on that harness fails
there until the container is replaced. Closing the session, or letting it go
idle, is the whole fix.

**From a shell on the machine:** a local install updates with
`~/.shipit/deployment/local/update.sh`. A VPS install re-deploys from
`/opt/shipit`, honouring the channel recorded in `/opt/shipit/.release-channel`.
Both are spelled out in `deployment/README.md`; run them for the user rather
than pasting them at them.

## Reaching it from a phone or another machine

**A local install binds to loopback and must stay that way by default.** ShipIt
has no built-in authentication: anything that can reach it has a shell and the
user's repositories. So the question is never "which port do I open" — it is
which access layer to use.

| Want | Do |
|---|---|
| Reach a laptop install from a phone | `~/.shipit/deployment/local/tailscale.sh` — records the opt-in, restarts ShipIt, prints the URL |
| A server anyone on the tailnet can reach | Tailscale, chosen during the VPS install or added later |
| A public HTTPS address with SSO | Cloudflare Tunnel with Zero Trust, chosen during the VPS install |

Two practical notes that come up constantly:

- **Use the printed hostname, never the raw IP.** Previews are served at
  `{session}--{port}.<host>`, and an IP address cannot carry a wildcard
  subdomain. A raw IP gives a working app and blank previews.
- **Publishing to the LAN** (`SHIPIT_BIND_ADDR=0.0.0.0`) exposes an
  unauthenticated agent with a shell to that network. Only on a network the user
  controls, and not behind a host firewall they are trusting to contain it —
  Docker's published-port rules bypass `ufw`, and the macOS firewall is off by
  default.

## Stopping and removing

**Stopping** preserves the workspace and credentials volumes, so sessions and
provider sign-ins survive: `deployment/local/stop.sh`, or
`/opt/shipit/deployment/vps/stop.sh` on a server.

**Removing it entirely** is two steps, and there is no single uninstall command
to reach for. `stop.sh --purge` deletes the workspace and credentials volumes —
every session and every provider sign-in — and then the install directory
(`~/.shipit`, or `/opt/shipit`) is deleted by hand. The purge is irreversible
and takes the user's sessions with it: confirm it out loud before running it,
and never infer it from "uninstall ShipIt" alone.

## When it will not start

From a shell on the host, in this order: the orchestrator's own logs
(`docker compose -f deployment/vps/docker-compose.yml logs -f shipit`), the
access layer's logs (`journalctl -u cloudflared -f`), the updater's
(`journalctl -u shipit-updater -f`), and what containers are actually up
(`docker ps --filter "label=shipit-stack=shipit"`). Read the logs and tell the
user what they say; do not hand them the commands.

From inside an ordinary session you can see none of that, and there is no Host
tab to send them to — that tab exists only in an Ops session. Say so, and offer
**Investigate in Ops session** from the session's menu, which is the route from
a session to ShipIt's own view of the machine.
