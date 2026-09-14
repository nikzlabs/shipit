# The ShipIt wiki

What ShipIt can do, for when the user asks you.

The other files in `/shipit-docs/` are your operating manual — how to write a
compose file, how to spawn a session, how to file an issue. **This directory is
different.** It describes ShipIt as a product: the panels the user works in, the
things they can ask for, what happens when they do. Most of it is surface you
never touch yourself, which is exactly why it has to be written down — you have
no other way to know it.

Read a page here when the user asks what ShipIt does, whether it can do
something, why it did something, or how to get it to. Do not make the user go
and look it up. That is the whole point of the product: they ask, you answer.

## How to write, and who acts

Every page here obeys three rules. Follow them when you answer from a page, and
when you add one.

**1. If ShipIt gives you a way to do it, you do it.** The user is talking to you
precisely so they don't have to type commands. "Run `shipit service start db`"
is not an answer to give a human; starting the service is. When a page carries a
command, the command is *yours*.

**2. If it is genuinely the user's act, say so and say where.** Merging a pull
request, signing in to GitHub, choosing a model, picking a theme. Name the
control and the panel it is in, in one sentence, so they never hunt for it.
Then stop — do not talk them through a UI they are looking at.

**3. Never send them out of ShipIt for something ShipIt already shows.** Pull
requests, CI, diffs, issues, deploys, and preview all render in place. A link to
github.com is an escape hatch, never the answer.

## If the user asks… read this

The left column is how a user actually phrases it. The right is where the answer
is. Nobody says "rewind" or "Tailscale" until after they have learned to.

