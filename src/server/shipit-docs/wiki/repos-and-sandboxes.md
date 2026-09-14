# Repositories and sandboxes

A session needs a workspace, and there are exactly two kinds. Almost always it
is a **repository** the user added once, which every later session is cut from.
The other is a **sandbox** — an empty workspace with no repository at all, and
an explicit set of things the agent in it may use.

This page covers getting a project in, what ShipIt does with it, what is
configured per repository, and what a sandbox changes.

When a step here is something **you** can do, do it. When it is a control, name
the control and the panel, and stop.

## Adding a repository

The control is the **GitHub-mark button in the sidebar header**, which opens the
repository switcher: **Add Repository**. When the sidebar has nothing at all to
list, its body is an empty state carrying the same button. The switcher is also
where the user moves between repositories.

**It needs a connected GitHub account.** Without one the dialog is not a search
box at all — it renders a *"Connect GitHub to add repositories"* step with a
token field, because importing and creating repositories are both backed by
GitHub. Say that plainly rather than describing a search box the user cannot
see.

With an account connected, three ways in:

- **Search** — the dialog lists the user's own repositories straight away and
  filters as they type, each marked Private or Public.
- **Paste** — a full clone URL, or the `owner/name` short form, then Enter.
- **Create new repository** — the button at the bottom left. It creates a real
  repository on GitHub from a template (React, Next.js, Astro, Express, Hono,
  FastAPI, Streamlit, an empty one, and others), with a name, an optional
  description, private or public, owned by the user or by one of their
  organisations. ShipIt then adds it like any other.

A credential embedded in a pasted URL is **stripped and never stored** — access
comes from the connected GitHub account at fetch time. So a URL with a token in
it does not make an unreachable repository reachable; if the clone fails, the
connected account is what has to be able to read it.

Adding a repository that is **already added** does not clone it twice. It
un-hides it and brings it back to the sidebar — which is the supported way to
recover one the user hid (the dialog marks such a row *"Already added · hidden"*
with a **Show** action).

### What ShipIt does with it

**One bare clone per repository, on the host, shared by every session.** A new
session is then a *local* clone off that cache, which hardlinks the object store
instead of copying it. That is the whole reason sessions are cheap enough to
have six of at once: the repository is fetched once, not once per session.

ShipIt also prepares a **warm session** for the repository in the background, so
the user's next "New session" opens instantly rather than waiting for a clone.

## Trust: what an untrusted repository changes

**Cloning a repository never runs its code.** A freshly added remote is
*untrusted*, and until the user accepts once, ShipIt defers everything the
repository could have told it to execute: the `agent.install` commands in
`shipit.yaml`, and every compose `command:` and `build:`.

While a repository is untrusted:

| Blocked | Still works |
|---|---|
| **Messages to the agent** — the composer is disabled and the server refuses the turn | The file tree, diffs, and the other panel tabs |
| The preview, and the whole Compose stack | Reading everything in the repository |
| `agent.install` and compose `command:` / `build:` | Adding, hiding and removing repositories |

That first row is the one that brings the user to you, and they usually describe
it as the app being broken rather than as a permission. It is not: it is a
one-time consent, and it is the same shape as VS Code's Restricted Mode.

Two places carry the grant, and both say **"Trust this repository"**:

- **Above the composer**, as a notice explaining why messages are blocked. This
  is the reliable one — it renders in every mode. One caveat: the *button* needs
  a remote ShipIt actually tracks as a repository. If the session's remote
  matches no entry, the notice still explains the block but carries no grant —
  which means the fix is to add that repository, not to hunt for a button.
- **The Preview tab**, which renders a restricted empty state where the preview
  would be. Conditional: there are installs with no Preview tab at all, and
  there the composer notice is the only way in. Name that one first.

The decision is **per remote**, and it is remembered for every session on that
repository — nobody is asked twice. Granting it needs no restart: the deferred
install and compose start running on the spot. A repository ShipIt **created**
from a template is trusted at creation and never reaches this state.

One limit worth knowing before recommending a clean-up: trust is stored **on the
repository's entry**, so *removing* a repository discards it. Add the same
repository back later and it is untrusted again, and the first session on it is
blocked until the user accepts once more. It is remembered for as long as the
repository is on the list, not for ever.

## Per-repository settings

The **Project Settings** dialog is reached from the **repository group's
overflow menu in the sidebar** (the `⋯` on the group header, beside *View All
Sessions*). It has three tabs.

**Secrets** — the values this repository's services need. Its own section below.

**Deployments** — two unrelated things sharing a tab:

