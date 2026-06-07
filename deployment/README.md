# Deploying ShipIt

Two install paths, deliberately aligned:

- **Local** (`deployment/local/`) — run ShipIt on your own macOS or Linux machine, bound to
  localhost. One-line install, manual updates, no access layer.
- **VPS** (`deployment/vps/`) — an always-on Linux server with optional Cloudflare Tunnel and/or
  Tailscale access and UI-driven self-updates.

---

## Local install (macOS + Linux)

One command clones ShipIt to `~/.shipit`, builds the images, and starts it detached at
`http://localhost:4123`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/local/setup.sh)
```

It checks for `git` + Docker (with the Compose v2 plugin) and tells you how to install them if
missing — it never installs Docker for you. On Linux it raises inotify watcher limits if it can get
root/sudo; on macOS the Docker Desktop VM manages its own. No Cloudflare, Tailscale, or systemd is
involved — local binds to localhost only.

Overrides (set before the command):

- `SHIPIT_REPO_URL=https://github.com/you/shipit.git` — install a fork.
- `SHIPIT_HOME=/path/to/dir` — install somewhere other than `~/.shipit`.

Day-to-day, from your checkout (default `~/.shipit`):

```bash
# Update to the latest code on your release channel, then rebuild + restart
~/.shipit/deployment/local/update.sh

# Stop ShipIt and clean up session containers (keeps your data volumes)
~/.shipit/deployment/local/stop.sh
# ...or also delete the workspace/credentials volumes (destructive):
~/.shipit/deployment/local/stop.sh --purge
```

The local install runs in **manual update mode**: the channel selector in
**Settings → Advanced → Software Updates** works, but "Update Now" defers to `update.sh` rather than
updating in place (no host-side systemd watcher locally).

> Contributing to ShipIt? `docker/local/prod.sh` builds the prod images from your *current checkout*
> and runs them in the foreground — the prod counterpart of `docker/local/dev.sh` — for testing in a
> prod-like environment without installing into `~/.shipit`.

---

## Deploying ShipIt to a VPS

Self-host ShipIt on any Linux VPS with optional Cloudflare Tunnel and/or Tailscale access.

## What you get

- ShipIt at `https://shipit.example.com` with SSL via Cloudflare, tailnet-only HTTPS via Tailscale, or both
- Optional access control via Cloudflare Zero Trust (SSO, email allowlist, etc.)
- Preview subdomains through your chosen access hostname
- One-click updates from the ShipIt UI
- No open HTTP/HTTPS ports by default — ShipIt listens on localhost and access scripts proxy to it

## Prerequisites

- A Linux VPS — Ubuntu 24.04 is what the setup script targets. Recommended sizing: 8 GB RAM minimum, 16 GB recommended (each active session runs its own container).
- For Cloudflare: a domain on Cloudflare with **Advanced Certificate Manager** ($10/mo) if you need wildcard certs on nested subdomains (`*.shipit.example.com`). Alternatively, use a dedicated domain (e.g. `shipit.dev`) where the free plan's `*.shipit.dev` wildcard is sufficient.
- For Tailscale: access to a tailnet where you can authenticate this VPS.

## Step 1: Create server

1. Provision an Ubuntu 24.04 VPS with at least 8 GB of RAM
2. Note the server IP
3. SSH in as `root` (or as a user with sudo)

## Step 2: Provision the server

```bash
ssh root@<server-ip>
bash <(curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/vps/setup.sh)
```

The script will ask whether to install Cloudflare, Tailscale, both, or neither, then automatically:
- Install git and clone ShipIt to `/opt/shipit` (installing a fork? set `SHIPIT_REPO_URL=https://github.com/you/shipit.git` before the command)
- Install Docker
- Configure host limits needed for session containers and file watching
- Install the selected access path:
  - Cloudflare: install `cloudflared`, authenticate, create a tunnel, configure DNS routes, lock down the firewall, and optionally create a Zero Trust Access application + policy via the Cloudflare API
  - Tailscale: install Tailscale, authenticate the VPS, and expose ShipIt with Tailscale Serve
- Build and start ShipIt

You can also run either access setup later:

```bash
bash /opt/shipit/deployment/vps/cloudflare.sh
bash /opt/shipit/deployment/vps/tailscale.sh
```

### Cloudflare Zero Trust access control

The Cloudflare setup script can configure Zero Trust automatically if you provide a Cloudflare API token. To create one:

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create a token with **Account > Access: Apps and Policies > Edit** permission
3. Note your **Account ID** from the Cloudflare dashboard overview page

The script will ask for these values and create a self-hosted Access application covering `shipit.example.com` and `*.shipit.example.com`, with an allow policy for your email or email domain.

