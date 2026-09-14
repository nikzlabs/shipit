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
| "can I run two of these at once", "work on something else meanwhile" | [sessions.md](sessions.md) |
| "go back to before that change", "undo all this", "start again from there" | [sessions.md](sessions.md) — rewind and fork |
| "why did my session stop / go grey", "it lost my preview" | [sessions.md](sessions.md) — idle reclaim |
| "stop nagging me about this one", "get it out of my list" | [sessions.md](sessions.md) — mute, pin, archive |
| "keep this one at the top" | [sessions.md](sessions.md) — pin |
| "keep the app running while I'm away", "don't kill my dev server" | [sessions.md](sessions.md) — Keep preview running |
| "what needs me right now" | [sessions.md](sessions.md) — the Needs you view |
| "where did my session go", "it disappeared from the list" | [sessions.md](sessions.md) — the sidebar cap and All sessions |
| "it's stuck", "it's not responding", "restart it" | [sessions.md](sessions.md) — the health strip in the Terminal tab |
| "if I archive this do I lose it?", "can I get my branch back" | [sessions.md](sessions.md) — archiving |
| "rename this chat", "save this conversation", "bring back one I archived" | [sessions.md](sessions.md) — the session menu |
| "let it reach the internet", "it can't download anything" | [sessions.md](sessions.md) — Session settings, and Settings → Network for the workspace default |
| "change the colours", "dark mode", "it's too bright" | The palette button in the app header — 20 themes, light and dark |
| "install it", "set it up on my server", "update it", "get the new version" | [installing-and-updating.md](installing-and-updating.md) |
| "will updating interrupt my work", "get rid of it", "uninstall" | [installing-and-updating.md](installing-and-updating.md) |
| "add my repo", "work on a different project" | **Add Repository**, in the repository switcher at the top of the sidebar |
| "open it on my phone", "reach it from my laptop", "is it safe to expose" | [installing-and-updating.md](installing-and-updating.md) — access |
| "how much RAM does this need" | [installing-and-updating.md](installing-and-updating.md) — sizing |
| "why can't it reach the internet" | `/shipit-docs/environment.md`, and the Network tab in Settings |
| "show me the app", "why is the preview blank" | `/shipit-docs/preview.md`, `/shipit-docs/compose.md` |
| "merge it", "what's failing in CI", "did it deploy" | `/shipit-docs/github.md` |
| "what am I allowed to change in settings" | `shipit settings list` — the live answer, never a page here |
| "what agents/roles can this run" | `shipit agent roles` for the roles, `shipit agent params` for the harnesses, models and effort levels this install has. Neither reports which model *this* conversation is on — that is the picker in the composer |
| "file that as a bug in ShipIt itself" | `/shipit-docs/bug-filing.md` |

## Pages

| Page | Covers |
|---|---|
| [how-shipit-works.md](how-shipit-works.md) | The model — repo, session, container, branch, preview, pull request — and a census of every capability, each pointing at its page |
| [sessions.md](sessions.md) | A session's whole life: creating, forking, rewinding, pinning, muting, archiving, children, and what idle reclaim does to it |
| [installing-and-updating.md](installing-and-updating.md) | Installing ShipIt on a machine, updating it, reaching it from another device, sizing the host. Written for an agent with a shell, outside ShipIt |

Areas with no page here yet — the chat surface, previews and services, the
git and pull-request loop, issues and docs, settings and accounts, repos and
sandboxes, plugins and skills, deploys, troubleshooting — are covered from your
own side by the operating docs listed in
[`/shipit-docs/README.md`](../README.md). Answer from those, and say plainly
when something is outside what you can confirm rather than inventing a feature.

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