| The user says | Read |
|---|---|
| "what is this thing / how does it work" | [how-shipit-works.md](how-shipit-works.md) |
| "can it do X?" — anything at all | [how-shipit-works.md](how-shipit-works.md) has the capability census; start there |
| "why is it building a new branch every time" | [how-shipit-works.md](how-shipit-works.md) |
| "it's broken", "something's wrong", "why did that fail" | [troubleshooting.md](troubleshooting.md) — indexed by symptom |
| "how do I give it a screenshot", "can I upload a file" | [chat.md](chat.md) — attachments and `/uploads` |
| "how do I point it at a file", "what does the @ do" | [chat.md](chat.md) — `@` file references |
| "what are those slash things", "how do I run one of my skills" | [chat.md](chat.md) — the `/` menu |
| "stop, that's wrong", "how do I make it stop" | [chat.md](chat.md) — interrupt |
| "can I tell it something while it's working", "it ignored what I typed" | [chat.md](chat.md) — live steering and the queue |
| "where did my queued message go", "cancel that last thing I sent" | [chat.md](chat.md) — the queue strip |
| "it keeps asking me to approve things" | [chat.md](chat.md) — permission prompts and permission mode |
| "make it plan first, don't let it touch anything" | [chat.md](chat.md) — Plan mode |
| "can I talk to it instead of typing", "dictate" | [chat.md](chat.md) — voice |
| "can it read things out to me", "why did my phone buzz" | [chat.md](chat.md) — voice notes, and `/shipit-docs/voice-notes.md` |
| "this chat is enormous", "hide all that tool spam" | [chat.md](chat.md) — collapsed turns |
| "search this conversation", "where did it say that" | [chat.md](chat.md) — search |
| "what's that ring", "is it running out of room", "how much has this cost" | [chat.md](chat.md) — the context dial |
| "it's forgotten what we said", "free up space" | [chat.md](chat.md) — compaction |
| "keep going until it works", "set it a target" | [chat.md](chat.md) — goals |
| "show me a diagram", "where did that mockup go" | [chat.md](chat.md) — Present, and `/shipit-docs/present.md` |
| "what were those tick boxes it gave me" | [chat.md](chat.md) — proposed actions |
| "reply to just this bit" | [chat.md](chat.md) — quoting |
| "can I run two of these at once", "work on something else meanwhile" | [sessions.md](sessions.md) |
| "go back to before that change", "undo all this", "start again from there" | [sessions.md](sessions.md) — rewind and fork; [pull-requests.md](pull-requests.md) for what it does to the branch on GitHub |
| "why did my session stop / go grey", "it lost my preview" | [sessions.md](sessions.md) — idle reclaim |
| "stop nagging me about this one", "get it out of my list" | [sessions.md](sessions.md) — mute, pin, archive |
| "keep this one at the top" | [sessions.md](sessions.md) — pin |
| "keep the app running while I'm away", "don't kill my dev server" | [sessions.md](sessions.md) — Keep preview running |
| "what needs me right now" | [sessions.md](sessions.md) — the Needs you view |
| "where did my session go", "it disappeared from the list" | [sessions.md](sessions.md) — the sidebar cap and All sessions |
| "it's stuck", "it's not responding", "restart it" | [sessions.md](sessions.md) — the health strip in the Terminal tab, then [troubleshooting.md](troubleshooting.md) |
| "it keeps restarting", "it says the session is disabled" | [troubleshooting.md](troubleshooting.md) — out of memory, creation failure, stale build |
| "everything's slow", "my sessions keep stopping" | [troubleshooting.md](troubleshooting.md) — memory pressure |
| "if I archive this do I lose it?", "can I get my branch back" | [sessions.md](sessions.md) — archiving |
| "rename this chat", "save this conversation", "bring back one I archived" | [sessions.md](sessions.md) — the session menu |
| "let it reach the internet", "it can't download anything", "it says egress blocked" | [sessions.md](sessions.md) — Session settings, and Settings → Network for the workspace default; [troubleshooting.md](troubleshooting.md) for the allowlist prompt |
| "I can't type", "the message box is greyed out" | [troubleshooting.md](troubleshooting.md) — the three reasons the composer is disabled |
| "my dictation broke" | [troubleshooting.md](troubleshooting.md) — the voice error panel |
| "show me the app", "why is the preview blank", "it's just white" | [previews.md](previews.md), then [troubleshooting.md](troubleshooting.md) for the overlay states |
| "set up a preview for this", "why is there no preview tab" | [previews.md](previews.md) |
| "it keeps saying connecting to the dev server" | [previews.md](previews.md) |
| "my changes don't show up", "it's not reloading" | [previews.md](previews.md) — hot reload needs polling across containers |
| "start the database", "my database isn't running", "it says crashed" | [previews.md](previews.md) — services, `shipit service list` for what this project has; [troubleshooting.md](troubleshooting.md) for a service that will not start |
| "where are the logs for my app" | [previews.md](previews.md) — the Services drawer, and `shipit service logs` |
| "what does it look like on a phone", "check it at tablet size" | [previews.md](previews.md) — device viewports |
| "the preview doesn't work when I open it on my server's address" | [previews.md](previews.md) — a raw IP cannot carry preview subdomains |
| "can I send someone this preview link" | [previews.md](previews.md) — a preview has no login of its own |
| "merge it", "ship it", "can you merge it yourself" | [pull-requests.md](pull-requests.md) — merging, and the repository permission that lets the agent do it |
| "open a PR", "why is there no PR yet", "change the title" | [pull-requests.md](pull-requests.md) — opening one, and the PR tab |
| "what's failing", "why is it red", "fix the build" | [pull-requests.md](pull-requests.md) — CI and auto-fix; [troubleshooting.md](troubleshooting.md) when no checks ever ran |
| "it says conflicts", "it won't merge", "my branch is behind" | [pull-requests.md](pull-requests.md) — merge conflicts |
| "it says my branch diverged", "it won't push" | [troubleshooting.md](troubleshooting.md) — the rebase banner |
| "did anyone review it", "answer that comment", "mark that resolved" | [pull-requests.md](pull-requests.md) — review threads |
| "let me comment on this bit", "send them my notes" | [pull-requests.md](pull-requests.md) — the user's own review |
| "merge it when the tests pass", "don't wait for me" | [pull-requests.md](pull-requests.md) — auto-merge |
| "scrap it", "close it", "it's a draft" | [pull-requests.md](pull-requests.md) — closing, reopening, marking ready |
| "my PR merged, what now" | [pull-requests.md](pull-requests.md) — after it merges |
| "cut a release", "tag a version", "publish it" | [pull-requests.md](pull-requests.md) — cutting a release |
| "where are my issues", "connect my Linear", "I connected Linear and nothing showed up" | [issues-and-docs.md](issues-and-docs.md) — the Issues tab and how a tracker is declared |
| "work on this ticket", "start from this issue" | [issues-and-docs.md](issues-and-docs.md) — Start session from an issue |
| "close the ticket when this lands", "why is that issue still open" | [issues-and-docs.md](issues-and-docs.md) — Closes / Refs in the PR body |
| "change the priority", "assign this to me", "add a label", "file a ticket for that" | [issues-and-docs.md](issues-and-docs.md) — who changes what |
| "I can't find my issue", "where did that ticket go" | [issues-and-docs.md](issues-and-docs.md) — the list is a window over the tracker |
| "where are my design docs", "show me the spec", "why did that doc disappear from the list" | [issues-and-docs.md](issues-and-docs.md) — the Docs tab and its grouping |
| "let me comment on this paragraph", "mark up this doc" | [issues-and-docs.md](issues-and-docs.md) — selection comments |
| "add my repo", "work on a different project" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — **Add Repository**, in the repository switcher at the top of the sidebar |
| "start a new project", "make me a new repo" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — Create new repository |
| "why won't it let me type", "it says the repo isn't trusted", "nothing runs since I added it" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — trust |
| "my app needs an API key", "it needs a database password", "it says a secret is missing" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — secrets |
| "it stopped committing, something about a secret" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — secrets; [troubleshooting.md](troubleshooting.md) — a likely secret in the working tree |
| "can it merge the PR by itself" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — Project Settings, Deployments; [pull-requests.md](pull-requests.md) for what it then does |
| "get this project out of my list", "delete this repo", "if I remove the repo do I lose my code" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — hiding and removing |
| "put my projects in my own order" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — ordering |
| "make this project a different colour", "I can't tell my projects apart" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — Appearance |
| "I just want to try something", "give me a blank workspace", "no repo" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — sandbox sessions |
| "why can't it use docker here", "it can't clone my private repo in this one" | [repos-and-sandboxes.md](repos-and-sandboxes.md) — sandbox capability switches |
| "teach it to always do X", "make that a reusable thing" | [plugins-and-skills.md](plugins-and-skills.md) — skills |
| "install that skill", "add a skill from the list" | [plugins-and-skills.md](plugins-and-skills.md) — Settings → Skills |
| "why can't it see the skill I installed" | [plugins-and-skills.md](plugins-and-skills.md) — the install PR has to merge onto the branch |
| "use the tools from our other repo", "share this setup across projects" | [plugins-and-skills.md](plugins-and-skills.md) — plugin repositories |
| "what's this Plugins tab", "it says something needs a key" | [plugins-and-skills.md](plugins-and-skills.md) — the Plugins tab |
| "get the latest version of that plugin", "it's out of date" | [plugins-and-skills.md](plugins-and-skills.md) — refreshing |
| "connect Notion", "let it read our Sentry", "add my own tools" | [plugins-and-skills.md](plugins-and-skills.md) — MCP servers |
| "deploy to my server", "ssh into the box", "run this on production", "give it access to my VPS" | [settings-and-accounts.md](settings-and-accounts.md) — SSH hosts, and `/shipit-docs/ssh.md` for using one |
| "it can't see my Notion pages any more" | [plugins-and-skills.md](plugins-and-skills.md) — reconnect an expired MCP connection |
| "connect my Claude account", "sign in to ChatGPT", "where do I put my provider key" | [settings-and-accounts.md](settings-and-accounts.md) — connecting a provider |
| "I've run out", "how much have I got left", "what's my limit", "it says quota" | [settings-and-accounts.md](settings-and-accounts.md) — usage and subscription limits; [troubleshooting.md](troubleshooting.md) for a turn that failed on it |
| "what's this costing me" | [settings-and-accounts.md](settings-and-accounts.md) — Usage Summary |
| "add a second account so it doesn't run out", "why didn't it fall back" | [settings-and-accounts.md](settings-and-accounts.md) — several credentials on one service |
| "use a different model", "make it think harder" | [settings-and-accounts.md](settings-and-accounts.md) — choosing what a session runs on |
| "why can't I change the model", "it's stuck on the wrong one" | [settings-and-accounts.md](settings-and-accounts.md) — the harness locks at the first message |
| "can it run GPT / Gemini / Grok" | [settings-and-accounts.md](settings-and-accounts.md) — harnesses are a build input, and `shipit agent params` |
| "who's reviewing this", "get a different reviewer" | [settings-and-accounts.md](settings-and-accounts.md) — the reviewer |
| "set up a researcher I can call", "what are these roles" | [settings-and-accounts.md](settings-and-accounts.md) — roles |
| "tell it to always do X", "give it standing instructions" | [settings-and-accounts.md](settings-and-accounts.md) — Settings → Instructions, and roles for a per-job brief |
| "that key does the wrong thing", "change my shortcuts" | [settings-and-accounts.md](settings-and-accounts.md) — keyboard shortcuts |
| "why does it name my sessions", "what writes the PR description" | [settings-and-accounts.md](settings-and-accounts.md) — background work |
| "change the colours", "dark mode", "it's too bright" | The palette button in the app header — 20 themes, light and dark. [settings-and-accounts.md](settings-and-accounts.md) — themes |
| "install it", "set it up on my server", "update it", "get the new version" | [installing-and-updating.md](installing-and-updating.md) |
| "will updating interrupt my work", "get rid of it", "uninstall" | [installing-and-updating.md](installing-and-updating.md) |
| "open it on my phone", "reach it from my laptop", "is it safe to expose" | [installing-and-updating.md](installing-and-updating.md) — access |
| "how much RAM does this need" | [installing-and-updating.md](installing-and-updating.md) — sizing |
| "how do I back this up", "move it to a new machine", "what if the disk dies" | [installing-and-updating.md](installing-and-updating.md) — backing up, and moving to another machine |
| "put this online", "how do I actually ship this", "get it on a real URL" | [deploying.md](deploying.md) |
| "did it deploy", "is it live yet", "where's the link to the deployed site" | [deploying.md](deploying.md) — the deployment row on the pull request |
| "the deploy failed", "the build broke on Vercel", "why won't it build" | [deploying.md](deploying.md) — when a deploy fails |
| "why isn't my site updating", "it's still showing the old version" | [deploying.md](deploying.md) |
| "connect it to Vercel / Netlify / Cloudflare" | [deploying.md](deploying.md) — Project Settings → Deployments, on the repository's menu in the sidebar |
| "what am I allowed to change in settings" | `shipit settings list` — the live answer, never a page here; [settings-and-accounts.md](settings-and-accounts.md) for what the tabs are for |
| "what agents/roles can this run" | `shipit agent roles` for the roles, `shipit agent params` for the harnesses, models and effort levels this install has. Neither reports which model *this* conversation is on — that is the picker in the composer |
| "file that as a bug in ShipIt itself" | `/shipit-docs/bug-filing.md` |

