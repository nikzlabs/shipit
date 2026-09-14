# Plugins, skills and MCP servers

Three ways a project extends what you can do inside a session, from smallest to
largest:

- **A skill** — a folder of instructions you load when a task matches it.
- **A plugin repository** — a whole toolkit that lives in *another* repository:
  services, commands, skills and settings, declared once in this project's
  `shipit.yaml`.
- **An MCP server** — tools from a running server, connected once per account
  and available in every session.

This page is what the **user** sees and decides. Writing a plugin is a
different job and a different page: `/shipit-docs/plugin-authoring.md`. How you
operate a plugin from inside a session is `/shipit-docs/plugins.md`.

As everywhere here: when a step is yours, do it rather than reading a command
out. When it is a control, name the control and the panel and stop.

## Skills

A skill is a directory holding a `SKILL.md` — a name, a one-line description,
and instructions you follow when the task calls for it. The description is what
tells you a skill is worth loading; the instructions are the part you read once
it is. The install sheet shows a rough context cost per skill for exactly that
reason.

Three kinds coexist, and users conflate them. They differ in who owns the
files, where they came from, and who can invoke them:

| Kind | Lives in | Invoked as | Who may edit it |
|---|---|---|---|
| **Written here** | `.claude/skills/<name>/` in the project — on a Codex session `.codex/skills/`, on Grok `.grok/skills/`, on OpenCode `.opencode/skills/`, and on Antigravity `.claude/skills/` again | `/<name>` | Anyone — it is an ordinary file in the repository |
| **Installed from a catalogue** | `<agent dir>/skills/<plugin>__<skill>/`, with a `.shipit-installed.json` marker recording its source, version and a checksum of the body | `/<plugin>:<skill>` | Leave it alone — fork it into a new directory instead |
| **Brought by a plugin** | Materialized by ShipIt outside git, marked `.shipit-plugin-skill.json` | `<alias>/<skill>` — **yours to run, not the user's** | Nobody here: fix it in the plugin's own repository |

The invocation prefix follows the harness: `/` on Claude, OpenCode, Grok and
Antigravity, and **`$` on a Codex session**. On a Codex session the menu also
lists the skills that CLI bundles, alongside the project's own.

**Writing a skill is your job.** "Every time you touch this, also update the
changelog" is a skill; the user says it once in chat and you write
`.claude/skills/<name>/SKILL.md` on the branch, like any other file. It works
on the next turn. So is removing one — delete the directory and commit. There
is no add-a-skill form and no uninstall button, deliberately: chat is the input
surface and you are the actor.

**"Why isn't my skill showing up?"** — four real causes, in the order worth
checking:

1. It is in the wrong directory for the harness this session runs on — the table
   above has them.
2. Its frontmatter says `user-invocable: false`, which hides it from the menu on
   purpose. You can still use it.
3. Its frontmatter `name:` differs from its directory name. The `name:` is what
   the menu shows and what the user types; the directory name is not.
4. It came from a plugin. Those are deliberately kept out of the menu, because
   a plugin's instructions are something the plugin brought rather than a
   command the user chose to have. Run it yourself and call it
   `<alias>/<skill>`, which is how the transcript labels it.

## Installing a skill from a catalogue

**Settings → Skills** is a browse-and-install catalogue: a search box, one card
per plugin with its skill count and author, and an **Install** button. Picking
one opens a sheet that previews each `SKILL.md` in full, shows the rough context
cost, and asks which repository to install into.

Conditions worth knowing before promising any of it:

- **The catalogue follows the harness the session runs on.** ShipIt seeds one
  for the Claude harness and one for the Codex harness, and there is no control
  for adding a marketplace of your own. On a session running another harness the
  list is simply empty.
- **Install needs GitHub connected**, because the install *is* a pull request.
- The repository must have finished cloning; one still cloning is offered but
  not selectable.

**Install never touches the session the user is in.** ShipIt opens a *separate*
session against the chosen repository, writes the skill files there, and opens a
pull request titled `Install <plugin> skill`. A toast gives the PR number. The
skill becomes usable once that PR is merged **and lands on the branch a session
is working from** — which is the answer to "I installed it, why can't you use
it?". An in-progress session cut before the merge does not have it; a fresh
session does.

Two refusals the user may hit: installing something already installed
("Uninstall first to reinstall"), and installing over a directory of the same
name that ShipIt does not manage — rename or remove that one first. A catalogue
that could not be fetched shows its own error row with a **Retry** button rather
than failing the whole tab.

