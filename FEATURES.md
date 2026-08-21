# ShipIt features

The full list of what ShipIt does. For what ShipIt is, how to install it, and the security model,
start at the [README](README.md).

## Build

- **Chat-driven development** — the conversation is the only input you need; the agent plans the
  change, edits files, runs the commands, and reads the output, so you steer in chat instead of
  driving a shell
- **Compose-native live preview** — embedded iframes show your app updating as it changes, with HMR
  proxied through ShipIt, multi-port support, and Docker Compose services managed per session; the
  toolbar names the page you are on and keeps up with client-side navigation
- **Agent-controlled services** — the agent starts, stops, restarts, and tails any Compose service
  the project declares, including the manual ones it needs on demand (a database to migrate, a cache
  to flush, an emulator to drive), so a debug dependency never waits on a click from you
- **Plugin repositories** — declare a shared tool repository once in `shipit.yaml`, and every session
  on the project gets its files, its live services, its CLI commands, and its skills without
  vendoring anything or deploying anything; the consuming project chooses the ports and settings, and
  a refresh picks up a change made in the tool's own repository
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
  diffs, including image and SVG diffs rendered visually instead of as text; leave line comments and
  send them to the agent as one review, with a free-text note for the feedback that belongs to no
  single line
- **Presented artifacts** — the agent renders diagrams, charts, mockups, prototypes, and formatted
  markdown into a dedicated Present tab, no dev server required, browsable as a gallery
- **Agent Interface SDK** — JavaScript in a preview or a presented artifact can compose and send
  messages back to the agent that owns the session, so an agent-built interface is something you
  interact with rather than only look at
- **Agent-authored links** — the agent writes an ordinary markdown link that opens a place in your
  own app's preview or in a presented artifact — as a link, a badge, or a button. The destination
  page can read the click and react to it, so "look at requirement 7" is one tap instead of a hunt
- **Sub-agent transparency** — when the agent fans work out to sub-agents, their prompt, work
  timeline, and final report render inline instead of an opaque tool call, and any in-flight tool
  call opens a live-updating output dialog
- **MCP integration** — connect Model Context Protocol servers to extend the agent's tools

## Choose your agent

- **Four agent harnesses** — Claude Code, Codex, OpenCode, and Grok Build all run as first-class
  backends: the same transcript, tool rendering, skills, sub-agent view, reviews, and compaction
  whichever one is driving, with each harness's own capabilities — permission modes, image input,
  mid-turn steering — declared per harness rather than assumed
- **Any model, on any harness** — the harness and the model it runs are separate choices. Configure a
  service once, by subscription or by API key, and its models become selectable in the composer, so a
  DeepSeek or GLM key can drive the Claude Code harness with no Anthropic account in the picture
- **Agent roles** — name a unit of agent work once — its harness, its service and billing mode, its
  model, its reasoning level, and its standing instructions — then start it by name. You pick a role
  in the composer before a session's first turn; the agent picks one for a sub-task or for a session
  it spawns
- **A reviewer that is never the implementer** — configure two reviewers in Settings and ShipIt sends
  each review to whichever one is furthest from the model that did the work, so a second opinion
  doesn't share the first one's blind spots — and reviewing still works on an install where nobody
  has configured anything
- **Multiple accounts per provider** — connect several, and every turn picks its account as it
  starts, from your ordering and the quota left; a usage limit moves the next turn rather than
  stopping the session, and no session is ever pinned to an account that goes away
- **Subscription usage** — header badges show your rate-limit usage (window, weekly cap, reset clock)
  inline, named per account when you've connected several, with weekly and per-month spend trends in
  the usage detail view

## Plan & track

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

## Review & ship

- **Inline PR lifecycle card** — create PRs and watch title, description, CI checks, review threads,
  deploy status, and merge state, all in chat with no GitHub tab required
- **AI PR descriptions** — generated from the actual diff when you open a PR
- **Chat-native AI review** — ask the session agent to review files or diffs and surface findings
  inline in the same conversation
- **Cross-agent second opinions** — opt in to let the session's agent consult a *different* model for
  a one-shot review or sub-task. You name the job ("review this diff") and ShipIt names who runs it;
  the consult gets full context and returns its findings to the conversation, no separate session
  required. A long one runs in the background as a card you can watch, cancel, or come back to — and
  it survives an orchestrator restart rather than hanging as a permanent spinner
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
  right when you start the session; the merge waits for the agent to stop working, so a turn still in
  flight is never merged out from under itself
- **Continue when your own PR merges** — a session can opt into being woken the moment its PR lands:
  it resets to the freshly merged base and keeps going on its own, so you can ship a chain of PRs
  without shepherding each merge by hand

