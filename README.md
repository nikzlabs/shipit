<h1 align="center">
  <img src="src/client/public/favicon.svg" alt="ShipIt logo" width="36" height="36" valign="bottom">
  <span>&nbsp;ShipIt</span>
</h1>

<p align="center">
  <a href="https://github.com/nikzlabs/shipit/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/nikzlabs/shipit/ci.yml?branch=main&amp;label=CI" alt="CI status"></a>
  <img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0">
  <img src="https://img.shields.io/badge/status-early%20public%20release-orange" alt="Status: early public release">
  <img src="https://img.shields.io/badge/self--hosted-Docker-2496ED?logo=docker&logoColor=white" alt="Self-hosted via Docker">
</p>

<p align="center">
  <img src="docs/assets/hero.png" alt="ShipIt: chat, live preview, and the inline PR card in one screen" width="900">
</p>

<!-- TODO: 60-second demo video / live demo link. For a self-hosted app there's no `npm install`
     quick-win, so a video lets people evaluate without cloning + building Docker images. Host it
     (YouTube/Loom/asciinema or an mp4 in docs/assets/) and link it here as a "▶ Watch the demo" line
     or a clickable thumbnail right under the hero image. -->

ShipIt is a self-hosted, chat-driven IDE for running coding agents through your **real engineering loop**.

- **Real app feedback** — every session runs its own instance of your full app stack, so the agent
  can build, run, and fix before you preview and merge.
- **Bring your own agent** — Claude Code or Codex, on the subscription or API key you already have.
- **Parallel & isolated** — many agents at once, each in its own sandboxed container.
- **Self-hosted** — on an always-on server you own, or local on your laptop.
- **The GitHub loop, inline** — work with PRs, CI, deploys, reviews, and issues, without leaving ShipIt.
- **Ship from your phone** — mobile-first, with voice.

## Quickstart

### What you need

