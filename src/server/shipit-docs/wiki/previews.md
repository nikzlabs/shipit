# Previews

The preview is the user's own app, running, beside the conversation that is
building it. Most "why can't I see it" questions are one of the states at the
bottom of this page, and almost all of them are yours to fix rather than theirs.

When a step here is something **you** can do, do it — write the compose file,
start the service, read the log. When it is a control in the pane, name the
control and stop.

## What a preview actually is

Not a sandbox and not a screenshot service. Each session runs **its own instance
of the whole stack**: the project's Compose services as real Docker containers,
next to the session's agent container, started for that session alone. Six
sessions on one repository means six dev servers and six databases, which is
what makes six parallel agents safe.

Three consequences worth stating when they come up:

- **The pane shows one service at a time.** A stack can declare many; the
  toolbar's first control picks which one is on screen.
- **Each preview is served at an origin of its own** — `{session}--{port}` as a
  subdomain of the host ShipIt is reached on — so the app sits at the root of
  that origin and absolute paths like `/assets/app.js` resolve normally. This is
  also why a raw-IP host has no preview at all; see the blank-preview list.
- **It is private to this ShipIt.** It is not a deployment and not a public URL.
  A user asking to show the app to someone else is asking about deploys
  (`/shipit-docs/deployment.md`), not about this.

Edits hot-reload; nothing has to be restarted for a source change. Switching to
another tab does not reload the preview either — its document stays mounted
behind the other tabs, so coming back is instant rather than a fresh load.

## Which sessions have a preview at all

The **Preview** tab is in the right-hand panel of an ordinary repository-backed
session. It is **absent**, not empty, in three cases, and saying so is better
than sending the user looking:

| Where | What is there instead |
|---|---|
| An Ops session | A **Host** tab. Ops sessions have no Preview tab |
| A sandbox session | No Preview tab; the panel opens on Files |
| A ShipIt running in local mode | No Preview tab and no Terminal tab |

On a phone there is no side-by-side: the panel is the **Workspace** tab in the
bottom bar, and it swaps with Chat rather than sitting next to it.

## What the project has to declare — and that part is yours

A session has services because the repository declares them, in two files:

- **`docker-compose.yml`** (any path) — the services themselves.
- **`shipit.yaml`** — a `compose:` key naming that file.

**ShipIt does not go looking for a compose file.** A `docker-compose.yml` that
`shipit.yaml` does not name is never read, and the session simply has no
services. So "there's a docker-compose.yml, why is there no preview" has a real
answer, and adding the `compose:` key is your job, not something to explain.

When a project declares nothing, the pane shows an invitation — *"Your app can
run here"*, with an **Ask the agent to set it up** button that sends you a
message. Do not wait for that button. If the user asks for a preview, write the
two files; `/shipit-docs/compose.md` is the full reference. The two mistakes
that most often stop a first preview working are a server bound to `127.0.0.1`
instead of `0.0.0.0`, which the proxy cannot reach, and a dependency install
duplicated into a service's `command` when it already lives in `agent.install`
(Python is the documented exception — its preview service owns its own install).

### `auto` and `manual`, in the user's terms

Every service is one or the other, and the drawer badges it:

| Mode | Badge | Behaviour |
|---|---|---|
| `auto` | **Preview** | Starts by itself when the session starts, and can be shown in the pane. The default for a service that declares `ports` |
| `manual` | **Manual** | Starts only when asked. The default for a service with no `ports` |

An `auto` service also **waits for `agent.install` to finish** before its first
start, unless it opts out. So a service that has not come up yet while
dependencies are still installing is behaving correctly, not stalling — and if
the install *fails*, the service is marked crashed with the real cause,
`agent.install failed — dependent service not started`, rather than a misleading
downstream symptom.

A service is `manual` because it is not needed on every boot — a database, a
cache, a queue worker, an emulator — **not** because starting it is a decision
for the user. When the work needs one, start it yourself:

```bash
shipit service list
shipit service start db
shipit service logs db --lines 200
```

