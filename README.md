<h1 align="center">
  <img src="src/client/public/favicon.svg" alt="ShipIt logo" width="36" height="36" valign="bottom">
  <span>&nbsp;ShipIt</span>
</h1>

<p align="center">
  <a href="https://github.com/nikzlabs/shipit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/nikzlabs/shipit/ci.yml?branch=main&amp;label=CI" alt="CI status"></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0">
  <img src="https://img.shields.io/badge/status-early%20public%20release-orange" alt="Status: early public release">
  <img src="https://img.shields.io/badge/runs%20on-Docker-2496ED?logo=docker&logoColor=white" alt="Runs on Docker">
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="ShipIt: chat, live preview, and the inline PR card in one screen" width="900">
</p>

<!-- TODO: 60-second demo video / live demo link. Installing means building Docker images, so a video
     lets people evaluate ShipIt before they spend that. Host it
     (YouTube/Loom/asciinema or an mp4 in docs/assets/) and link it here as a "▶ Watch the demo" line
     or a clickable thumbnail right under the hero image. -->

ShipIt is a browser-based, chat-driven IDE for running coding agents through your
**real engineering loop**.

- **Parallel sessions in isolated containers** — run many agents at once, each with its own branch
  and workspace, so nothing they do collides.
- **Web/Android preview per session** — every session runs its own instance of your full app
  stack, so the agent can build, run, and fix before you preview and merge.
- **Bring your own agent** — on the subscription or API key you already have (Anthropic, OpenAI,
  DeepSeek, OpenRouter, etc.).
  - Supported harnesses: Claude Code, Codex, OpenCode, and Grok Build. Cursor CLI support is
    coming.
- **The GitHub loop, inline** — work with PRs, CI, deploys, reviews, and issues, without leaving
  ShipIt.
- **Runs on Linux, macOS, and Windows (WSL2)** — in isolated Docker containers.
- **Ship from your phone** — mobile-first, with voice.

## Quickstart

### Let an agent install it

Tell an agent — Claude Code, Codex, or another — **"install ShipIt"**. Both installers describe
their own questions in JSON (`--describe`), so the agent asks you which agent CLIs to install and
how you want to reach ShipIt, then runs the install with your answers. It needs no root and
changes nothing to read the questions. See
[`deployment/README.md`](deployment/README.md#installing-with-an-agent).

Prefer to do it yourself? Both commands below are unchanged.

### Run locally

Run ShipIt on your own machine — Linux, macOS, or Windows via
[WSL2](https://learn.microsoft.com/windows/wsl/install).

```bash
# Needs Docker Desktop, or Docker Engine with the Compose v2 plugin (`docker compose`)
bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)
```

It asks which agent CLIs to install, then installs ShipIt under `~/.shipit`, builds the Docker
images, and starts it **detached** at [http://localhost:4123](http://localhost:4123). Fork
installs, custom paths, updates, and stop/uninstall are in
[`deployment/README.md`](deployment/README.md).

#### Reaching a local install from your phone

TL;DR: a local install binds to loopback, since ShipIt has no built-in authentication — reach it
over [Tailscale](https://tailscale.com/) with the provided script. More details in
[`deployment/README.md`](deployment/README.md#reaching-a-local-install-from-another-device-tailscale).

```bash
~/.shipit/deployment/local/tailscale.sh
```

### Run on a VPS

ShipIt ships with a one-command provisioning script for Ubuntu hosts. It installs Docker, raises the
inotify limits sessions need, and can put ShipIt behind a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(with Zero Trust SSO) or [Tailscale](https://tailscale.com/) — no open inbound ports. Plan for 8 GB
RAM minimum (16 GB recommended), since each active session runs its own container. Run it as root
(`sudo` is a no-op if you already are):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/vps/setup.sh)"
```

It asks which access path you want, then handles the rest — Docker, clone, host limits, image
builds, and the self-update systemd units. Updates land from the UI
(**Settings → Advanced → Software Updates**). Fork installs, host-side updates, sizing, access
policies, and troubleshooting are all in [`deployment/README.md`](deployment/README.md).

## Security

ShipIt runs AI-agent-written code on your repos and infrastructure, so it treats the agent as a
powerful but only semi-trusted actor. The headline defenses:

- **Container-isolated agents** — each session runs in its own container on an isolated network, as
  an unprivileged user with no Docker socket, so a prompt-injected command has a small blast radius.
- **Built-in per-agent firewall** — outbound traffic is default-deny, restricted to an allowlist
  (agent API, your git host, registries, your MCP servers) and fail-closed, so by default a
  compromised agent has no network path out to exfiltrate your credentials.
- **Brokered credentials** — GitHub and tracker tokens are handed out on demand, not stored at rest
  inside the session container; with a GitHub App, git uses short-lived, single-repo-scoped tokens.
- **Session-scoped control plane** — each session worker's HTTP surface is authenticated, so a
  compromised agent can drive its own container and not its neighbors'.
- **Commit-time secret scanning** — the post-turn auto-commit blocks commits that would introduce a
  recognized credential, keeping known secret leaks out of your history.

Plus a repo trust gate, supply-chain version pinning, bug-report secret redaction, and Cloudflare
Zero Trust / Tailscale access control. The full picture — trust model, every defense, and accepted
limitations — is in [SECURITY-MODEL.md](SECURITY-MODEL.md).

## Features

The full feature list and known limitations are in [FEATURES.md](FEATURES.md).

## Contributing

ShipIt isn't accepting pull requests right now — if you have a bug report, idea, or feature request,
please [open an issue](https://github.com/nikzlabs/shipit/issues). For the architecture, dev loop,
and module layout, see [CONTRIBUTING.md](CONTRIBUTING.md).

Found a security vulnerability? Don't open a public issue — follow [SECURITY.md](SECURITY.md). For
how ShipIt defends its trust boundaries (and the risks it has accepted), see
[SECURITY-MODEL.md](SECURITY-MODEL.md).

---

[ship-it.ai](https://ship-it.ai/) · Apache 2.0 ([LICENSE](LICENSE)) · Built and maintained by Nik
Zherebtsov · [LinkedIn](https://www.linkedin.com/in/nikolayz/) ·
[GitHub](https://github.com/nicolasalt)