- [Docker](https://docs.docker.com/get-docker/) with the Compose v2 plugin (`docker compose`).
  Docker Desktop bundles it; on Linux install `docker-compose-plugin` alongside `docker-ce`. ShipIt
  always runs containerized — there is no bare-metal mode.
- Credentials for at least one agent backend — a subscription or an API key works for either:
  - Claude Code: [Claude Pro/Max](https://claude.ai/upgrade) or an
    [Anthropic API key](https://console.anthropic.com/settings/keys)
  - Codex: a ChatGPT subscription or an [OpenAI API key](https://platform.openai.com/api-keys)

### Try it locally

Use local Docker when you want to run ShipIt on your own machine — Linux, macOS, or Windows via
[WSL2](https://learn.microsoft.com/windows/wsl/install). Use the VPS path for the always-on setup.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/local/setup.sh)
```

This installs ShipIt under `~/.shipit`, builds the Docker images, and starts it **detached** at
[http://localhost:4123](http://localhost:4123). Sign in to Claude Code or Codex once from the in-app
provider flow. Fork installs, custom paths, updates, and stop/uninstall are in
[`deployment/README.md`](deployment/README.md).

#### Reaching a local install from your phone

A local install binds to `127.0.0.1`, so it is not reachable from other devices — deliberately, since
ShipIt has no built-in authentication. To reach it from a phone or another machine over
[Tailscale](https://tailscale.com/), run:

```bash
~/.shipit/deployment/local/tailscale.sh
```

That adds a tailnet binding **alongside** loopback (localhost keeps working, and ShipIt still starts
when Tailscale is down) and prints a URL of the form `http://100-x-y-z.sslip.io:4123`.

Use that URL rather than the raw `http://100.x.y.z:4123`. Previews are served at
`{sessionId}--{port}.<host>`, and a raw IP address can't carry a wildcard subdomain, so previews are
blank on the raw-IP URL — [sslip.io](https://sslip.io) maps the dashed form straight back to the same
address, which makes them resolve with no DNS setup. Traffic rides the encrypted tailnet, but the
connection is HTTP: there is no wildcard certificate for these names, so clipboard access and PWA
install (which need a secure context) are unavailable. For real HTTPS, point a wildcard DNS record you
own at the tailnet address. Details in
[`docs/254`](docs/254-local-bind-and-tailnet-access/plan.md).

To expose ShipIt on your LAN instead, set `SHIPIT_BIND_ADDR=0.0.0.0` in `~/.shipit/.shipit.env` — but
note that this puts an agent with a shell and your repositories on that network with nothing in front
of it, so only do it on a network you control. A host firewall is not a reliable substitute: on Linux,
Docker's published-port rules bypass `ufw`, and on macOS the application firewall is off by default.

### Run it on a VPS

Use the VPS path for the intended always-on setup: agents, previews, and CI follow-up work keep
running even when your laptop is closed.

ShipIt ships with a one-command provisioning script for Ubuntu hosts. It installs Docker, raises the
inotify limits sessions need, and can put ShipIt behind a
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
(with Zero Trust SSO) or [Tailscale](https://tailscale.com/) — no open inbound ports. Plan for 8 GB
RAM minimum (16 GB recommended), since each active session runs its own container. Run it as root
(`sudo` is a no-op if you already are):

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/nikzlabs/shipit/stable/deployment/vps/setup.sh)"
```

It asks which access path you want, then handles the rest — Docker, clone, host limits, image builds,
and the self-update systemd units. Updates land from the UI (**Settings → Advanced → Software
Updates**). Fork installs, host-side updates, sizing, access policies, and troubleshooting are all in
[`deployment/README.md`](deployment/README.md).

### After first boot

1. Connect GitHub so ShipIt can clone repos, push branches, open PRs, and read CI status.
2. Pick Claude Code or Codex as the agent backend.
3. Start a session from an existing repository, or create a new project from a template.
4. Describe the change you want; ShipIt creates an isolated container, branch, chat history, and
   workspace for that session.

## Status

ShipIt is in an early public release state, with two supported install paths — local Docker and a
self-hosted Docker install on an Ubuntu VPS (see [Quickstart](#quickstart) for both). The core loop
is live: create isolated sessions, work against your repositories, run Compose-backed previews, open
PRs, track CI and deploy status from GitHub, and continue from desktop or mobile.

The project is public source, but not yet open to outside pull requests. Bug reports, feature
requests, and design discussion are welcome as GitHub issues.

## Why ShipIt exists

Coding agents are the easy part — you already have Claude Code or Codex. The hard part is everything
around them: an isolated environment per agent, a live app to test against, parallel work that doesn't
collide, and the full PR → CI → deploy → review loop on your repos. ShipIt is the surface that ties
all of that together, so you build, review, and ship in one place instead of stitching it together
yourself.

## Agents

Connect more than one account per provider — and the agent harness is pluggable:

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) — Claude Pro/Max subscription or
  an Anthropic API key
- [Codex CLI](https://github.com/openai/codex) — ChatGPT subscription or an OpenAI API key
- More to come — the backend is agent-agnostic by design, so new runtimes can slot in

**Smooth support for multiple subscriptions.** ShipIt moves to your next account before a usage limit
stops you, without interrupting sessions already in flight.

## Features

### Build

- **Chat-driven development** — the conversation is the only input you need; the agent plans the
  change, edits files, runs the commands, and reads the output, so you steer in chat instead of
  driving a shell
- **Compose-native live preview** — embedded iframes show your app updating as it changes, with HMR
  proxied through ShipIt, multi-port support, and Docker Compose services managed per session
- **Agent-controlled services** — the agent starts, stops, restarts, and tails any Compose service
  the project declares, including the manual ones it needs on demand (a database to migrate, a cache
  to flush, an emulator to drive), so a debug dependency never waits on a click from you
- **Android build, test & preview** — the session image bakes a JDK, the Android SDK, and Gradle, so
  the agent builds Gradle projects (including web/Android monorepos), runs JVM and Paparazzi snapshot
  tests, and reads the PNG diffs; declare an emulator as a Compose service and the running app shows
  up live in the preview panel
- **Git LFS support** — LFS-tracked assets are materialized during provisioning instead of checked
  out as pointer stubs, objects are shared across every session on the host rather than downloaded
  per session, and LFS images render as images in the diff viewer
- **Project templates** — quick-start scaffolding for React, Vue, Next.js, Svelte, and more
- **File upload & image input** — drop files into the chat; the agent reads them as context
- **Interactive terminal** — a full terminal inside each session container for ad-hoc debugging
- **Persistent logs** — agent-container and preview-service logs are kept in a durable, disk-backed
  store, so full history survives container restarts, idle eviction, and orchestrator restarts
- **File viewer with diffs** — browse files with syntax highlighting and review changes as inline
  diffs, including image and SVG diffs rendered visually instead of as text
- **Presented artifacts** — the agent renders diagrams, charts, mockups, prototypes, and formatted
  markdown into a dedicated Present tab, no dev server required, browsable as a gallery
- **Agent Interface SDK** — JavaScript in a preview or a presented artifact can compose and send
  messages back to the agent that owns the session, so an agent-built interface is something you
  interact with rather than only look at
- **Sub-agent transparency** — when the agent fans work out to sub-agents, their prompt, work
  timeline, and final report render inline instead of an opaque tool call, and any in-flight tool
  call opens a live-updating output dialog
- **MCP integration** — connect Model Context Protocol servers to extend the agent's tools

### Plan & track

- **Inline Issues tab** — Linear and GitHub Issues in one priority-sorted list, with a sub-tab per
  tracker, so "what should I work on next?" lives inside ShipIt; set an issue's status (both trackers)
  and priority (Linear) inline from the list or its detail view
- **Filters & search** — narrow by status, priority, and assignee (multi-select) or free-text
  search, applied across every connected tracker
- **Extra tracker tabs** — a repository can declare additional GitHub issue trackers in its
  `shipit.yaml`, each getting its own tab, so a separate planning repo sits alongside the code repo's
  issues instead of in another browser window
- **Start a session from an issue** — kick off an isolated session straight from an issue row, with
  the issue as context, instead of copy-pasting the body into chat; pick which repository it starts
  in when the issue isn't tracked in the one you're looking at
- **Agent issue access** — the agent reads and writes issues (view, list, comment, edit, set status
  and assignee, create issues and labels, nest Linear sub-issues) through a tracker-neutral,
  ShipIt-brokered interface, so tracker tokens never enter the session container
- **Requirements before code** — opt a feature into requirements discipline and the agent writes down
  what the feature must do in your words first, asks its open questions as one batched prompt, and
  holds off on implementation until you've answered

### Review & ship

- **Inline PR lifecycle card** — create PRs and watch title, description, CI checks, review threads,
  deploy status, and merge state, all in chat with no GitHub tab required
- **AI PR descriptions** — generated from the actual diff when you open a PR
- **Chat-native AI review** — ask the session agent to review files or diffs and surface findings
  inline in the same conversation
- **Cross-agent second opinions** — opt in to let the session's agent consult a *different* model for
  a one-shot review or sub-task ("have Codex review this diff"); it runs inline in the same turn with
  full context and returns its findings to the conversation, no separate session required. A long
  consult can run in the background as a card you can watch, cancel, or come back to — and it
  survives an orchestrator restart rather than hanging as a permanent spinner
- **Inline diffs** — file changes displayed as collapsible red/green diff blocks in the chat
- **Auto-deploy on push** — deploy status surfaces inline on the PR card via the GitHub Deployments
  API
- **PR comment sync** — review threads from GitHub appear inline in the conversation
- **CI failure loop** — failed GitHub checks and logs are surfaced to the agent so it can inspect
  the failure and, when enabled, attempt a fix on the next turn
- **Preview failure loop** — a crashed Compose service is detected and auto-retried, with its logs
  surfaced inline so the agent (and you) can act on the failure without leaving chat
- **Auto-resolve merge conflicts** — when your branch conflicts with its base and the agent is idle,
  ShipIt auto-rebases and runs an agent turn to resolve the conflicts for you
- **Stay current with the base** — a behind-the-base branch gets an inline nudge and a one-click sync
  that also advances the session's local base ref, with the rebase's progress shown live in chat and a
  persistent card recording that it happened
- **PR approval merge gate** — merge eligibility reflects GitHub's review-approval status, surfaced
  inline on the PR card so you don't merge ahead of required reviews
- **Arm merge-on-green at creation** — opt a trivial task into auto-merging once checks pass, set
  right when you start the session
- **Continue when your own PR merges** — a session can opt into being woken the moment its PR lands:
  it resets to the freshly merged base and keeps going on its own, so you can ship a chain of PRs
  without shepherding each merge by hand

### Iterate safely

- **Git as undo** — every agent turn auto-commits; rewind to any previous state, and fork into a new
  branch from any point
- **Parallel PR-shaped sessions** — spawn separate workspaces with their own branch, container, and
  chat history; review each as its own PR. A spawned session can push a finding back to the session
  that started it (and its siblings) as a card plus a queued turn, so a blocker one agent hits
  reaches the others instead of sitting in a PR nobody has opened
- **Work survives updates and restarts** — an update replaces only the orchestrator, so running
  sessions keep going and a turn that was mid-flight is adopted and finished, including its commit,
  push, and PR flow. Containers left on an older build are flagged inline with a restart suggestion,
  and idle ones rotate themselves
- **No lost turns** — a turn that dies to a crash or an OOM kill still commits the work it did rather
  than leaving it uncommitted in the working tree, and a container that fails to start is retried
  instead of stranding the turn with a connection error
- **Destructive-git guardrails** — while a session sits on a branch whose work already merged,
  hand-rolled destructive git is blocked in favor of a brokered reset that keeps its safety checks and
  leaves a record; a commit that would introduce a recognized secret is blocked and surfaced with
  what to do about it
- **Fully isolated sessions** — every session on the same repo gets its own clone and its own
  containerized environment, so its agent and services never share state with another session
- **Sandbox sessions** — start a repo-less session from an empty workspace; the agent clones what it
  needs, with Git and session-scoped Docker granted as explicit capability toggles at creation
- **Permission modes** — choose how much autonomy the agent has per session
- **Live steering** — interrupt and redirect the agent mid-turn without losing context
- **Session sidebar** — pinned sessions, AI-generated session names the agent keeps current as the
  work changes (until you rename one yourself), status indicators, and a hide toggle for repositories
  you're not working in right now

### Everywhere

- **Mobile-first layout** — a focused tab view on phones, resizable split panels on desktop
- **Installable app** — install ShipIt to your phone's home screen and it runs standalone, full-screen
  with no address bar, and always boots the latest code rather than a cached build
- **Voice in and out** — dictate prompts, hear a spoken note when an agent needs you, and tap play to
  hear a completed turn read aloud
- **Background notifications** — optional browser notification/sound when the agent finishes
- **Quick capture** — a global hotkey opens an overlay that captures a prompt and spawns a new
  session in the background, without leaving what you're doing
- **Software updates** — VPS installs can update and restart from Settings → Advanced; local Docker
  installs choose the channel there, then apply updates by running `deployment/local/update.sh`

### Also included

The everyday essentials you'd expect from a serious agent IDE:

- **Context compaction & history editing** — trigger `/compact`, delete messages, or compact a long
  conversation into a summarized fork to genuinely shrink the agent's context window
- **Skill & command invocation** — type `/` in the composer to invoke a project skill, with
  autocomplete
- **Subscription usage** — header badges show your Claude/Codex rate-limit usage (5-hour window,
  weekly cap, reset clock) inline, named per account when you've connected several, with weekly and
  per-month spend trends in the usage detail view

## Known limitations

- ShipIt is designed as a self-hosted, single-tenant tool today. If you expose it on the internet,
  put it behind Cloudflare Zero Trust, Tailscale, or another access layer you control; the VPS
  install script can help configure Cloudflare Tunnel/Zero Trust and Tailscale during setup.
- Expect meaningful Docker resource use: local production startup rebuilds ShipIt images, and each
  active session runs an agent container plus any Compose services your project declares. Session
  containers are sized automatically from the host's capacity, so there's normally nothing to tune —
  but a small host means fewer sessions can be active at once.
- The VPS installer targets Ubuntu. Other Linux distributions may work, but the one-command setup
  script is tuned for Ubuntu hosts.
- The full review-and-ship loop depends on GitHub. You can work locally without it, but PRs, CI,
  review threads, merge controls, and deploy status require GitHub auth and a GitHub remote.
- Deploy status is read from the GitHub Deployments API. It appears when your hosting provider
  creates GitHub deployments for pushed commits.
- Voice input and spoken summaries require configuring a supported voice provider for speech
  services.

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

## Contributing

ShipIt isn't accepting pull requests right now — if you have a bug report, idea, or feature request,
please [open an issue](https://github.com/nikzlabs/shipit/issues). For the architecture, dev loop,
and module layout, see [CONTRIBUTING.md](CONTRIBUTING.md).

Found a security vulnerability? Don't open a public issue — follow [SECURITY.md](SECURITY.md). For
how ShipIt defends its trust boundaries (and the risks it has accepted), see
[SECURITY-MODEL.md](SECURITY-MODEL.md).

## Website

[ship-it.ai](https://ship-it.ai/) — the product page.

## Author

Built and maintained by Nik Zherebtsov — [LinkedIn](https://www.linkedin.com/in/nikolayz/) ·
[GitHub](https://github.com/nicolasalt)

## License

Apache 2.0 — see [LICENSE](LICENSE) for details. ShipIt is open-core; when the project opens to
outside pull requests, contributions will require a [Contributor License Agreement](CLA.md) so they
can also ship in the proprietary enterprise edition.
