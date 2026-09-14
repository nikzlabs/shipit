# How ShipIt works, and everything it can do

Read this when the user asks what ShipIt is, why it did something structural
("why is there a new branch again?"), or whether it can do some particular
thing. The census at the bottom is the fastest way to answer "can it…?".

## The model, in one pass

ShipIt is a browser IDE shaped like a chat. The user describes what they want;
an agent — you — does the work. Around that sit five things worth knowing,
because most surprising behaviour comes from one of them.

**A repository is added once.** From then on the user starts sessions against
it. ShipIt keeps a shared bare clone of the repo on the host, so a new session
is cheap.

**A session is the unit of work.** One session is one conversation, one Docker
container, one checkout, one branch, one preview, and — normally — one pull
request. Sessions are isolated from each other by construction: separate
containers, separate branches, separate filesystems, separate user ids. That is
what makes it safe to run several agents at once on the same repository, which
is the thing ShipIt is built for.

**The branch and the commits are automatic.** The user does not `git checkout`,
and neither do you. ShipIt creates the session's branch up front, and after
every turn it commits what changed and pushes it. The commit message comes from
the turn's summary. This is why work appears on a branch the user never made,
and why there is nothing to "save".

**The app runs inside the session.** Services declared in the project's
`docker-compose.yml` run as real containers next to the agent container, and
the preview pane shows the one marked for it. Every session gets its own
instance of the whole stack, so two agents working in parallel are not fighting
over one dev server or one database.

**The GitHub loop happens in ShipIt.** Opening the pull request, reading its
diff, CI status, review comments, the deploy, the merge — all of it renders in
the app. Sending the user to github.com is a failure, not a feature. If
something genuinely is not rendered inline yet, say so; do not paper over it
with a link.

### What one piece of work looks like

1. The user starts a session on a repo, or types into a fresh one.
2. ShipIt allocates a container, checks the repo out, cuts a branch.
3. They describe what they want. You work: read, edit, run, test.
4. Services start; the preview shows the app as it is now.
5. The turn ends. ShipIt commits and pushes.
6. A pull request card appears in the conversation, with CI and deploy status on
   it as they arrive.
7. The user reviews the diff, comments, asks for changes — in the chat.
8. They merge from the card. The session is done; they archive it or leave it.

## The screen

- **Left — sessions.** Grouped by repository, with pinned sessions on top. A
  second view, "Needs you", flattens the list to only the sessions waiting on
  the user. See [sessions.md](sessions.md).
- **Middle — the conversation.** Their messages and your work, including file
  attachments, diffs, questions, permission prompts, and cards for pull
  requests, reviews, issues, spawned sessions and releases.
- **Right — a tabbed panel.** Files, Docs, Issues, Terminal and History, and,
  conditionally, Preview or Host, PR, Present and Plugins. **Which tabs exist
  depends on the session**, so check before promising one: Host appears only in
  an Ops session, where Preview does not — and Preview is missing from a sandbox
  session and from a local-mode install too; PR appears once the session has a
  pull request, and never in an Ops or sandbox session; Present appears only
  once something has been presented; Plugins appears only
  when the project declares them. A diff view opens over the panel when a change
  is tapped.

On a phone the middle and the preview swap rather than sit side by side, and
dictation replaces typing.

## Capability census

Everything ShipIt does, grouped by what the user is trying to get done. The
right column says where the detail is: a wiki page, one of your operating docs
in `/shipit-docs/`, or a live command to run rather than a page to read.

### Running work in parallel

