# Settings and accounts

How ShipIt is configured, and how it is connected to the providers that pay for
the models that run you.

Most questions here have a **live** answer rather than a written one. Read it
and tell the user — never make them go and look:

```
shipit settings list [--tab NAME]   # every setting, with its current value
shipit settings get  <key>          # one setting in full, in the user's own words
shipit agent roles                  # the roles this install has
shipit agent params                 # the harnesses, models and effort levels it has
shipit service list                 # this project's Compose services
```

This page says what each choice *means* and where its control is. It never says
what anything is set to. `shipit settings get` also prints the description the
dialog shows, which is what lets you name the exact control that is blocking
something instead of saying "check Settings".

**You read settings; you never write them.** There is no `shipit settings set`,
and the write verbs are refused rather than ignored. What you can do is
**propose** one change — `shipit settings propose <key>=<value> --reason "..."`
posts a card in the chat, and the setting moves only when the user presses
Apply. So when a setting is the blocker, name which one, what it is now and what
it has to become, and post the card instead of describing a control to hunt for.

That includes a setting holding prose — the user's own instructions, a role's
standing instructions. The card says a change is proposed and how big it is, and
**Review the change** on it opens the whole diff, so it is still something the
user reads and approves in one click; pass the value with `--value-file -`.

When the user applies or dismisses a card, ShipIt tells you at the start of your
next turn — you never have to ask them what they clicked, and you should not
remind them about a change they have already dealt with. The notice says a card
was resolved; `shipit settings get <key>` is what says the value. Full detail on
both: `/shipit-docs/settings.md`.

## Two dialogs, and where they are

| Dialog | Opened from | Covers |
|---|---|---|
| **Settings** | The gear button in the app header, top right | The whole install — ten tabs, below |
| **Project Settings** | A repository group's menu in the sidebar | One repository — Secrets, Deployments, Appearance |

`shipit settings list` reads both. When the user says "settings" they may mean
either, so check the tab a key belongs to before naming a panel.

Two controls that look like settings and live in the **app header** instead:
the palette button (themes) and the question-mark button (the keyboard-shortcut
list). Neither is in the Settings dialog.

## The ten tabs

These are the words the tab strip shows. The first one is **Model providers**,
not "Services" — that is only its internal id.

| Tab | For |
|---|---|
| **Model providers** | Credentials — the subscriptions and API keys ShipIt bills models to. Also the installed-harness read-out, and the background-work model |
| **Roles** | Named roles the user creates, and the two reviewer candidate slots |
| **Integrations** | GitHub, Linear, SSH hosts, MCP servers, and auto-create-PR |
| **Git** | The name and email on ShipIt's automatic commits |
| **Instructions** | Custom instructions sent with every message, a separate set for Ops sessions, and a switch for ShipIt's own built-in agent context |
| **Skills** | Browse the skill catalogue and install one into a repository |
| **Keyboard** | Rebind shortcuts |
| **Voice** | Dictation and spoken voice notes — providers, keys, language, voice, speed, delivery |
| **Network** | The workspace default for outbound network access, and the host allowlist |
| **Advanced** | Updates and release channel, live steering, PR automations, multi-agent sessions, compacted turns, notifications, the memory budget, and a full reset |

Several of those are covered in depth elsewhere: Skills and MCP servers in
`/shipit-docs/skills.md` and `/shipit-docs/plugins.md`, Voice in
`/shipit-docs/voice-notes.md`, Network in `/shipit-docs/environment.md` and
[sessions.md](sessions.md), and updating ShipIt in
[installing-and-updating.md](installing-and-updating.md).

## Connecting a provider

Everything lives on the **Model providers** tab, and adding a credential is the
only way a provider appears there — the tab starts empty and lists what the user
configured, not a catalogue of what exists.

**Add a model provider** opens a three-step flow: pick the service, pick the
billing mode, supply the credential. Step 1 also shows, beside each service, a
tick / half-circle / dash per **installed** harness saying whether that harness
can run that service at all — so a dead end is visible before a key is pasted
rather than after. Step 2 is skipped when a service has only one mode.

**Subscription or API key** is a real choice, not a detail. The two can offer
different models and they bill differently, so it is made once per credential:

| Mode | Means |
|---|---|
| **Subscription** | A plan the user already pays for. Several can sit on one service in a fallback order — and where the provider publishes a usage figure, they also get meters and cutoffs |
| **API key** | Metered, billed per token. No allowance, so no meters, no order and no failover |

A subscription arrives one of two ways, and some services take both at once:

- **A signed-in account** — ShipIt runs the provider's own login. This is the
  one place ShipIt sends the user out: the provider owns its login screen. The
  challenge renders inside the dialog either way; Anthropic hands back an
  authorization code the user pastes into ShipIt, OpenAI shows a code to type on
  its own page.
- **A supplied secret** — a token or plan key pasted in, handled as an ordinary
  row from then on.

**This is the user's act, and only theirs.** Say which service and which mode
the work needs, then: *Settings → Model providers → Add a model provider*. Do
not narrate the rest of the flow; they are looking at it.

**When a sign-in fails, the reason is usually on that same panel.** A login that
ShipIt runs through a harness CLI — Claude's and Antigravity's — carries a
collapsed **&lt;harness&gt; CLI output** disclosure inside the sign-in box, holding
what the CLI printed and the line that says how the attempt ended. That is the
first thing to ask a user to open, rather than the container logs: the summary
sentence above it is often generic where the CLI's own sentence is not. A login
that runs no CLI shows no disclosure, which is not a fault.

### Several credentials on one service

A subscription mode takes more than one credential, and **their order is the
order ShipIt tries them** — set by dragging the rows. Two controls appear once
there are two:

- **How ShipIt picks between them.** *Use in order* starts new sessions on the
  first credential with quota left — right when the plans differ, a bigger one
  first and a smaller one as backup. *Spread evenly* sends each new session to
  the credential used **longest ago** — right when the plans are equivalent.
  Worth knowing when a user expects it to even out and it does not: it rotates
  by last use, not by how much each has left, so wildly unequal sessions still
  drain unequally.
- **Cutoffs**, as a percentage of a reported quota: a short-window (5h) one and
  a weekly (7d) one. Past its cutoff a credential stops taking *new* work while
  another is below one — and is still used when none is, so nothing is stranded.
  Offered only where the service reports a quota at all.

API keys get neither control, on purpose: they do not fail over, so there is
nothing to order and nothing to spread.

**One exception, and it is the one that generates the bug report.** Signed-in
accounts and pasted secrets on the same service are **two separate pools, not
one**. The routing controls describe the accounts; when the accounts are all
exhausted ShipIt reports that rather than falling through to the token beside
them, and the token's row cannot be dragged into the order. So if a user says
their backup never runs, check whether the "backup" is a different kind of
credential from the one that ran out.

Each row's menu carries **Rename**, and then either **Reconnect** /
**Disconnect** for an account or **Replace secret** / **Remove** for a key. A
connected account's item reads *Reconnect*; one that is not currently usable —
never finished, signed out, refused — reads *Connect*, and one mid-sign-in reads
*Cancel sign-in* instead.

## Harnesses, and why there is no control for them

A harness is the agent CLI that actually runs a turn. Five exist: **Claude
Code**, **Codex**, **OpenCode**, **Grok Build** and **Antigravity**.

**Which of them a given install has is decided when the image is built, and
there is no control in Settings — or anywhere else — that adds one.** The
bottom of the Model providers tab lists them as a read-only statement, with a
mark per harness saying whether it has a model this install can actually run.
`shipit agent params` is the live list. If the user wants one that is not there,
the honest answer is that it is an image change by whoever runs this ShipIt, not
a setting.

That read-out earns its place because **a credential alone cannot run a turn**.
A model becomes usable only when an installed harness can carry it — which is
why a user with a working key can still find nothing to select. The two halves
sit on one screen for exactly that reason.

## Choosing what a session runs on

The controls are in the **composer**, not in Settings: harness, model and
reasoning level, plus a role control once the user has created a role. Below
700px of the **composer's own** width — not the window's — they collapse into
one settings control that drills down to the same set.

Three rules the user asks about:

- **The harness is fixed after the session's first message**, and stays fixed
  for the session's life. Credentials are isolated per harness, so it cannot be
  swapped underneath a running session. The control says so and shows a lock.