## Iterate safely

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
  leaves a record, and the transcript says so at the moment the PR merges rather than leaving the
  refusal to be discovered later; a commit that would introduce a recognized secret is blocked and
  surfaced with what to do about it
- **Fully isolated sessions** — every session on the same repo gets its own clone and its own
  containerized environment, running under its own user identity on the host, so neither its agent,
  nor its services, nor ShipIt's own git on its workspace can reach another session's files
- **Network egress containment** — a contained session reaches only the hosts on its allowlist, and
  its Compose services are held to that same policy from their first instruction, so a service cannot
  reach somewhere its own agent is not allowed to
- **Sandbox sessions** — start a repo-less session from an empty workspace; the agent clones what it
  needs, with Git and session-scoped Docker granted as explicit capability toggles at creation
- **Permission modes** — choose how much autonomy the agent has per session
- **Live steering** — interrupt and redirect the agent mid-turn without losing context
- **Mute a session** — silence a session that is asking for you, until its next turn starts, without
  archiving it or changing anything else about it; the mute is stored with the session, so it holds
  on every device you open it from
- **Session sidebar** — pinned sessions, AI-generated session names the agent keeps current as the
  work changes (until you rename one yourself), status indicators, and a hide toggle for repositories
  you're not working in right now. A **Needs you** view switches the list to just the sessions
  waiting on you — one flat list, no repository headers — with a count that stays visible from either
  view

## Everywhere

- **Mobile-first layout** — a focused tab view on phones, resizable split panels on desktop, and a
  repo bar on the phone's new-session screen that names the repository the session will start in and
  lets you change it, each repository keeping its own draft
- **Installable app** — install ShipIt to your phone's home screen and it runs standalone, full-screen
  with no address bar, and always boots the latest code rather than a cached build
- **Voice in and out** — dictate prompts, hear a spoken note when an agent needs you, and tap play to
  hear a completed turn read aloud
- **Background notifications** — optional browser notification/sound when the agent finishes
- **Quick capture** — a global hotkey opens an overlay that captures a prompt and spawns a new
  session in the background, without leaving what you're doing
- **Software updates** — VPS installs can update and restart from Settings → Advanced; local Docker
  installs choose the channel there, then apply updates by running `deployment/local/update.sh`

## Where it runs

- **Your machine, or your server** — one command starts ShipIt on Linux, macOS, or Windows via WSL2;
  the same command set puts it on an always-on Ubuntu VPS when you want agents, previews, and CI
  follow-up work to keep running with your laptop closed. Both paths are Docker, and both are yours:
  there is no ShipIt account and no ShipIt server in the middle, and the instance connects straight
  to your GitHub and your agent provider
- **Installed by an agent, or by you** — the installer describes its own questions, so telling an
  agent you already have to "install ShipIt" is a working path: it asks you the choices in chat and
  answers the installer for you. Run it yourself and the same questions arrive as an arrow-key
  checklist, including which agent CLIs to install
- **Nothing to finish before you look around** — connecting an agent subscription is a panel in the
  conversation view, not a gate over the product: sessions, files, previews, the terminal, and
  settings all work before you have connected one, and the composer says what it needs
- **Reachable from your phone** — a local install stays on loopback by default and can add a
  Tailscale binding alongside it, so you keep working from a phone without opening a port

## Also included

The everyday essentials you'd expect from a serious agent IDE:

- **Context compaction & history editing** — trigger `/compact`, delete messages, or compact a long
  conversation into a summarized fork to genuinely shrink the agent's context window
- **Skill & command invocation** — type `/` in the composer to invoke a project skill, with
  autocomplete

## Known limitations

- ShipIt is a single-tenant tool you run yourself, with no built-in authentication today. If you
  expose it on the internet, put it behind Cloudflare Zero Trust, Tailscale, or another access layer
  you control; the VPS install script can help configure Cloudflare Tunnel/Zero Trust and Tailscale
  during setup.
- Expect meaningful Docker resource use: local production startup rebuilds ShipIt images, and each
  active session runs an agent container plus any Compose services your project declares. Session
  containers are sized automatically from the host's capacity, so there's normally nothing to tune —
  but a small host means fewer sessions can be active at once.
- The VPS installer targets Ubuntu. Other Linux distributions may work, but the one-command setup
  script is tuned for Ubuntu hosts.
- ShipIt runs on GitHub. Repository access, PRs, CI, review threads, merge controls, and deploy
  status all require GitHub auth and a GitHub remote; there is no local-only mode.
- Deploy status is read from the GitHub Deployments API. It appears when your hosting provider
  creates GitHub deployments for pushed commits.
- Voice input and spoken summaries require configuring a supported voice provider for speech
  services.