| Capability | Where |
|---|---|
| Add a repository, so sessions can be started against it | [repos-and-sandboxes.md](repos-and-sandboxes.md) — **Add Repository**, in the repository switcher at the top of the sidebar. Added once; ShipIt keeps a shared bare clone so each new session is cheap |
| Create a new repository on GitHub from a template | [repos-and-sandboxes.md](repos-and-sandboxes.md) |
| Trust a repository once, before ShipIt runs any of its code | [repos-and-sandboxes.md](repos-and-sandboxes.md) |
| Hide a repository from the sidebar, or remove it and keep its sessions | [repos-and-sandboxes.md](repos-and-sandboxes.md) |
| Reorder repositories in the sidebar | [repos-and-sandboxes.md](repos-and-sandboxes.md) |
| Many sessions at once, isolated by container and branch | [sessions.md](sessions.md) |
| Start a session from a repo, an issue, or a blank prompt | [sessions.md](sessions.md) |
| Find a session that has dropped out of the sidebar | [sessions.md](sessions.md) — All sessions |
| Recover a wedged session — diagnostics, restart, rescue | [sessions.md](sessions.md) — the health strip in the Terminal tab |
| Fork a session from any point in its conversation | [sessions.md](sessions.md) |
| Rewind — throw away the code, the chat, or both, back to a chosen point | [sessions.md](sessions.md) |
| Pin a session so it stays at the top and keeps its workspace on disk | [sessions.md](sessions.md) |
| Keep a session's preview running while it is idle | [sessions.md](sessions.md) |
| Mute a session that is asking for attention it does not need | [sessions.md](sessions.md) |
| Archive and unarchive | [sessions.md](sessions.md) |
| "Needs you" view — only the sessions waiting on the user | [sessions.md](sessions.md) |
| Child sessions you spawn, nested under this one, each with its own PR | `/shipit-docs/sessions.md` |
| A one-shot consult with a different model, answering into this session | `/shipit-docs/agent.md` |
| Sandbox sessions — an empty workspace with its own capabilities | [repos-and-sandboxes.md](repos-and-sandboxes.md), and `/shipit-docs/sandbox-session.md` for your own contract |

### Talking to the agent

| Capability | Where |
|---|---|
| Attach files and images to a message; drop in uploads | [chat.md](chat.md), and `/shipit-docs/environment.md` for `/uploads` |
| Reference a file with `@`, a skill with `/` (`$` on a Codex session) | [chat.md](chat.md); [plugins-and-skills.md](plugins-and-skills.md) to install more |
| Interrupt a running turn, steer it mid-turn, or queue the next message | [chat.md](chat.md) — the queued message can be cancelled before it runs |
| Answer a question or a permission prompt inline | [chat.md](chat.md) |
| Plan mode — the agent designs before it is allowed to change anything | [chat.md](chat.md) — a permission mode, and not every harness offers one |
| Dictate by voice, on desktop and phone | [chat.md](chat.md) — Settings → Voice |
| Spoken summaries back from the agent when it needs the user | [chat.md](chat.md), `/shipit-docs/voice-notes.md` |
| Collapse finished turns so a long conversation stays readable | [chat.md](chat.md) |
| Search the conversation's message text — not tool calls or their output | [chat.md](chat.md) |
| Compact the conversation when context fills; a dial shows how full | [chat.md](chat.md) |
| Set a goal condition the session works toward | [chat.md](chat.md) |
| Quote a selection of the conversation into a reply | [chat.md](chat.md) |
| Show a diagram, mockup or rendered document in the Present tab | [chat.md](chat.md), `/shipit-docs/present.md` |
| Offer the user a checklist of optional follow-ups | [chat.md](chat.md), and the `propose_actions` tool |
| Link straight to a place in the running app or a presented artifact | `/shipit-docs/chat-links.md` |

### Seeing the app

| Capability | Where |
|---|---|
| Live preview per session, hot-reloading as files change | [previews.md](previews.md) |
| Full Docker Compose stacks — databases, queues, workers | [previews.md](previews.md), and `/shipit-docs/compose.md` to write one |
| Start, stop, restart a service and read its logs | [previews.md](previews.md) — `shipit service list` / `start` / `stop` / `logs` |
| Per-service environment and secrets | [repos-and-sandboxes.md](repos-and-sandboxes.md), `/shipit-docs/secrets.md` |
| Phone and tablet viewports, and freeform sizes | [previews.md](previews.md) |
| Send the preview's browser errors to the agent, by hand or automatically | [previews.md](previews.md) — the Errors panel and the Auto-fix switch |
| Android — build, snapshot-test, and drive an emulator as a service | `/shipit-docs/android.md` |
| A browser you can drive yourself to check your own work | `/shipit-docs/preview.md` |