- **The model stays switchable** for the session's life, between turns. The menu
  groups models by service, with the billing mode beside each group heading, so
  it always says who is paying. Every control in the row goes inert while a turn
  is running — that is the turn, not a lock.
- **Reasoning levels come from the harness, for that model and billing mode** —
  not from a fixed list. A harness may declare levels and honour none of them on
  a given row, and the menu offers only the ones that survive. Some harnesses
  offer none at all.

To start work on something specific yourself, name a **role** rather than
assembling parameters — see below, and `/shipit-docs/agent.md`.

## Roles

A role is a complete, named unit the user configured once: a harness, a model, a
reasoning level, a description and standing instructions. Starting one costs a
name and nothing else.

**Settings → Roles is the only place a role is created** — *New role* opens an
editor with the name, the description, the standing instructions and the model.
Picking the model re-derives the harness and the level, because a level only
exists on a harness that honours it there. A row in the list is a summary, never
a control: name, what it is for, and what it resolves to.

Two ways a role is used, and you own the second:

- The user picks one in the composer, before the session's first message. The
  control is **absent until at least one role exists** — the reserved reviewer
  does not count — and selecting a role *replaces* the harness, model and level
  controls with the role's name, since those three are what it is made of.
  *Adjust parameters…*, inside the same menu, brings them back. Like the
  harness, the **choice of role locks at the first turn**; a session that took
  its first turn with no role selected loses the control entirely.
- You start one with `shipit agent run --role NAME`, or hand one to a child
  session with `shipit session create --role NAME`. **Read the role's
  description before you write the prompt** — it is what says which role an
  unnamed request means, and how much the brief has to spell out.

`shipit agent roles` is the live list. Never write role names into a doc or an
answer from memory.

A role that cannot run says why, and the three reasons have different remedies —
keep them apart:

| State | Means | Remedy |
|---|---|---|
| **Needs fixing** | Something it names no longer exists | The user edits the role |
| **Provider disconnected** | Its provider has no usable credential | Reconnect it under Model providers. The role itself is fine |
| **Quota spent** | Its subscription is exhausted | Nothing to fix; it recovers at the reset |

### The reviewer

**`reviewer` is reserved.** It exists on every install, cannot be renamed or
deleted, and is never offered in the composer's role list — it resolves per run
against whatever produced the work, so a session the user starts by hand gives
that rule nothing to measure.

Its section in Settings → Roles is two ranked **candidate slots** rather than
one pinned model. Each slot is either **Auto-configured** — following this
install, improving on its own as providers are added — or **Pinned** to a model,
with *Reset to auto* as the way back. Pinning is atomic: editing either control
pins the whole resolved tuple.

**ShipIt picks between the two per review**, taking whichever is furthest from
the model that wrote the work and preferring a different model family above
everything else. The harness is derived per review too, preferring one the
reviewed session is not on. That is why `--role reviewer` alone is the whole
answer when you ask for a review: which model reviews is ShipIt's decision, made
from settings the user owns. Only relay a reviewer the user named themselves —
and say that doing so sets the distance guarantee aside.

The reviewer's description and standing instructions are ordinary role metadata
and are edited like any other role's.

**Every review is brokered, so it needs the sub-agent setting on** — Settings →
Advanced, *"Allow spawning another agent for a sub-task"*
(`advanced.enableSubAgents`). With it off there is no review: `/review` and
*Ask agent to review* refuse in the UI and name that row to turn on, and
`shipit agent run --role reviewer` refuses the same way. Nothing substitutes for
it — a review written by the model that wrote the work is not a second opinion,
so when the brokered run cannot happen, tell the user why instead of reviewing
it yourself.

## SSH hosts

Settings → Integrations → **SSH hosts** is a list of remote servers a session can
reach over SSH. It is account-wide, not per repository, and it is deliberately
not a repository secret: a secret resolves into a Compose service, and you edit
the Compose file.

The user adds a destination with a name, an address (a hostname or an IP), a
user and a port. ShipIt then generates a key **for that destination alone** and
shows the `authorized_keys` line to install on the server. It holds the private
half and never lets it into a session container — not through a settings read,
not through a Compose service, not on any mounted path. When `ssh` needs a
signature, ShipIt signs, and only for a connection that really reached the server
whose host key it recorded, as that destination's configured user.

