# Deploying ShipIt to Hetzner Cloud

Self-host ShipIt on a Hetzner VPS with automatic deploys on push.

## What you get

- ShipIt at `https://shipit.example.com` with auto-TLS
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

## Step 3: Configure DNS

Add these records (example uses Cloudflare):

| Type | Name               | Value          |
|------|--------------------|----------------|
| A    | `shipit.example.com`   | `<server-ip>`  |
| A    | `*.shipit.example.com`  | `<server-ip>`  |

The wildcard record enables preview subdomains for dev servers.

## Step 4: Provision the server

```bash
ssh -i ~/.ssh/shipit-deploy root@<server-ip>

# Download and run the provisioning script (clones the repo, installs Docker, Caddy, firewall)
curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/hetzner/setup.sh -o setup.sh
bash setup.sh

# Generate a password hash for the web UI login
caddy hash-password --plaintext 'your-secure-password'
# Copy the output hash, then:
cat > /etc/caddy/environment <<EOL
CLOUDFLARE_API_TOKEN=your-token-here
SHIPIT_AUTH_USER=admin
SHIPIT_AUTH_HASH=JDJhJDE0JC...your-bcrypt-hash-here
EOL

systemctl enable --now caddy

# Build and start ShipIt
cd /opt/shipit
docker compose -f deployment/hetzner/docker-compose.yml build
docker compose -f deployment/hetzner/docker-compose.yml up -d
```

Visit `https://shipit.example.com` — log in with the username/password you chose, then complete Claude CLI OAuth.

## Step 6: Set up auto-deploy

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
