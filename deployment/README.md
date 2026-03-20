# Deploying ShipIt to Hetzner Cloud

Self-host ShipIt on a Hetzner VPS with automatic deploys on push.

## What you get

- ShipIt at `https://shipit.example.com` with SSL via Cloudflare
- Password-protected access (HTTP basic auth via Caddy)
- Preview subdomains (`{sessionId}--{port}.shipit.example.com`)
- Auto-deploy on push to `main` via GitHub Actions

## Prerequisites

- Hetzner Cloud account — CX32 (4 vCPU, 8GB RAM, ~€7/mo) recommended
- Domain with DNS control (e.g. `example.com` on Cloudflare)
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

## Step 3: Configure Cloudflare DNS and SSL

In your Cloudflare dashboard for the domain:

1. **Add DNS records** (DNS → Records):

   | Type | Name               | Value          | Proxy |
   |------|--------------------|----------------|-------|
   | A    | `shipit`           | `<server-ip>`  | Proxied (orange cloud) |
   | A    | `*.shipit`         | `<server-ip>`  | Proxied (orange cloud) |

   The wildcard record enables preview subdomains for dev servers.

2. **Set SSL mode** (SSL/TLS → Overview): Select **Full**. This tells Cloudflare to connect to your server over HTTPS (Caddy serves a self-signed cert internally).

3. **Enable wildcard subdomains** (SSL/TLS → Edge Certificates): Verify that your Cloudflare plan covers wildcard subdomains (all paid plans do; free plans cover `*.example.com` but not `*.shipit.example.com` — you may need to use a direct subdomain like `*.shipit.com` or upgrade).

## Step 4: Provision the server

```bash
ssh -i ~/.ssh/shipit-deploy root@<server-ip>

# Download and run the provisioning script
curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/hetzner/setup.sh -o setup.sh
bash setup.sh
```

The script will prompt for your domain and web UI credentials, then automatically:
- Clone the repo to `/opt/shipit`
- Install Docker and Caddy
- Configure the firewall
- Set up basic auth
- Build and start ShipIt

Once complete, visit `https://shipit.example.com` — log in with the credentials you chose, then complete Claude CLI OAuth.

## Step 5: Set up auto-deploy

Add these secrets to your GitHub repo (Settings → Secrets → Actions):

| Secret           | Value                                                    |
|------------------|----------------------------------------------------------|
| `DEPLOY_HOST`    | Server IP or `shipit.example.com`                             |
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

**Check Caddy logs:**
```bash
journalctl -u caddy -f
```

**Restart everything:**
```bash
docker compose -f deployment/hetzner/docker-compose.yml restart
systemctl restart caddy
```

**Check session containers:**
```bash
docker ps --filter "label=shipit-stack=shipit"
```