Adding a destination grants nothing. **The grant is per session**, in that
session's own settings (the session menu → Session settings → SSH destinations),
and any session kind can hold one — repo-backed, sandbox or ops. Granting one
writes `~/.ssh/config` for that session and opens its egress to that address;
revoking removes both, though a connection already authenticated runs until it
closes.

A destination can be changed after it is added: **Edit** on its row reopens the
same four fields, and saving keeps the destination itself — its key, and the
grant on every session that holds it. That is what it is for; deleting and
re-adding makes a different destination, with a new key to install and no
grants. Use it when a destination was entered wrongly, or when its address has
to change — a Tailscale peer added by its MagicDNS name is the standing case,
since that name resolves neither inside a session nor from ShipIt's own host-key
check, and the fix is to put the peer's tailnet IP in instead. Changing the
address or the port makes ShipIt forget the host key it recorded for the old
endpoint; the row's edit form says so, and the next connection verifies the
server again and posts a fresh fingerprint card.

The first connection records the server's host key and posts its fingerprint as a
card in the chat, for the user to compare with the server. ShipIt records it only
after seeing that same key at the destination's own address itself, so a first
connection can be refused even when the session did everything right — a wrong
address or port, a server that is down, or a firewall between ShipIt and the host
all end in a card saying ShipIt could not observe that key there, and nothing is
recorded. If a recorded key later changes, ShipIt refuses and says so; the user
clears the recorded key with **Forget** on the destination's row.

Your side of this is in `/shipit-docs/ssh.md`: `~/.ssh/config` is the list of
what this session has, and `ssh <alias> '<command>'` is how you use it. A
settings read answers for the **granted** destinations and no others —
`shipit settings get integrations.sshHosts` names them, and
`integrations.sshHosts[].address`, `[].user` and `[].port` say where one points.
An empty answer means this session is granted none, not that the user has
registered none, and the rest of the registry is not readable from a session at
all. So a question about a destination this session does not hold is one to put
to the user, naming the panel: Settings → Integrations → SSH hosts.

## Background work

**Background work**, on the Model providers tab, pins the model ShipIt uses for
its own jobs — naming a session, writing a pull-request description. It is a
model choice like any other; the harness is derived and shown as a fact, and
some of this work runs as a direct provider call with no harness and no
container at all.

**Its list is not the composer's list, in both directions.** A provider with no
installed harness still appears here, because a direct call needs none. And a
harness with no measured way to run one-shot with its tools switched off is
excluded here while remaining perfectly usable for a turn. So do not answer
"anything you can chat with" — if a model the user expects is missing from one
list or the other, that asymmetry is why.

## Usage and subscription limits

**In the app header**, a pill per subscription credential ShipIt has something
to report about, with up to two meters: a short **5h** window and a **7d**
window — whichever the plan actually has. A pill also carries a thin marker
showing how far through the window the clock is, so a number can be read against
its own pace.

What the meters say when they have no figure, and the three are different:

| Reads | Means |
|---|---|
| `5h 62%` | A live figure. Dimmed once it is more than ~15 minutes old |
| `5h · reset` | The window rolled over; the cached number is meaningless |
| `5h · —` | The provider has not reported one — asking again may fill it |

**A missing pill is not a broken one.** Three credentials correctly have none: a
plan whose provider publishes no usage figure at all, a pasted subscription
token that has not yet produced a reading (a signed-in account gets its pill
straight away and fills it later), and any API key — there is no allowance to
meter. ShipIt would rather show nothing than blanks that will never fill.

Where a service supports an on-demand refresh, a button sits beside the meters.
Not all do: a provider that pushes its numbers rather than answering a query has
no button. The ones that can be asked allow only a handful of calls per half
hour, so the button disables itself with a countdown rather than re-tripping the
limit.

When a credential **cannot authenticate**, its pill replaces the meters with a
warning word — pressing it opens Settings → Model providers, where *Reconnect*
or *Replace secret* is.

On a narrow window the whole status group collapses into a gauge button that
opens the same pills in a popover, and opening it refreshes them.