To **remove** an installed skill, delete its `<plugin>__<skill>/` directory,
marker and all, and commit. Do not delete only the marker to "convert" it into
a hand-written skill; fork the contents into a new directory instead, because
editing a managed skill in place leaves it neither one thing nor the other.

## Plugin repositories

A plugin repository is how one team's tooling reaches many projects without
being vendored into any of them. The consuming project names the repository in
its own `shipit.yaml`, and ShipIt checks it out beside the session. Nobody
clones it, copies it, or keeps it in sync by hand.

What declaring one gives this project, all from the plugin's manifest:

- **Services** that join the session's Compose stack. A plugin service is
  previewable only if this project gives it a `port:` — the plugin's author
  cannot know what this stack already runs, so the port is the consumer's to
  choose. Without one it still runs; it just is not in the Preview pane.
- **Commands** on your `PATH`, which run the plugin's code in its own container.
- **Skills**, which reach you and not the composer's menu.
- **Settings** the consuming project sets, and a state directory of the
  plugin's own.
- **Declarations of what it needs** — credential names and external hosts —
  which is what turns wiring a plugin up into a guided step rather than a
  guessing game. See "needs", below.

**Declaring it is your edit, not a form.** The user says "use the tooling from
our dev-tools repo"; you write the `plugins.repos` and `plugins.use` blocks in
`shipit.yaml` — the schema is in `/shipit-docs/plugins.md`. Two things to tell
them plainly when you do:

- **It is a standing grant.** From then on ShipIt fetches and activates that
  repository on every session, with no prompt. What it trades for that is
  visible identity: the Plugins tab always shows which repository, which ref,
  and which exact commit is live.
- **Nothing is fetched until this project's repository is trusted.** An
  untrusted repository defers every command it would auto-run, plugin
  activation included. Trust is the "Trust this repository" card in the Preview
  tab, granted once per repository.

The plugin's files are **not** in the project's file tree — they are a checkout
beside it, at `/plugins/<name>` in your container, read-only on purpose. An
edit there would apply to this one session, vanish on the next refresh, and
reach nobody. Fixes go to the plugin's own repository; a problem you cannot fix
goes there as an issue (`shipit issue create --tracker <the repo's declared
name>`, which the declaration alone grants).

## The Plugins tab

**It exists only when this project's `shipit.yaml` has a `plugins:` block** —
plus the one other case, where ShipIt could not read or parse `shipit.yaml` at
all and the tab appears to say so. It is not a global
tab and it is not somewhere in Settings; it is one of the tabs in the right-hand
panel, beside Files and Docs, and it is absent in most projects. Do not promise
it before checking `shipit.yaml`.

It carries a warning dot when something needs the user: a declaration problem, a
per-repository problem, an unset credential, or a declared host this session
cannot reach. An **optional** credential or host never raises the dot — the
plugin works without it, and a dot that never clears is a dot people stop
reading.

One card per declared repository, showing its name, its source, the ref and the
nine-character commit that is live, and then:

| What you see | Means |
|---|---|
| No status chip | Active — checked out at that exact commit, with its files, commands, skills and services following it |
| *activating…* | A version is being fetched and installed right now |
| *stale* | A refresh failed; **the previous commit is still live and working** |
| *unavailable* | No working version at all; the session continues without it |
| *self · live working tree* | This repository consuming its own exports — the plugin author's case |
| Problem rows | One per problem, named: a plugin missing from the manifest, a command withheld because two plugins claim the name, a rejected service fragment, an install's own error output. Counted in an *N problems* chip when the card carries no other status |
| *N needs* | Something the user must set — see below |
| An hourglass row | A cost, not a problem: this plugin's install does not qualify for ShipIt's shared dependency store, so every session reinstalls it |

**Needs are the part that requires the user**, and each row carries the one act
that closes it:

- **An unset credential** — "`FAL_KEY` is not set for this project". **Add
  key…** opens *this* project's Secrets, which is the only store that is read;
  a value saved against the plugin's repository reaches nothing.
- **A host this session may not reach** — **Allow for session** or **Allow for
  ShipIt**, the second covering future sessions too. What the grant actually
  took effect on is reported back on the card afterwards, with a **Restart to
  apply now** button when a restart is what is missing — offered only when no
  turn is running, since a restart would kill it.
- **A host no grant can reach** is stated with no button at all, because every
  button there would be a lie. Two states read that way: this session's network
  access is off, which only turning it on fixes; and this deployment allows no
  extra hosts at all, which only whoever operates it can change. Say which of
  the two it is instead of trying to grant it.

