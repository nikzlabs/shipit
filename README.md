<h1 align="center">
  <img src="src/client/public/favicon.svg" alt="ShipIt logo" width="36" height="36" valign="bottom">
  <span>&nbsp;ShipIt</span>
</h1>

**Describe products into existence — on your own Git, containers, and server.** Chat-driven
development that still ships the way real software does: branches, reviews, CI, and deploys.

<p align="center">
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0">
  <img src="https://img.shields.io/badge/status-early%20public%20release-orange" alt="Status: early public release">
  <img src="https://img.shields.io/badge/self--hosted-Docker-2496ED?logo=docker&logoColor=white" alt="Self-hosted via Docker">
</p>

<!-- TODO: hero screenshot or GIF — one frame showing chat + live preview + the inline PR card.
     Drop it at docs/assets/hero.png (or .gif for the describe → preview → PR loop) and uncomment:
<p align="center">
  <img src="docs/assets/hero.png" alt="ShipIt: chat, live preview, and the inline PR card in one screen" width="900">
</p>
-->

<!-- TODO: 60-second demo video / live demo link. For a self-hosted app there's no `npm install`
     quick-win, so a video lets people evaluate without cloning + building Docker images. Host it
     (YouTube/Loom/asciinema or an mp4 in docs/assets/) and link it here as a "▶ Watch the demo" line
     or a clickable thumbnail right under the hero image. -->


ShipIt is a browser-based AI dev environment: describe what you want in chat, the agent writes the
code, and you see results live. It has the ease of prompt-to-app builders, but the work runs through
a real engineering loop — branches, pull requests, CI, and deploys — on _your_ repo, _your_ Git, and
_your_ infrastructure. A few choices make that possible:

- **Container-isolated sessions** — each session gets its own Docker container, branch, chat
  history, and workspace, so concurrent agents can't step on each other's files, processes, or
  installed dependencies. An agent can spawn its own follow-up sessions to fan work out in parallel.
- **Self-hostable on a VPS** — ShipIt is Docker-based end to end. Run it on a remote server and your
  laptop doesn't need to stay open for agents, previews, or CI follow-up work to continue.
- **Compose-based previews** — declare your dev server, databases, queues, log tailers, and other
  app services in `docker-compose.yml`; ShipIt manages them and surfaces automatic or manual
  previews inside the app.
- **Tight GitHub integration** — branches, auto-commits, pushes, PR creation, CI checks, deploy
  status, review comments, and merge state are surfaced inline instead of punting you to GitHub.
- **Mobile-first, with first-class voice** — ShipIt is genuinely good from a phone, not a desktop
  tool that merely survives a small screen: a focused tab-based view on mobile and resizable split
  panels on desktop. Voice runs both ways — dictate prompts hands-free and hear spoken summaries
  when the agent finishes a turn or needs you, so you can kick off, review, and ship on the go.
- **One surface — you never leave it** — chat, file tree, terminal, live preview, diffs, CI logs,
  deploy status, session history, and the PR lifecycle all render inline. Reviewing, shipping,
  and debugging happen here, not in a GitHub tab, a CI dashboard, or a local terminal.

That adds up to one promise: **the build, review, ship, and debug loop stays in the conversation.**
You describe intent, watch the preview update, and refine with the agent turn by turn while ShipIt
runs commands, edits files, opens PRs, watches checks, and brings the results back into chat.

## Why not just use the Claude or Codex app?

You probably already have Claude Code or Codex. ShipIt runs them as its backend — and wraps them in
everything the bare CLIs and their desktop/web apps leave out:

- **Parallel agent sessions, fully isolated.** The CLIs run one agent in your working tree. ShipIt
  gives every session its own container, branch, and chat history, so you can fan work out without
  sessions stepping on each other's files, processes, or installed dependencies.
- **It's not your laptop's problem.** The desktop and web apps tie the work to the machine in front
  of you. ShipIt is self-hosted on a VPS — start a change, close the lid, and previews, CI, and
  follow-up work keep running.
- **Real previews, not a throwaway sandbox.** ShipIt boots your actual Compose stack — dev server,
  database, queues — and renders the live app inline with HMR, instead of an environment you can't
  shape.
- **GitHub comes to you.** PRs, CI checks, review threads, diffs, and deploy status all render in
  the chat. The web apps send you off to a GitHub tab; ShipIt keeps the whole loop in one place.
- **Built for the phone.** Dictate a prompt, hear a spoken summary when the turn lands, review and
  merge one-handed. The official apps are desktop-first; ShipIt is genuinely usable from mobile.