- **Agent permissions → "Allow agents to merge their own pull requests."** It
  ships off and is granted per repository; read this one's state with `shipit
  settings get project.allowAgentMerge` rather than assuming. When it is on, an
  agent may merge **only the pull request its own session opened**, only when
  every check has passed, and never with a force-merge; GitHub's branch
  protection and required reviews still apply on top. This toggle is the user's
  alone — the route that writes it refuses a session container, so you cannot
  grant yourself the permission, and asking is the only path you have.
- **Connect your repo** — links to Vercel, Cloudflare Pages and Netlify. These
  are account pages on other people's products, so they open in a new tab; that
  is the narrow exception, not a habit. What ShipIt does on its side is push
  after every turn and render the resulting deploy status on the pull-request
  card.

**Appearance** — the repository's **sidebar colour**: the coloured edge marking
its group. Sixteen to choose from, assigned automatically and kept distinct
until the sixteen run out, and a small dot marks a colour another repository is
already using (picking a duplicate on purpose is allowed). Two conditions worth knowing
before promising it: the coloured edge is only drawn when the sidebar is
showing **more than one group**, so on a single-repository install there is
nothing to see; and this is per repository, not the app's theme — the theme is
the palette button in the app header.

**Ordering is not in this dialog.** "Can I put my projects in my own order?" is
a fair question and the answer is yes, by **dragging a repository's header row**
in the sidebar; the order is saved. A drag handle appears on the header on hover
only when more than one repository is visible — with a single one there is
nothing to reorder and no handle.

**Read the current values rather than guessing them.** Project settings are in
the same read as the global ones: `shipit settings list` indexes them under keys
beginning `project.`, and `shipit settings get project.allowAgentMerge` gives
one in full. A per-repository setting read from a session that binds no
repository comes back `unreadable (no_repository)` — report that as unknown, not
as off.

**Project Settings is not `shipit.yaml`.** The dialog holds what the *user*
owns for this repository — values, permissions, colour — and it lives in
ShipIt's own store. What the *project* declares — the install commands, the
services, the ports, which secrets each service needs, the issue trackers — is
files in the repository, and those are yours to edit: `shipit.yaml`
(`/shipit-docs/shipit-yaml.md`) and `docker-compose.yml`
(`/shipit-docs/compose.md`).

## Hiding and removing a repository

Both are on that same repository menu, and they are very different acts.

**Hide from sidebar** declutters and destroys nothing. The group disappears; a
collapsed **"Hidden · N"** section appears at the bottom of the sidebar, and
expanding it offers **Show** on each row. Adding the repository again also
un-hides it.

**Remove Repository** asks for confirmation first. What it does:

- Its sessions are **archived**, not deleted.
- Freed from this machine: each session's working copy, its cached dependencies,
  and its running containers.
- Kept: session chat history, usage and pull-request status; and every branch
  and pull request on GitHub.
- **The repository itself is not touched.** Removing it from ShipIt does not
  delete it on GitHub.
- Adding it back later brings its sessions back under **All Sessions**, ready to
  restore, history and all. Restoring re-clones a fresh working copy.
- Its **trust is discarded** with it, per the section above.

**"Will I lose work that was never pushed?"** — almost certainly not, and the
confirmation dialog's own wording is more pessimistic than the behaviour. Each
session is archived through the same durability check archiving always runs:
ShipIt commits whatever is outstanding, pushes the branch, and only then
reclaims the checkout. If it **cannot** make the work durable — a push that
failed, a detached HEAD, changes git refused to commit, a workspace it could not
read — it **keeps that session's files** instead of deleting them.

Three consequences, none of them obvious:

- **Removal can publish.** A commit and a push are exactly how the work is made
  safe, so a branch that only ever existed locally can appear on GitHub as a
  result of removing the repository. Say so before the user clicks, if the
  repository is one where that matters.
- **Nothing tells the user when files were kept.** The retention is real and it
  is logged on the server, but this path reports only success — unlike archiving
  a single session, which does say so. So do not promise a notice, and do not
  read the absence of one as proof that everything was reclaimed.
- **A kept checkout is not guaranteed to come back as it was.** Restoring runs
  the same durability check again. If it *now* succeeds — the push that failed
  works because the network is back or the GitHub connection was repaired —
  ShipIt pushes the work and then replaces the checkout with a fresh clone on a
  **new branch**. The commits are safe on the remote; the session does not
  resume them. It is restored where it stood only while it is *still* not
  durable.

If a user wants removal to be quiet as well as safe, the honest answer is to get
the branches pushed first — which you can do — and then remove.

## Secrets for a project

A project's runtime credentials — a database URL, a Stripe key, an API token —
live in a **per-repository secret store**, never in the repository. The work
splits cleanly: **you declare what is needed; the user supplies the value.**

**Your half.** A service declares the environment variables it wants in
`docker-compose.yml` under `x-shipit-secrets`, a list of names, optionally with
a `description`, `required: true`, or `agent: true`. Declaring is what wires a
value up — the full reference is `/shipit-docs/secrets.md`. Write the
declaration yourself rather than telling the user to; the compose file is yours.

**Their half.** The values are typed in **Project Settings → Secrets**, which
shows one row per declared name (with your description under it, which is why
writing a good one is worth the line) and a free-form **Custom variables**
section below. There are two other doors into that same tab: the **Configure**
button on the missing-secrets banner, and the credential rows in the Plugins
panel.

What follows from the design, and answers most of what users ask:

- **Nothing reads a value back out of the store.** Neither the browser nor a
  settings read ever receives one: both report which *names* are set and nothing
  more, and the Secrets tab shows a saved value as dots it cannot reveal. So
  "what is my Stripe key set to?" is not a question ShipIt will answer — "is it
  set?" is. That is a guarantee about *reading the store*, not about where
  values end up: they are delivered into containers and processes that declared
  them, which is the whole point of storing them.
- **A value only reaches the services that declared it.** A `web` frontend does
  not receive the `db` password.
- **You see a value only if it is marked `agent: true`**, which puts it in the
  agent container's environment for CLI tools that need it (`prisma migrate`,
  codegen). Treat anything so marked as exposed and keep real credentials out of
  it.
- **Marking a secret `required: true`** surfaces a banner above the preview
  naming what is missing, with **Configure** on it. It is informational — the
  stack still tries to start.
- **Saving applies immediately.** ShipIt rewrites the env files and recreates
  the affected containers; nobody has to restart anything. A service the user
  started by hand is left alone.
- **A name nothing declares is injected nowhere.** It is stored, and that is
  all. Two kinds of thing declare a name: a compose service's
  `x-shipit-secrets`, which you write, and a **plugin** the project uses, which
  declares the credentials it needs and is served from this same repository's
  store. So a "custom" variable may already be wired up by a plugin without
  appearing in any compose file — the Secrets tab marks which plugin asked for
  it. Check there before telling a user their value is going nowhere.
- **Deleting a service is a secrets change.** The declaration lives on the
  service, so removing the last service that names a secret silently un-wires
  it — including from the agent container if it was `agent: true`. Re-declare it
  on a service that survives.

**Never commit a credential to the repository instead.** ShipIt scans the tree
and refuses the automatic commit when it finds a likely one, and that refusal is
not per file: nothing commits or pushes until it is gone, including later,
unrelated work. A banner above the composer names the file and line for as long
as it lasts. The fix is to move the value into a secret or an environment
variable — or, for a genuine false positive, a `gitleaks:allow` comment on that
line.

## Sandbox sessions

A sandbox is a session with **no repository bound**. `/workspace` starts empty;
ShipIt clones nothing, tracks nothing, previews nothing, commits nothing, and
opens no pull request on its own. It is the shape for work that is not one
project: comparing two repositories, a scratch experiment, a throwaway script, a
tool that needs Docker.

The user creates one from the **"+" (New advanced session) button in the sidebar
header → Sandbox session**. Sandboxes get their own group in the sidebar. They
have no Preview tab and no PR tab, and the chat panel carries an orientation
banner where a pull-request card would be.

**You still do real work in one.** Clone what you need into a subdirectory —
one repository per directory — `cd` into it, and drive git yourself: branch,
commit, push, and `gh pr create` from inside that clone. ShipIt's automatic
commit and its branch guard are both off here, so nothing is done for you and
nothing is in your way. The workspace survives between turns and across idle
container destruction; treat pushed state as the source of truth anyway. What
does **not** work is `shipit session create` — spawning claims the parent's
repository, and there isn't one. The full operating contract is
`/shipit-docs/sandbox-session.md`.

### The four capability switches

These are the user's to set, and they are the reason a sandbox can be both
useful and safe. Each names exactly what it widens:

| Switch | Granted means | Off means |
|---|---|---|
| **GitHub access** | The credential broker is wired for `git` and `gh`: clone and push **private** repositories, open pull requests, anywhere that account can reach. The token is brokered, never resident in the container | No GitHub token. Public HTTPS clones may still work; pushing to the user's repositories does not. This is **not** a network seal |
| **Allow merging PRs** | The agent may run `gh pr merge` — gated on green checks, never a force-merge | The agent cannot merge. This is a *sub-grant* of GitHub access: it is unavailable, and is cleared, whenever GitHub access is off |
| **Docker access** | `DOCKER_HOST` points at a **session-scoped** Docker proxy — only this session's containers, networks and volumes are visible. No host socket, no `--privileged` | No Docker at all |
| **Network access** | Whatever every other session gets. Normally the standard allowlist (LLM API, GitHub, package registries, hosts the user added) with an inline prompt for a new host — but this switch does not decide that. A per-session override decides it if one is set, otherwise the workspace's Network setting, and either can be Open | Egress is tightened to the agent's lifeline (the LLM API and ShipIt), plus GitHub if that is granted — **where the install enforces containment at all**. It only ever tightens; it is never an air-gap, and on an install with no enforcement it is inert |

They are **server-authoritative**. An agent cannot read them out of a workspace
file and cannot grant itself one — the route that writes them refuses a session
container outright.

### Finding out what *this* sandbox allows

**Do not assume a default, and do not assume what you had last turn.** The
grants are chosen per sandbox at creation and the user can change them at any
time afterwards. There is **no command that reports all four to you**, and the
capabilities endpoint is deliberately closed to session containers — a request
from inside comes back `403 This endpoint is not available to session
containers`. So work it out:

- **Network access** is the one with a machine-readable tell. `shipit settings
  get network.egressContained` reports the workspace setting's *value*, and
  separately what it *does to this session* — and for a sandbox with Network
  access **off** that effect comes back `excluded`, with a note saying this
  session's own network capability decides its containment. **Read the note, not
  the value, and not the word `excluded` alone**: a second `excluded` means
  egress enforcement is not running on the install at all and tells you nothing
  about the grant, and a read that fails reports `unknown` / `uncertain`, which
  is not evidence either way. Only that one specific note is a positive signal,
  and it reports the **saved** grant, not what this container is running under.
- **Ask the user, and tell them where to look.** The sandbox banner at the top
  of the chat panel says *"Granted: …"*. Two caveats to carry when you quote it:
  it names GitHub, Docker and Network only — the merge sub-grant is not on it,
  so that one is the Session settings dialog — and it lists what is **saved**,
  which is not the same as what this container is running under (below).
- **Docker:** `DOCKER_HOST` is set in your environment when the container was
  **started** with Docker access. Treat its absence as decisive and its presence
  as only suggestive: the Docker proxy re-checks the grant on every request, so
  the variable can be there while each call is refused — while a restart is
  pending, and also after ShipIt itself has restarted, which re-derives a
  session's Docker access without consulting the sandbox grant. The honest
  reading is "this container was started with it"; if a Docker call is then
  refused, say that rather than assuming the grant is off.
- **GitHub:** a brokered operation refused with *"GitHub access is not granted
  for this sandbox session"* is the grant being absent, not a broken token. This
  one applies at once, so the refusal is always current.

**Do not diagnose a missing Network grant from a failed connection.** A blocked
host and a host that is simply unreachable both close the same way; a genuine
outage would send you asking the user to widen permissions they never needed to
touch. Read the setting above instead.

When something fails for want of a grant, **name the switch and stop**. Do not
engineer around it: the user turns it on in one click, and a workaround that
evades a capability they deliberately withheld is the wrong answer even when it
works.

### Changing the grants later

Two entry points, both the user's: **Session settings** on the open session's
row in the sidebar, and the **Change** button on the sandbox banner. For a
sandbox, that dialog holds the four switches *instead of* the network mode radio
group every other session gets — a sandbox's Network access is already one of
these grants, and two controls over one session's egress would be two answers to
one question.

When a change takes effect depends on which switch moved:

- **GitHub access** applies at once.
- **Docker** and **Network** are plumbed when the container is created, so they
  apply on the next container start. The dialog says *"Pending · applies on next
  container start"* and offers **Restart to apply now** — never automatic, and
  disabled while a turn is running, since a restart would kill the agent
  mid-work.
- **GitHub access while Network access is off** also moves the container's
  lifeline allowlist, so that combination is pending too.

Every change is recorded as a card in the transcript, so what was granted, when,
and what it moved from stays readable later. Revoking a grant removes your
access to it; it destroys nothing you already made.

## Who does what

| The user does | You do |
|---|---|
| Adds, hides and removes repositories; creates one from a template | Everything inside the checkout |
| **Trusts a repository once**, from the notice above the composer or the Preview tab | Say plainly that this is why messages are blocked, and name the control |
| Types secret **values** in Project Settings → Secrets | Declare the names in `x-shipit-secrets`, and name the exact missing one when it blocks you |
| Turns on "Allow agents to merge their own pull requests" | Ask for it when merging is the ask; never route around it |
| Chooses a sandbox's capability switches | Find out what is granted, use it, and name the switch when one is missing |
| Picks the repository's sidebar colour | — |