If you skip this during setup, you can configure it later in the [Zero Trust dashboard](https://one.dash.cloudflare.com) under **Access → Applications**, or rerun `cloudflare.sh`.

Users authenticate through Cloudflare before reaching ShipIt. You can use any identity provider Cloudflare supports (Google, GitHub, one-time PIN, etc.).

Once Cloudflare setup is complete, visit `https://shipit.example.com` — authenticate through Zero Trust if configured, then complete Claude CLI OAuth.

## Updating

ShipIt updates itself from the UI. Go to **Settings → Advanced → Software Updates** and click **Check for Updates**. If an update is available, click **Update Now** — ShipIt will pull the latest code for your release channel, rebuild, and restart automatically.

### Release channels

ShipIt instances track one of two channels, selectable in the same Software
Updates panel:

- **Stable** (default for new installs) — advances only to vetted, tagged
  releases (`vX.Y.Z`). Fewer updates, lower risk. Tracks `origin/stable`.
- **Edge** — tracks `main`, updated on every merge. For early adopters and
  contributors who want the latest changes.

The choice is stored in `/opt/shipit/.release-channel` (untracked, so it
survives updates and rebuilds). Existing installs that upgrade into this feature
default to **edge** so their behavior doesn't change; the selector lets them opt
into stable.

Switching from edge to a stable release that is *behind* your current code is a
**downgrade** — the UI warns before applying, because older code may not read
newer on-disk data cleanly.

See [`../RELEASING.md`](../RELEASING.md) for how maintainers cut a stable release.

To update or restart manually via SSH (channel-aware):

```bash
ssh root@<server-ip>
cd /opt/shipit
CHANNEL="$(cat .release-channel 2>/dev/null || echo edge)"
case "$CHANNEL" in stable) REF=origin/stable;; *) REF=origin/main;; esac
git fetch origin --tags --prune && git reset --hard "$REF"
bash deployment/vps/deploy.sh
```

## Stopping ShipIt

To fully shut ShipIt down and clean up its session containers and networks:

```bash
ssh root@<server-ip>
bash /opt/shipit/deployment/vps/stop.sh
```

This stops the orchestrator and removes leftover session containers, but **preserves** the
`workspace` and `credentials` volumes so your sessions and provider sign-ins survive. Add `--purge`
to also delete those volumes (destructive). To bring it back up afterwards, run
`bash /opt/shipit/deployment/vps/deploy.sh`.

## Tailscale private access

You can add tailnet-only access during `setup.sh`, or later:

```bash
ssh root@<server-ip>
bash /opt/shipit/deployment/vps/tailscale.sh
```

The script installs Tailscale if needed, authenticates the VPS, sets the node hostname to `shipit` by default, and forwards the node's tailnet IP to ShipIt's localhost listener so you reach it at `http://shipit.tailnet.ts.net:4123`. Any Cloudflare tunnel you configured separately continues to serve `https://shipit.example.com` and `*.shipit.example.com`.

### Subdomain previews over Tailscale

ShipIt previews are served on subdomains (`{sessionId}--{port}.shipit.tailnet.ts.net`). Tailscale Serve can't carry those (it binds only the node's own name), so the script instead runs a Host-preserving TCP forwarder bound to the node's tailnet IP and relies on **native MagicDNS wildcard resolution** so `*.shipit.tailnet.ts.net` resolves to the node.

That wildcard is an opt-in capability you grant once. After running the script, add the `nodeAttrs` block it prints to your [tailnet policy file](https://login.tailscale.com/admin/acls):

```json
"nodeAttrs": [
  { "target": ["<node-tailscale-ip>"], "attr": ["dns-subdomain-resolve"] }
]
```

Requirements and caveats:

- **Tailscale v1.96+** on the VPS *and* on the devices you browse from (the capability is GA in current releases; it is not in older clients).
- **HTTP only** — there is no wildcard TLS cert for `*.ts.net` ([tailscale/tailscale#7081](https://github.com/tailscale/tailscale/issues/7081)). This is safe because tailnet traffic is already WireGuard-encrypted end to end.
- Until the grant is added, the app works over Tailscale but previews won't resolve.

If you'd rather not edit the tailnet policy, you can instead point a wildcard DNS record you control (`*.shipit-tail.example.com`) at the node's Tailscale IP and open ShipIt through that hostname — that path also gives you real HTTPS, at the cost of owning a domain. The setup script automates only the native-MagicDNS path.

For unattended setup, provide an auth key:

```bash
SHIPIT_TAILSCALE_AUTHKEY=tskey-auth-... bash /opt/shipit/deployment/vps/tailscale.sh
```

## Troubleshooting

**Check orchestrator logs:**
```bash
docker compose -f deployment/vps/docker-compose.yml logs -f shipit
```

**Check Cloudflare tunnel logs:**
```bash
journalctl -u cloudflared -f
```

**Check updater logs:**
```bash
journalctl -u shipit-updater -f
```

**Rebuild and restart Cloudflare access:**
```bash
bash /opt/shipit/deployment/vps/deploy.sh
systemctl restart cloudflared
```

**Check session containers:**
```bash
docker ps --filter "label=shipit-stack=shipit"
```