Never answer "click Start in the Services drawer". A first start may pull a
large image and take minutes; a `start` that times out is still running, so
re-check with `list` rather than starting again.

## The controls in the pane

Each of these appears under a condition. The condition is part of the answer.

| Control | When it is there | Does |
|---|---|---|
| Service picker (dot + name) | Only when more than one service or port is available; otherwise a plain dot and label | Chooses which service the pane shows |
| Device selector | While the preview is running | Phone and tablet viewports — see below |
| Rotate | Only while a device viewport is chosen | Portrait ↔ landscape; on a freeform size it swaps width and height |
| Home | While the preview is running | Back to the app's root |
| Address bar | Once the page has reported its location | The path and query the preview is on — never the generated host, which says nothing. Clicking it copies the full absolute URL |
| Back | Always; disabled when the page has nowhere to go back to | Steps the preview's own history, never ShipIt's |
| Refresh | Always | Reloads the preview |
| Open in a new tab | Always; disabled until there is a URL | The preview origin in a browser tab |
| Errors, with a count | Only when the page has produced errors | Opens the error panel |
| Auto-fix switch | Always | See "Errors", below |

The pane also remembers where it was. The path the user was last on is restored
when the frame is rebuilt — after a reload, after switching sessions and back —
so they do not land back on the app's front page each time.

You can also send the user straight to a place in their app from chat, with a
`shipit-preview://` link — ShipIt opens the Preview on that path and **starts
the service first if it is stopped**. `/shipit-docs/chat-links.md` has the form.

## Phone and tablet viewports — the user's control

This one is theirs. The device selector is in the preview toolbar, and offers:

- **Responsive** — the default; the app fills the pane.
- **Six presets** — four phones and two tablets, each listed with its size.
- **Freeform** — a typed width × height, from 100 to 2560 px, or dragging the
  edges and corner of the surface. Dragging a preset's edge turns it into a
  freeform size.

A viewport larger than the pane is scaled to fit, and the toolbar shows the
dimensions with that percentage beside them. The choice is remembered per
session, in that browser.

Your own equivalent is not this control: to check a layout at a phone width
yourself, resize your browser (`browser_resize`) and take a snapshot. Do that
after any responsive change rather than asking the user to go and look.

## The Services drawer

Along the bottom of the Preview tab, when the project declares at least one
service. It opens itself when nothing is running — that is the moment it is
worth seeing — and stays where the user puts it after that. The header reads
"N of M running"; the drawer can be dragged taller.

What is on it, and when:

- **Start** on a service that is stopped or crashed; **Stop** on one that is
  running or starting; **Restart** on one that is running.
- **Logs** — a live log view. With one service it is in the card; with several,
  the terminal icon on a row drills into that service.
- **Send to Agent** — sends you the tail of that service's log as a message.
- **Open in a new tab** — on a running service that has a port.
- **Start all / Stop all / Restart all** — only when there is more than one
  service.
- A crashed service shows its error in place with **Ask the agent to fix →**,
  which also comes to you as a message. A container killed for running out of
  memory is badged **OOM**.

Clicking a running service's name or its `:port` puts it in the preview pane.

Everything in that list you can also do, and usually should:
`shipit service list`, `start`, `stop`, `restart`, `logs`. For what this project
declares and whether it is up right now, run `shipit service list` — it is never
written down anywhere, because it changes.

## Errors

The preview captures the page's own **uncaught errors** and its
**`console.error` and `console.warn`** output. They collect behind the Errors
button in the toolbar, with a count. The panel offers **Send to Agent** for all
of them and **Fix** on a single one; both arrive as a message to you.

**Auto-fix** is the switch beside it, and it is **off** until the user turns it
on. While it is on, a new error is sent to you automatically. It counts repeats
of the same error and gives up after three rounds, turning itself off — so a
user who says "it stopped trying" is describing the designed behaviour, and the
next step is a real diagnosis rather than a fourth identical round.

Three other failures surface in their own place, not in that panel:

- **The stack would not come up** — a Docker Compose error fills the pane, with
  the raw message, a hint for the common causes (a port already in use, no disk
  space, a network-pool exhaustion, an image that could not be pulled), and a
  **Send to agent** button.
