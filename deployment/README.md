# Deploying ShipIt to Hetzner Cloud

Self-host ShipIt on a Hetzner VPS with a Cloudflare Tunnel (no ports exposed).

## What you get

- ShipIt at `https://shipit.example.com` with SSL via Cloudflare
- Access control via Cloudflare Zero Trust (SSO, email allowlist, etc.)
- Preview subdomains (`{sessionId}--{port}.shipit.example.com`)
- Auto-deploy on push to `main` via GitHub Actions
- No open HTTP/HTTPS ports — all traffic routes through the tunnel

## Prerequisites

- Hetzner Cloud account — CX32 (4 vCPU, 8GB RAM, ~€7/mo) recommended
- Domain on Cloudflare with **Advanced Certificate Manager** ($10/mo) — required for wildcard certs on nested subdomains (`*.shipit.example.com`). Alternatively, use a dedicated domain (e.g. `shipit.dev`) where the free plan's `*.shipit.dev` wildcard is sufficient.
- GitHub repo with Actions enabled

## Step 1: Create server

1. Create a Hetzner CX32 server with Ubuntu 24.04
2. Note the server IP

## Step 2: Generate a deploy SSH key

This key lets the GitHub Action SSH into your server to deploy. Generate it on your local machine:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/shipit-deploy -C "shipit-deploy" -N ""
```

Copy the public key to the server (Hetzner asks for a root password during server creation):

```bash
ssh-copy-id -i ~/.ssh/shipit-deploy.pub root@<server-ip>
```

You'll use the private key (`~/.ssh/shipit-deploy`) as a GitHub secret in Step 5.

## Step 3: Provision the server

```bash
ssh -i ~/.ssh/shipit-deploy root@<server-ip>

# Download and run the provisioning script
curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/hetzner/setup.sh -o setup.sh
bash setup.sh
```

The script will prompt for your domain, then automatically:
- Clone the repo to `/opt/shipit`
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

## Step 4: Set up auto-deploy

Add these secrets to your GitHub repo (Settings → Secrets → Actions):

| Secret           | Value                                                    |
|------------------|----------------------------------------------------------|
| `DEPLOY_HOST`    | Server IP                                                |
| `DEPLOY_SSH_KEY` | Contents of `~/.ssh/shipit-deploy` (the **private** key) |
| `DEPLOY_USER`    | `root`                                                   |

The deploy workflow is already at `.github/workflows/deploy.yml`. Every push to `main` will SSH into the server, pull, rebuild, and restart.

After this, you no longer need to SSH into the server yourself — all deploys go through GitHub Actions.

## Updating

Pushes to `main` auto-deploy. To deploy manually:

```bash
ssh root@<server-ip>
cd /opt/shipit
git pull
docker compose -f deployment/hetzner/docker-compose.yml build session-worker shipit
docker compose -f deployment/hetzner/docker-compose.yml up -d --no-build shipit
```

## Troubleshooting

**Check orchestrator logs:**
```bash
docker compose -f deployment/hetzner/docker-compose.yml logs -f shipit
```

**Check tunnel logs:**
```bash
journalctl -u cloudflared -f
```

**Restart everything:**
```bash
docker compose -f deployment/hetzner/docker-compose.yml restart
systemctl restart cloudflared
```

**Check session containers:**
```bash
docker ps --filter "label=shipit-stack=shipit"
```