### The GitHub loop

| Capability | Where |
|---|---|
| A branch per session, commits and pushes after every turn | This page, and `/shipit-docs/github.md` |
| Open a pull request, edit its title and body | [pull-requests.md](pull-requests.md) |
| The PR card above the conversation: status, checks, deploys, changed docs | [pull-requests.md](pull-requests.md) — a strip that never scrolls away |
| Read and reply to review threads, resolve them, without leaving ShipIt | [pull-requests.md](pull-requests.md) |
| Review the user's own way — draft file comments, then send as one review | [pull-requests.md](pull-requests.md) |
| Merge, choose the merge method, or arm auto-merge | [pull-requests.md](pull-requests.md) |
| Let the agent merge the pull request its own session opened | [pull-requests.md](pull-requests.md), and [repos-and-sandboxes.md](repos-and-sandboxes.md) — Project Settings → Deployments |
| Mark ready, close, reopen | [pull-requests.md](pull-requests.md) |
| CI runs listed inline, re-run a failed one, or have the agent fix it | [pull-requests.md](pull-requests.md) |
| Re-run a CI workflow run without pushing an empty commit | [pull-requests.md](pull-requests.md), and `/shipit-docs/github.md` |
| Merge conflicts resolved in the session rather than locally | [pull-requests.md](pull-requests.md) |
| Branch history, and rolling back to an earlier commit | [sessions.md](sessions.md) — rewind; [pull-requests.md](pull-requests.md) for what it does to the branch on GitHub |
| Be woken when a pull request merges, instead of watching it | `shipit session notify-on-merge` |
| Cut a release — version bump, branch, tag, published notes | [pull-requests.md](pull-requests.md), and `/shipit-docs/release.md` for your own steps |
| Deploy on every push, through the hosting platform's own Git integration | [deploying.md](deploying.md) |
| Deploy status — environment, state and URL — on the pull request card and in the PR tab | [deploying.md](deploying.md) |

### Issues and documents

| Capability | Where |
|---|---|
| GitHub Issues and Linear, in one panel and one command | [issues-and-docs.md](issues-and-docs.md) |
| Read, comment, label, re-prioritise, assign, change status, create | [issues-and-docs.md](issues-and-docs.md), and `shipit issue --help` |
| Sort, group and filter the issue list; nest Linear sub-issues under their parent | [issues-and-docs.md](issues-and-docs.md) |
| Start a session directly from an issue | [issues-and-docs.md](issues-and-docs.md) |
| Close an issue by merging the PR that names it | [issues-and-docs.md](issues-and-docs.md) |
| An issue reference in chat, a PR card or a doc's frontmatter opens inline | [issues-and-docs.md](issues-and-docs.md) |
| Every markdown file in the repo, browsable, with tracked docs grouped | [issues-and-docs.md](issues-and-docs.md), and `/shipit-docs/design-docs.md` to write one |
| Comment on a selection inside a document | [issues-and-docs.md](issues-and-docs.md) |

### Configuring it

