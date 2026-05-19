# Deploying ShipIt to Hetzner Cloud

Self-host ShipIt on a Hetzner VPS with a Cloudflare Tunnel (no ports exposed).

## What you get

- ShipIt at `https://shipit.example.com` with SSL via Cloudflare
- Access control via Cloudflare Zero Trust (SSO, email allowlist, etc.)
- Preview subdomains (`{sessionId}--{port}.shipit.example.com`)
- One-click updates from the ShipIt UI
- No open HTTP/HTTPS ports — all traffic routes through the tunnel

## Prerequisites

- Hetzner Cloud account — CX32 (4 vCPU, 8GB RAM, ~€7/mo) recommended
- Domain on Cloudflare with **Advanced Certificate Manager** ($10/mo) — required for wildcard certs on nested subdomains (`*.shipit.example.com`). Alternatively, use a dedicated domain (e.g. `shipit.dev`) where the free plan's `*.shipit.dev` wildcard is sufficient.

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

The script will prompt for your domain, then automatically:
- Install Docker and `cloudflared`
- Authenticate with Cloudflare (prints a URL — open it in your browser)
- Create a tunnel and configure DNS routes
- Lock down the firewall (SSH only — no HTTP ports open)
- Optionally create a Zero Trust Access application + policy via the Cloudflare API
- Build and start ShipIt

### Zero Trust access control

The setup script can configure Zero Trust automatically if you provide a Cloudflare API token. To create one:

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Create a token with **Account > Access: Apps and Policies > Edit** permission
3. Note your **Account ID** from the Cloudflare dashboard overview page

The script will ask for these values and create a self-hosted Access application covering `shipit.example.com` and `*.shipit.example.com`, with an allow policy for your email or email domain.

If you skip this during setup, you can configure it later in the [Zero Trust dashboard](https://one.dash.cloudflare.com) under **Access → Applications**.

Users authenticate through Cloudflare before reaching ShipIt. You can use any identity provider Cloudflare supports (Google, GitHub, one-time PIN, etc.).

Once complete, visit `https://shipit.example.com` — authenticate through Zero Trust, then complete Claude CLI OAuth.

## Updating

ShipIt updates itself from the UI. Go to **Settings → Advanced → Software Updates** and click **Check for Updates**. If an update is available, click **Update Now** — ShipIt will pull the latest code, rebuild, and restart automatically.

To update or restart manually via SSH:

```bash
ssh root@<server-ip>
cd /opt/shipit && git pull origin main
bash deployment/vps/deploy.sh
```

## Troubleshooting

**Check orchestrator logs:**
```bash
docker compose -f deployment/vps/docker-compose.yml logs -f shipit
```

**Check tunnel logs:**
```bash
journalctl -u cloudflared -f
```

**Check updater logs:**
```bash
journalctl -u shipit-updater -f
```

**Rebuild and restart:**
```bash
bash /opt/shipit/deployment/vps/deploy.sh
systemctl restart cloudflared
```

**Check session containers:**
```bash
docker ps --filter "label=shipit-stack=shipit"
```
