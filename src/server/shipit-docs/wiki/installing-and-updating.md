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

## Backing up, and moving to another machine

**Say the honest thing first: ShipIt has no backup feature.** There is no export,
no import, no snapshot button, and no migration command — not in Settings, not in
the installers, not in the `shipit` CLI. Do not go looking for one, and do not
imply one exists. What there is instead is worth knowing precisely, because most
of what the user is afraid of losing is not in ShipIt at all.

**From inside a session, none of this is yours to do.** A session container
cannot see the host's Docker volumes. Answer what the data is and where it
lives, say what is already safe on the git remote, and say that taking or
restoring a copy needs an agent with a shell on the host machine.

### What actually holds the data

Two Docker named volumes, and nothing else the user cares about. The install
directory is not one of them.

| Holds | Volume | Path in it |
|---|---|---|
| Chat history, the session list, rewind snapshots, usage, the repository list, per-project secrets | **workspace** | `.shipit.db` |
| Every session's checkout and its branch | **workspace** | `sessions/<session-id>/workspace` |
| Bare repository caches and dependency caches — rebuildable, just slow | **workspace** | `repo-cache/`, `dep-cache/` |
| Provider sign-ins, the GitHub token, agent roles, most settings | **credentials** | `shipit-credentials.json` |
| The key that decrypts the stored secrets | **credentials** | `secret-key` |
| The agent's per-repository memory | **credentials** | `repo-memory/` |

The volume names differ by install path, because the Compose project name does:

| Install | Volumes |
|---|---|
| Local | `shipit-prod_workspace`, `shipit-prod_credentials` |
| VPS | `shipit_workspace`, `shipit_credentials` |

**The two volumes travel together or neither does.** Project secrets are stored
encrypted in the database, which is in the *workspace* volume, under a key that
is in the *credentials* volume by default. A copy of one without the other
restores secrets that nothing can read. (An install given its key from the
outside instead — `SHIPIT_SECRET_KEY` or `SHIPIT_SECRET_KEY_FILE` — keeps that
key wherever the operator put it, and a restore needs it too.)

**The install directory — `~/.shipit` locally, `/opt/shipit` on a server — is a
plain git clone of ShipIt.** The installer recreates it, so it does not need
backing up. The one part of it that is not on the remote is the env file of
install answers (`~/.shipit/.shipit.env`, or `/etc/shipit/shipit.env`), which is
worth reading before a move and may contain a Cloudflare API token. Treat it as
a secret.

### What survives with no backup at all

A great deal, and this is usually the answer the user actually needs. ShipIt
commits after every turn and pushes the branch, and archiving a session refuses
to reclaim its checkout unless it can confirm the branch is on the remote. So:

| The user fears losing | Reality |
|---|---|
| Their code and branches | On GitHub. A destroyed host does not take them. |
| Their pull requests | On GitHub, with their review history. |
| Their repositories | ShipIt stores a list of URLs; re-adding one re-clones it. |
| Their sessions | **Only in the workspace volume.** The conversation, the rewind points, and the session's own history are not on any remote. |
| Their provider sign-ins | **Only in the credentials volume.** Lost with it — the user signs in again in Settings → Integrations. |
| Their settings and stored secrets | **Only in the volumes.** Not recoverable, and the secrets need both. |

So the loss from a destroyed host without a backup is the conversation and the
configuration, not the work. Say that plainly — it is much less alarming than
the user expects, and it is true.

### Taking a copy, from a shell on the host

There is no supported procedure, so this is ordinary Docker rather than a ShipIt
feature — say so when you offer it. Two things make it go wrong, and both are
avoidable.

**Stop ShipIt first.** The database is live and so are the checkouts; a copy
taken while it runs can be torn. `~/.shipit/deployment/local/stop.sh`, or
`/opt/shipit/deployment/vps/stop.sh` — **without** `--purge`, which is the
opposite of a backup.

**Preserve numeric ownership.** Each session directory is owned by its own
dedicated uid, and ShipIt derives a session's git identity from that ownership.
A copy that flattens it produces permission errors that read as impossible on a
root process, and that is a genuinely expensive thing to debug.

```bash
# Back up — substitute the volume names for the install path.
for v in shipit_workspace shipit_credentials; do
  docker run --rm -v "$v":/src:ro -v "$PWD":/out alpine \
    tar -C /src -cpf "/out/$v.tar" --numeric-owner .
done

# Restore onto a stopped install. Replace the volume, do not extract over it.
for v in shipit_workspace shipit_credentials; do
  docker volume rm "$v" >/dev/null 2>&1 || true
  docker volume create "$v" >/dev/null
  docker run --rm -v "$v":/dst -v "$PWD":/in alpine \
    tar -C /dst -xpf "/in/$v.tar" --numeric-owner
done
```

**The restore replaces each volume rather than unpacking into it**, which is why
it removes them first. A fresh install has already created its own session
directories and its own database; extracting on top would keep the directories
and overwrite the database, leaving checkouts on disk that no session row knows
about.

**The resulting tarballs are the install.** They carry the GitHub token, every
provider sign-in, and the key that decrypts the secrets sitting beside them. Do
not write them anywhere the user would not put a password, and do not commit
them.

### Moving an install to another machine

Same two volumes, in this order. It works in either direction — a laptop install
and a server install use the same container paths inside the volume, so each can
restore the other's.

1. **Read the old install's env file** and install on the new machine with the
   same answers. `SHIPIT_HARNESSES` is the one that matters: agent CLIs are baked
   into the images, so an install built with a narrower set cannot run a harness
   the old one could.
2. **Stop both**, with `stop.sh` and no `--purge`.
3. **Copy the two volumes across** with the commands above, renaming them if the
   install paths differ.
4. **Bring the new one up** — `/opt/shipit/deployment/vps/deploy.sh` on a server,
   `~/.shipit/deployment/local/update.sh` locally.

Three things do not come along, and none of them is data:

- **The images.** The installer rebuilds them on the new machine.
- **The access layer.** A Cloudflare tunnel and a Tailscale node are bound to the
  old host; set up access again on the new one.
- **Running session containers.** They are disposable — ShipIt recreates one when
  the session is next opened, from the checkout that did travel.

### The one control that destroys this

**Reset Container**, in Settings → Advanced, empties the workspace volume —
every session, all chat history, every checkout and cache — and leaves the
credentials volume alone, so provider sign-ins survive it. It is the user's
click, and the button arms on the first press and fires on the second. It cannot
be undone, and no backup exists unless someone took one first — say that before
they reach for it.

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
