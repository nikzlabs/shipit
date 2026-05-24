# Deploying ShipIt to Hetzner Cloud

Self-host ShipIt on a Hetzner VPS with optional Cloudflare Tunnel and/or Tailscale access.

## What you get

- ShipIt at `https://shipit.example.com` with SSL via Cloudflare, tailnet-only HTTPS via Tailscale, or both
- Optional access control via Cloudflare Zero Trust (SSO, email allowlist, etc.)
- Preview subdomains through your chosen access hostname
- One-click updates from the ShipIt UI
- No open HTTP/HTTPS ports by default — ShipIt listens on localhost and access scripts proxy to it

## Prerequisites

- Hetzner Cloud account — CX32 (4 vCPU, 8GB RAM, ~€7/mo) recommended
- For Cloudflare: a domain on Cloudflare with **Advanced Certificate Manager** ($10/mo) if you need wildcard certs on nested subdomains (`*.shipit.example.com`). Alternatively, use a dedicated domain (e.g. `shipit.dev`) where the free plan's `*.shipit.dev` wildcard is sufficient.
- For Tailscale: access to a tailnet where you can authenticate this VPS.

## Step 1: Create server

1. Create a Hetzner CX32 server with Ubuntu 24.04
2. Note the server IP
3. SSH in with the root password Hetzner provides (or add your SSH key during creation)

## Step 2: Provision the server

```bash
ssh root@<server-ip>

apt-get update -qq && apt-get install -y -qq git
git clone https://github.com/nicholasalt/shipit.git /opt/shipit
bash /opt/shipit/deployment/vps/setup.sh
```

The script will ask whether to install Cloudflare, Tailscale, both, or neither, then automatically:
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

ShipIt updates itself from the UI. Go to **Settings → Advanced → Software Updates** and click **Check for Updates**. If an update is available, click **Update Now** — ShipIt will pull the latest code, rebuild, and restart automatically.

To update or restart manually via SSH:

```bash
ssh root@<server-ip>
cd /opt/shipit && git pull origin main
bash deployment/vps/deploy.sh
```

## Tailscale private access

You can add tailnet-only access during `setup.sh`, or later:

```bash
ssh root@<server-ip>
bash /opt/shipit/deployment/vps/tailscale.sh
```

The script installs Tailscale if needed, authenticates the VPS, sets the node hostname to `shipit` by default, and runs Tailscale Serve as a private reverse proxy to ShipIt's localhost listener. Any Cloudflare tunnel you configured separately continues to serve `https://shipit.example.com` and `*.shipit.example.com`.

Production ShipIt is configured with `SHIPIT_PREVIEW_SUBDOMAINS=always`, so Tailscale access also expects wildcard preview DNS for the hostname you open in the browser. MagicDNS alone gives you `shipit`, but not `*.shipit`. For robust previews over Tailscale, add a private DNS wildcard such as `shipit-tail.example.com` and `*.shipit-tail.example.com` pointing at the VPS's Tailscale IP, then open ShipIt through that hostname.

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