## Pages

| Page | Covers |
|---|---|
| [how-shipit-works.md](how-shipit-works.md) | The model — repo, session, container, branch, preview, pull request — and a census of every capability, each pointing at its page |
| [sessions.md](sessions.md) | A session's whole life: creating, forking, rewinding, pinning, muting, archiving, children, and what idle reclaim does to it |
| [installing-and-updating.md](installing-and-updating.md) | Installing ShipIt on a machine, updating it, reaching it from another device, sizing the host. Written for an agent with a shell, outside ShipIt |
| [repos-and-sandboxes.md](repos-and-sandboxes.md) | Adding a repository and what ShipIt does with it, repository trust, per-repository settings and secrets, hiding and removing a project, and sandbox sessions with their capability switches |
| [previews.md](previews.md) | The preview pane and Compose services: what a preview is, which sessions have one, what the project must declare, the Services drawer, device viewports, the Errors panel, and why a preview goes blank |
| [pull-requests.md](pull-requests.md) | The GitHub loop: the pull-request card, reviews and threads, the user's own review, CI and auto-fix, conflicts, merging and auto-merge, rollback, and cutting a release |
| [issues-and-docs.md](issues-and-docs.md) | The Issues panel and the Docs tab: trackers and how one is declared, filtering and sorting, starting a session from an issue, closing one on merge, the docs list, and commenting on a selection in a document |
| [settings-and-accounts.md](settings-and-accounts.md) | The two settings dialogs and their tabs: connecting a provider, several credentials on one service, choosing what a session runs on, roles and the reviewer, SSH hosts, background work, usage limits, themes and keyboard shortcuts |
| [plugins-and-skills.md](plugins-and-skills.md) | Skills and where they come from, installing one from a catalogue, plugin repositories and the Plugins tab, and MCP servers |
| [troubleshooting.md](troubleshooting.md) | Indexed by the symptom the user describes: a blank preview, a stuck agent, a disabled composer, blocked commits, a diverged branch, silent CI, a dying container, blocked egress, a crashed service |
| [deploying.md](deploying.md) | Getting the project onto a real URL: connecting a hosting platform, deploying on every push, deploy status on the pull request, what to do when a deploy fails, and what ShipIt does not do |
| [chat.md](chat.md) | The composer and the conversation: attachments, `@` and `/`, interrupting and queueing, permission prompts and questions, voice, collapsed turns, context and compaction, goals, Present, proposed actions |

Every area of the product now has a page. That does not make the set complete —
where a page does not answer what the user asked, say plainly that you cannot
confirm it rather than inventing a feature, and read your own operating docs in
[`/shipit-docs/README.md`](../README.md) for your side of the same ground.

## What is never written down here

Anything ShipIt can tell you *right now* stays a live question, because a value
copied into a page is a value that will be wrong later:

- **Settings and their current values** — `shipit settings list`, then
  `shipit settings get <key>` for one in full. It prints the user's own
  description of each setting, so you can name the exact control that is the
  blocker instead of saying "check Settings".
- **Services in this project and whether they are up** — `shipit service list`.
- **Which agents and roles this install has** — `shipit agent roles`,
  `shipit agent params`.
- **Issue trackers wired up here** — there is no inventory command; a
  `shipit issue list --tracker <name>` naming a tracker that is not declared
  fails with the list of the ones that are.

A page may tell you *that* a setting decides something, and what the choice
means. It never tells you what it is set to.