**Usage Summary** is the other half, opened from the cost line in the composer's
**context dial**: this session and all sessions, spend split per provider,
context window, token totals, every turn listed newest first, and a weekly trend
chart that toggles between metered spend, spend at API rates, and tokens. The
dial's own popover — before you open the dialog — carries the context bar and a
*Largest turns* top three.

## Themes

**The theme picker is not in Settings.** It is the palette button in the app
header, beside the gear.

**Twenty themes ship** — nine light, eleven dark — each a named pair of a label
and a one-line description, chosen from a two-column grid. Several are tuned to
a harness's own look (Claude, Codex, OpenCode, Grok, Antigravity), and there is
a High Contrast one.

The choice is **saved in the browser**, so it does not follow the user to
another device. On a browser that has never had one, ShipIt picks a light or
dark default **once**, from the operating system's preference at that moment,
and saves it — it does not keep tracking the OS afterwards, so a user who later
switches their system to dark mode and expects ShipIt to follow has to pick a
theme. It is not a declared setting either, so `shipit settings` does not list
it at all and you cannot tell which theme anyone is on.

## Keyboard shortcuts

**Settings → Keyboard**, grouped as General, Sessions, Chat, Search and Voice.
The user presses *Change* on a row and then presses the keys they want; a row
that has been changed grows a reset arrow back to its default.

**Six bindings are rebindable and four are fixed.** The fixed ones are editor
keys — Enter to send, Shift+Enter for a newline, Ctrl+F to search the chat while
the composer or the transcript is focused, Esc to close an overlay — shown for
reference with no control. Everywhere else, and in the transcript until the user
clicks in it, Ctrl+F stays the browser's own find-in-page. Rebindable ones cover showing the shortcut list, starting a new
session, quick capture, the "needs you" view, and the two dictation modes.

Two rules the dialog enforces: a chord needs Ctrl/Cmd plus a key, and one that
fires **while the user is typing** — quick capture, the mic — needs a second
modifier as well, so a stray keypress mid-sentence cannot trigger it. A chord
another *rebindable* command already uses is flagged as a conflict — the fixed
four are not in that check, so nothing stops a user binding a command to Ctrl+F
and then wondering why chat search stopped behaving.

Like the theme, these are **saved per browser** and ShipIt's server never holds
them. The header's question-mark button shows the current list, whatever it has
been rebound to, with an *Edit* button that jumps straight to this tab.

## What you can and cannot read

`shipit settings list` marks every entry it cannot answer plainly, and each mark
means something different. Report the mark; never substitute a default you
assume:

| Reads | Means |
|---|---|
| `configured` / `not configured` | Credential material. You learn whether it is set, never the value |
| `unreadable (browser_local)` | Lives in the user's browser — keybindings, voice preferences, compacted turns, the notification and sound toggles. ShipIt's server does not hold it |
| `unreadable (no_repository)` | A per-repository setting, read from a session that binds no repository |
| `unreadable (read_failed)` | ShipIt tried and does not know. Say so |

A saved value is also not always the live one: `list` flags anything that is
`restart-dependent`, `excluded` for this session, or `uncertain`. A session
whose container started with open networking keeps it until the container
restarts — telling that user "saved, it will work" would be a false promise.

## Who does what

| The user does | You do |
|---|---|
| Signs in to a provider, or pastes a key | Say which service and mode the work needs, and why |
| Orders credentials, sets the selection mode and the cutoffs | Read them and explain what a choice means |
| Creates roles and configures the reviewer slots | Run `--role NAME`; read a role's description before writing its prompt |
| Picks the harness, model, level or role for a session | Say what the work needs; mention the harness locks at the first message |
| Picks a theme and rebinds shortcuts | Name the control — the palette button, Settings → Keyboard — and stop |
| Adds an SSH destination and installs its public line on the server | Say the destination is needed and what it is for; use it once granted |
| Corrects a destination's name, address, user or port with **Edit** on its row | Say which field is wrong and what it should be; the grant survives, so nothing is re-granted |
| Grants a destination to a session, in Session settings | Read `~/.ssh/config` to see what this session has, and say when nothing is granted |
| Changes any setting | Read it, name it, say what it has to become. Never write it |