| Capability | Where |
|---|---|
| Ten settings tabs: Model providers, Roles, Integrations, Git, Instructions, Skills, Keyboard, Voice, Network, Advanced | [settings-and-accounts.md](settings-and-accounts.md), and `shipit settings list` for the live values |
| Project Settings, per repository — secrets, agent permissions, sidebar colour | [repos-and-sandboxes.md](repos-and-sandboxes.md) |
| Several agent harnesses — Claude Code, Codex, OpenCode, Grok, Antigravity | [settings-and-accounts.md](settings-and-accounts.md), and `shipit agent params` |
| Sign in with an existing subscription, or an API key as a fallback | [settings-and-accounts.md](settings-and-accounts.md) — Settings → Model providers, **not** Integrations, which holds GitHub, Linear and MCP servers |
| Several accounts per provider, in a fallback order | [settings-and-accounts.md](settings-and-accounts.md) — Settings → Model providers |
| Usage and subscription limits, visible before they bite | [settings-and-accounts.md](settings-and-accounts.md) |
| Pick the model, the reasoning effort, and the role per session | [settings-and-accounts.md](settings-and-accounts.md), and `shipit agent params` |
| Named roles that bundle harness, model and effort — including the reviewer | [settings-and-accounts.md](settings-and-accounts.md), and `/shipit-docs/agent.md` |
| Which model does ShipIt's own background work — session names, PR descriptions | [settings-and-accounts.md](settings-and-accounts.md) — background work |
| Per-session network access: contained, or open | Session settings, `/shipit-docs/environment.md` |
| Project configuration — install command, ports, resources | `/shipit-docs/shipit-yaml.md` |
| Skills, plugin repositories, and MCP servers | [plugins-and-skills.md](plugins-and-skills.md) |
| Install a skill from a catalogue — as a pull request, into a repo you choose | [plugins-and-skills.md](plugins-and-skills.md) |
| Pull a whole toolkit — services, commands, skills — from another repository | [plugins-and-skills.md](plugins-and-skills.md) |
| The Plugins tab: which commit is live, what it needs, and a Refresh button | [plugins-and-skills.md](plugins-and-skills.md) — exists only when the project declares plugins |
| Connect an MCP server, or a one-click provider, for every session | [plugins-and-skills.md](plugins-and-skills.md) |
| Custom instructions applied to every session | [settings-and-accounts.md](settings-and-accounts.md) — Settings → Instructions |
| Twenty themes, light and dark | The palette button in the app header — **not** in Settings. [settings-and-accounts.md](settings-and-accounts.md) — themes |
| Rebindable keyboard shortcuts | [settings-and-accounts.md](settings-and-accounts.md) — Settings → Keyboard |

### Running the thing itself

| Capability | Where |
|---|---|
| Install on a laptop or a VPS, by an agent or by hand | [installing-and-updating.md](installing-and-updating.md) |
| Update in place, and pick a release channel | [installing-and-updating.md](installing-and-updating.md) |
| Reach it from a phone over Tailscale or a Cloudflare tunnel | [installing-and-updating.md](installing-and-updating.md) |
| Host overview — memory, disk, uptime, what is running | The Host tab, which exists only in an Ops session |
| A memory budget that decides what idle sessions keep | [sessions.md](sessions.md) |
| Session diagnostics when a container misbehaves | [sessions.md](sessions.md) — the health strip at the top of the Terminal tab. The overflow menu's **Investigate in Ops session** is a different thing |
| Work out why something is broken, from the symptom the user describes | [troubleshooting.md](troubleshooting.md) |
| File a bug against ShipIt itself, redacted, with the user's consent | `/shipit-docs/bug-filing.md` |

## Two things ShipIt will not do, on purpose

Users sometimes ask for these. They are absent by design, and saying so is a
better answer than a workaround.

**Buttons that run commands.** There is no "run tests" button, no command
palette that executes shell, no task-runner hotkeys. The user asks in chat and
you run it; a long-running process is declared as a Compose service; one-time
setup goes in `shipit.yaml`. There is a terminal for ad-hoc poking. Spending a
turn on a routine command is the intended cost, not an inefficiency to design
around.

**Bouncing the user to GitHub.** Pull requests, diffs, CI, reviews, issues and
deploys are rendered in ShipIt. "View on GitHub" exists as an escape hatch in
overflow menus. If something is not rendered inline yet, that is a gap to
report, not a reason to send them away.