Anything the user sets this way is theirs alone. Everything else about a plugin
is yours.

## Refreshing, and reading a plugin's status

A repository declared with a `branch:` tracks that branch, but it only
re-activates when `shipit.yaml` changes or the session opens. To pull in a
change someone just pushed to the plugin repository:

```
shipit plugin refresh          # every declared repository
shipit plugin refresh tools    # one of them
```

It waits, and prints the commit each repository moved from and to. **A failed
refresh exits non-zero and leaves the previous version live** — nothing is
broken, but you are not running what you think, which is exactly what the
non-zero exit is for.

The user has the same verb without asking you: each branch-tracking
repository's card carries a **Refresh** button, which reports what the press did
right there — updated, re-installed, already current, or failed with the detail.
**The button is absent on two cards**: a `self` card, and a **pinned**
repository, whose version moves only when its `pin:` in `shipit.yaml` changes.
Because the user can press it between your turns, read the card's commit or ask
ShipIt rather than remembering what you last activated.

When a plugin is live and still does not work, `shipit plugin status` answers
the question the Plugins tab does not: not what is live, but whether what is
live is usable. It only reads — it fetches nothing and changes nothing — and
`--json` adds the tail of the last install's own output, which is the one
surface that distinguishes "the install succeeded" from "the install never
ran". Those look identical from outside and have opposite fixes. A version you
have established is broken can be rebuilt in place with `shipit plugin refresh
<name> --force`.

## MCP servers

MCP servers give you tools from somewhere else — an issue tracker, a
documentation workspace, an error monitor. They live in **Settings →
Integrations**, under *MCP servers*, and they are **per account, not per
project**: configured once, offered in every session. They run with credentials
the user supplies, which is what makes them a different tier from ShipIt's own
brokered integrations on the same page.

**One-click connections** are the cards at the top of that section, for the
providers ShipIt has registered (Notion today). Connecting one is unambiguously
the user's act and cannot be done for them: pressing **Connect** opens a popup
on the provider's own site, they sign in and approve there, and ShipIt stores
the tokens and creates the matching server entry itself. Things to recognise:

- A **blocked popup** stops the flow before it begins; the panel says so, and
  allowing popups for ShipIt is the fix.
- **"Authentication required — reconnect"** on a connected card means the stored
  token is no longer accepted. ShipIt tries a refresh by itself when a test
  fails this way; when that does not work, **Reconnect** on that card is the
  only route.
- **Disconnect** deletes ShipIt's copy of the tokens; it does not revoke them at
  the provider, which is done on the provider's own site. A server entry the
  connection created stays visible afterwards so it can be deleted.

**Any other server** is added with **+ Add MCP Server**: a name, then either
**stdio** (a command and arguments, optionally an npm package ShipIt installs
into the session container when it starts) or **http** (a URL). Environment
variables for a stdio server and headers for an HTTP one are entered as
name/value pairs and **stored as secrets** — write-only, shown as `(unchanged)`
when editing. This is a place a user genuinely has to type: it is their
credential, and it must not pass through the chat.

Each row then offers **Enable / Disable**, **Test**, **Edit** and **Delete**.
Two conditions: **Test needs a running session** — with none, the button is
disabled and says so — and **Edit is absent on a server an OAuth connection
owns**, because that connection manages its configuration. A successful test
names the tools it found; a failure shows the server's own error.

A row also carries a live status badge — *loaded*, *failed*, *crashed* — which
is what the agent CLI itself reported at its last start, with the reason. That
is the badge to read when a server is configured, enabled, and its tools are
still not there.

**When a change takes effect:** ShipIt reads the enabled servers fresh at the
start of every turn, so adding, enabling or disabling one lands on the next
message — no session restart. The exception is a stdio server's npm package,
which is installed when a session's container starts; that one may need a new
session before its command exists.

## Who does what

| The user does | You do |
|---|---|
| Presses Install in Settings → Skills, and merges the pull request it opens | Say when the skill will actually be usable, and on which branch |
| Asks for a skill in chat | Write it, remove it, or fix it — it is a file on the branch |
| Trusts the repository, once | Say that plugins stay inactive until they do |
| Sets a plugin's key, allows a plugin's host | Read the card, name which plugin needs what, and stop guessing at the cause |
| Presses Refresh on a plugin card | `shipit plugin refresh`, and `shipit plugin status` before concluding anything |
| Connects an MCP provider, types its credentials | Everything after that — using the tools, and reading the badge when they are missing |