- **Your tools stay familiar.** Git, a real terminal, file browsing, inline diffs — exposed, not
  hidden. You keep the control an engineer expects while the boring orchestration is automated away.

## Agents

Use the AI subscription you already pay for, or bring an API key. ShipIt has a pluggable agent
harness:

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — Claude Pro/Max subscription or
  an Anthropic API key
- [Codex CLI](https://github.com/openai/codex) — ChatGPT subscription or an OpenAI API key
- More to come — the backend is agent-agnostic by design, so new runtimes can slot in

## Status

ShipIt is in an early public release state. The supported install paths are local Docker and a
self-hosted Docker install on an Ubuntu VPS; the VPS path is the intended always-on setup when you
want agents and previews to keep running after you close your laptop. The core loop is live: create
isolated sessions, work against real repositories, run Compose-backed previews, open PRs, track CI
and deploy status from GitHub, and continue from desktop or mobile.

The project is public source, but not yet open to outside pull requests. Bug reports, feature
requests, and design discussion are welcome as GitHub issues.

## Quickstart

If you want to hack on ShipIt itself instead of just running it, see
[CONTRIBUTING.md](CONTRIBUTING.md) for the architecture, dev loop, and module layout.

### What you need

- [Docker](https://docs.docker.com/get-docker/) with the Compose v2 plugin (`docker compose`).
  Docker Desktop bundles it; on Linux install `docker-compose-plugin` alongside `docker-ce`. ShipIt
  always runs containerized — there is no bare-metal mode.
- Credentials for at least one agent backend — a subscription or an API key works for either:
  - Claude Code: [Claude Pro/Max](https://claude.ai/upgrade) or an
    [Anthropic API key](https://console.anthropic.com/settings/keys)
  - Codex: a ChatGPT subscription or an [OpenAI API key](https://platform.openai.com/api-keys)

### Try it locally

Use local Docker when you want to run ShipIt on your own machine. Use the VPS path for the
always-on setup.

```bash
git clone https://github.com/nicolasalt/shipit.git
cd shipit
docker/local/prod.sh
```

This builds the orchestrator and session-worker images, then starts ShipIt at
[http://localhost:4123](http://localhost:4123). The script follows the selected release channel
(`stable` by default, or `edge` if you switch channels in Settings), updates the checkout to that
channel, and rebuilds the Docker images. It refuses to overwrite uncommitted local changes. After
the app opens, sign in to Claude Code or Codex from the in-app provider flow; credentials are stored
in a persistent Docker volume so you only need to do this once per provider.

### Run it on a VPS

Use the VPS path for the intended always-on setup: agents, previews, and CI follow-up work keep
running even when your laptop is closed.

ShipIt ships with a one-command provisioning script for Ubuntu VPS hosts. It installs Docker, raises
the inotify limits session containers need, and optionally puts ShipIt behind a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(with optional Zero Trust SSO) and/or exposes it over [Tailscale](https://tailscale.com/) — no open
inbound ports required.

**Recommended sizing:** 8 GB RAM minimum, 16 GB recommended. Each active session runs its own
container (agent CLI plus the session's Compose services — optional, but usually at least a dev
server), so headroom matters once you have a few sessions open at once.

```bash
ssh root@<server-ip>
bash <(curl -fsSL https://raw.githubusercontent.com/nicolasalt/shipit/main/deployment/vps/setup.sh)
```

The script asks whether you want Cloudflare, Tailscale, both, or neither, then takes care of
everything else: installing git and Docker, cloning ShipIt to `/opt/shipit`, configuring host
limits, building the images, installing the self-updater + restarter systemd units, and bringing
ShipIt up. Installing a fork instead? Set `SHIPIT_REPO_URL=https://github.com/you/shipit.git` before
the command.

Once it's running, updates happen from inside the UI — **Settings → Advanced → Software Updates** —
or via `bash /opt/shipit/deployment/vps/deploy.sh` on the host.

See [`deployment/README.md`](deployment/README.md) for the full guide: sizing recommendations,
Cloudflare Zero Trust access policies, wildcard preview DNS over Tailscale, and troubleshooting.

### After first boot

1. Pick Claude Code or Codex as the agent backend.
2. Connect GitHub so ShipIt can clone repos, push branches, open PRs, and read CI status.
3. Start a session from an existing repository or a project template.
4. Describe the change you want; ShipIt creates an isolated container, branch, chat history, and
   workspace for that session.

## Features

### Build

- **Chat-driven development** — the conversation is the only input you need; the agent plans the
  change, edits files, runs the commands, and reads the output, so you steer in chat instead of
  driving a shell
- **Existing subscription auth** — sign in with Claude Pro/Max or ChatGPT, or use Anthropic/OpenAI
  API keys when that fits your setup better
- **Agent-agnostic backend** — pick Claude Code CLI or Codex CLI per session; the backend boundary
  is designed for more agent runtimes over time
- **Compose-native live preview** — embedded iframes show your app updating in real time, with HMR
  proxied through ShipIt, multi-port support, and Docker Compose services managed per session
- **Project templates** — quick-start scaffolding for React, Vue, Next.js, Svelte, and more
- **File upload & image input** — drop files into the chat; the agent reads them as context
- **Interactive terminal** — full PTY (xterm.js) inside the session container for ad-hoc debugging
- **File viewer with diffs** — browse files with syntax highlighting and review changes as inline
  diffs
- **MCP integration** — connect Model Context Protocol servers to extend the agent's tools

### Review & ship

- **Inline PR lifecycle card** — title, description, CI checks, deploy status, and merge state all
  render in chat; no GitHub tab required
- **GitHub without leaving ShipIt** — create PRs, follow CI, read review threads, track deploys, and
  merge from the browser IDE
- **AI PR descriptions** — generated from the actual diff when you open a PR
- **Chat-native AI review** — ask the session agent to review files or diffs and surface findings
  inline in the same conversation
- **Inline diffs** — file changes displayed as collapsible red/green diff blocks in the chat
- **Auto-deploy on push** — deploy status surfaces inline on the PR card via the GitHub Deployments
  API
- **PR comment sync** — review threads from GitHub appear inline in the conversation
- **CI failure loop** — failed GitHub checks and logs are surfaced to the agent so it can inspect
  the failure and, when enabled, attempt a fix on the next turn

### Iterate safely

- **Git as undo** — every agent turn auto-commits; rewind to any previous state, and fork into a new
  branch from any point
- **Parallel PR-shaped sessions** — spawn separate workspaces with their own branch, container, and
  chat history; review each as its own PR
- **Container + worktree isolation** — multiple sessions on the same repo share a bare cache and use
  git worktrees, while each session's agent and services run in their own containerized environment
- **Permission modes** — choose how much autonomy the agent has per session
- **Live steering** — interrupt and redirect the agent mid-turn without losing context
- **Session sidebar** — pinned sessions, AI-generated session names, status indicators

### Everywhere

- **Mobile-first layout** — a focused tab-based view on small screens, resizable split panels on
  desktop; built and polished for real day-to-day use from a phone
- **Voice in and out** — dictate prompts with a mobile-friendly voice-recording overlay, and get
  spoken summaries when the agent finishes a turn or needs your input, so you can work hands-free
- **Background notifications** — tab title change and browser notification when the agent finishes
- **Software updates** — VPS installs can update and restart from Settings → Advanced; local Docker
  installs choose the channel there, then apply updates by re-running `docker/local/prod.sh`

## Known limitations

- ShipIt is designed as a self-hosted, single-tenant tool today. If you expose it on the internet,
  put it behind Cloudflare Zero Trust, Tailscale, or another access layer you control; the VPS
  install script can help configure Cloudflare Tunnel/Zero Trust and Tailscale during setup.
- Expect meaningful Docker resource use: local production startup rebuilds ShipIt images, and each
  active session runs an agent container plus any Compose services your project declares.
- The VPS installer targets Ubuntu. Other Linux distributions may work, but the one-command setup
  script is tuned for Ubuntu hosts.
- The full review-and-ship loop depends on GitHub. You can work locally without it, but PRs, CI,
  review threads, merge controls, and deploy status require GitHub auth and a GitHub remote.
- Deploy status is read from the GitHub Deployments API. It appears when your hosting provider
  creates GitHub deployments for pushed commits.
- Voice input and spoken summaries require configuring a supported voice provider for speech
  services.

## Contributing

ShipIt isn't accepting pull requests right now — if you have a bug report, idea, or feature request,
please [open an issue](https://github.com/nicolasalt/shipit/issues). For the architecture, dev loop,
and module layout, see [CONTRIBUTING.md](CONTRIBUTING.md).

Found a security vulnerability? Don't open a public issue — follow [SECURITY.md](SECURITY.md).

## Author

Built and maintained by Nik Zherebtsov —
[LinkedIn](https://www.linkedin.com/in/REPLACE_ME) ·
[GitHub](https://github.com/nicolasalt)

## License

Apache 2.0 — see [LICENSE](LICENSE) for details. ShipIt is open-core; when the project opens to
outside pull requests, contributions will require a [Contributor License Agreement](CLA.md) so they
can also ship in the proprietary enterprise edition.