- **A service crashed** — its row in the drawer says *Crashed* and carries the
  stderr.
- **Missing secrets** — a warning row above the preview when the compose file
  declares a required secret with no value, with a **Configure** button that
  opens Project Settings → Secrets for that repository. Only the user can enter
  the values. (Project Settings is also on the repository's overflow menu in the
  sidebar.) See `/shipit-docs/secrets.md` for declaring them.

## "Why is the preview blank?"

Work down this list in order. The first eight are states ShipIt is reporting
about itself and each says so in the pane; only the last two are the app.

1. **There is no Preview tab.** An Ops session, a sandbox session, or local
   mode. Nothing is broken — see the table above.
2. **The repository is not trusted yet.** A fresh remote is untrusted until the
   user accepts it once: ShipIt clones it and lets them read everything, but
   runs none of its declared commands, so install and `auto` services do not
   start. The preview shows the consent card with **Trust this repository**.
   Messages to you are blocked too, so the same consent also appears above the
   composer. It is one-time and per-repository; only the user can give it.
3. **The session is still starting.** The pane lists the startup steps —
   fetching changes, installing dependencies, starting the dev server — with
   timings and live log lines. Read them before calling anything broken.
4. **The project declares no services.** The *"Your app can run here"* invite.
   Write the compose file.
5. **The stack failed to come up.** The Docker Compose error card, above.
6. **The service the pane is parked on is not running.** The preview remembers
   its service by name and waits for it rather than jumping to something else,
   so this survives a restart. Start it: `shipit service start <name>`.
7. **The host cannot carry preview subdomains.** Previews need a hostname with
   wildcard DNS, and a raw IP address cannot have one — you cannot make
   `{session}--3000.192.168.1.5` resolve. When ShipIt itself is open on an IP
   literal, the client refuses to build a preview URL at all and says so in the
   pane — naming a host that would work, where it can suggest one. `localhost`
   and loopback addresses are fine. The fix is the address ShipIt itself is
   opened on — a domain with a `*` record, or Tailscale with MagicDNS — and
   nothing in the project changes it.
   [installing-and-updating.md](installing-and-updating.md) covers the access
   options.
8. **A reverse proxy in front of ShipIt is asking the preview origin to
   authenticate.** The pane says so and offers **Open in new tab**, which is
   where that proxy's login can happen; once per session.
9. **The dev server is not listening yet.** The frame shows ShipIt's own
   connecting page, which retries by itself and loads the app the moment it
   answers. After about thirty seconds it adds the last connection error. If it
   never clears, the usual cause is a server bound to `127.0.0.1` instead of
   `0.0.0.0`, so the proxy cannot reach it.
10. **The app is serving a blank page.** Now it is ordinary debugging — and it
    is yours. Check the Errors panel, read `shipit service logs <name>`, and
    open the service's own container URL from `shipit service list` in your
    browser. Do not use the `{session}--{port}` origin for that: it is the
    user's pane, and it does not resolve from inside your container.

## When nobody is watching

A preview does not stop just because the session went idle — ShipIt keeps idle
previews running while it is inside its memory budget, and when it must reclaim,
a session gives up its agent container first and its preview only if that was
not enough. **Keep preview running**, on the session's overflow menu, is the
stronger promise: that session is exempt from reclaim. Both are covered in
[sessions.md](sessions.md), along with what else idle reclaim takes.

One thing that never survives: a server started by hand in the terminal. It is
not a Compose service, so nothing restarts it and nothing keeps it. Long-running
processes belong in `docker-compose.yml`; one-time setup belongs in
`agent.install`.

## Who does what

| The user does | You do |
|---|---|
| Picks the device viewport, and rotates or resizes it | Check your own layouts with `browser_resize` and a snapshot |
| Trusts the repository, once | Say plainly that it is blocking install and the preview |
| Enters secret values in Project Settings → Secrets | Declare which ones the services need |
| Turns Auto-fix on, or off | Fix the errors |
| Chooses which service is on screen | Write the compose file, start the services, read the logs |
