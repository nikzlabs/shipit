# When something is broken

Organised by the sentence the **user** says, not by the subsystem at fault. Find
their sentence, read what it usually means, run the checks that are yours, and
name the one control that is theirs.

Three habits before any entry below.

**ShipIt names its own faults.** Nearly every failure here has a banner, an
overlay or a card that carries the real cause in its own text. Ask the user what
the screen says before you theorise — "Container creation failed", "Commits are
blocked", "Egress blocked", "No checks" each point at exactly one entry here.

**Most of the checking is yours.** `shipit service list`, `shipit service logs`,
`gh run view --log-failed`, reading the repo — do those, then report. Hand over
only the click the user alone can make.

**Nothing on this page is a current value.** What a setting is set to,
which services are up, which roles exist: `shipit settings list`,
`shipit service list`, `shipit agent roles`.

Session mechanics — the health strip, idle reclaim, archiving, pins — are in
[sessions.md](sessions.md). This page routes to it rather than restating it.

## "The preview is blank" / "it won't load"

The preview panel replaces the app with an overlay that states which of these it
is. Ask which one, or look at the panel yourself after starting a service. Only
one overlay shows at a time, roughly in this order — a Compose error or a
missing preview configuration suppresses the startup steps above them:

| What they see | What it is | What you do |
|---|---|---|
| A list of startup steps — *Fetching latest changes*, *Installing dependencies*, *Starting dev server* — one with an orange mark | A startup step failed. The failing step prints its message and the tail of its log right there | Read the log lines, fix the cause (usually `agent.install` in `shipit.yaml` or a broken lockfile), and start the service again |
| **Docker Compose error**, with the raw error in a box | Usually the stack failing to come up, but the same overlay carries configuration problems ShipIt found in `shipit.yaml`/`docker-compose.yml` before anything started. For four causes the panel adds a plain-language hint: Docker out of network address space, a port already allocated, no disk space left, an image that could not be pulled | Read the raw error, not the headline. The port, image and configuration causes are yours — fix `docker-compose.yml` or `shipit.yaml`. The address-space and disk ones are on the **host**, outside every session; say so rather than trying |
| **Your app can run here** — an invitation to set up a preview | The project declares no preview at all | If the repo really is a web or Android app, write the `docker-compose.yml` (`/shipit-docs/compose.md`). If it is a library or a CLI, say so — "no" is a correct answer here |
| **`<service>` is not running**, or *Waiting for `<service>`…* | The pane is parked on a named Compose service that is stopped or still starting. It stays parked deliberately and returns by itself | `shipit service start <name>`. If it will not stay up, see "a service won't start" below |
| **No preview running. Start a service to launch it.** | Every declared service is `x-shipit-preview: manual`, so nothing started on its own | Start the one the task needs — that decision is yours, not the user's |
| **Preview not available over this host** | The user is reaching ShipIt on a hostname that cannot carry wildcard subdomains. Previews are served at `{session}--{port}.<host>` | Theirs: open ShipIt over `localhost`, a domain with a `*` DNS record, or Tailscale with MagicDNS. The overlay suggests a working host for their case when it can. Detail in [installing-and-updating.md](installing-and-updating.md) |
| **Preview authentication required** | A guess, not a diagnosis: the page never reported back within the retry window, and ShipIt's best explanation is a reverse proxy demanding its own auth for preview subdomains. A page that simply failed to load produces the same overlay | Theirs: **Open in new tab** on the overlay, authenticate once, then **Retry**. If that tab shows no login either, treat it as a failure to load and check the service's logs |
| A **required secrets** row across the top of the panel | The project declares secrets marked required and they have no value | Theirs: **Configure** on that row opens the project's Secrets. You can say exactly which names are missing; you cannot supply them |

**This repository is not trusted yet** is a separate overlay drawn over the
whole frame rather than one of the states above, so it wins regardless of what
the stack is doing. It is covered below.

If the app itself is loading but throwing, that is the **error panel** at the
bottom of the preview: runtime errors and `console.error`/`warn` from the page.
It starts **closed** — the preview toolbar shows an error count that opens it,
and only then do **Send to Agent** (on the group) and **Fix** (on one) exist. So
a user reporting "there's a red number up there" has errors ShipIt is holding
but has not sent you. Ask them to open it and send, or ask what it says. When
they arrive they come as a normal message — treat them as a bug report with a
stack trace.

## "The agent is stuck" / "it's not responding"

Separate three states before doing anything, because the fix differs:

- **A turn is genuinely running.** The session row shows a pulsing green dot.
  The user's control is the **stop button in the composer** ("Stop the agent"),
  which ends the turn and the background tasks inside the agent process.
- **A turn is running and more messages are waiting.** The composer shows *"N
  messages queued"* with a cancel on each and on all. Nothing is wrong; the
  queue drains in order.
- **Nothing is running and nothing is happening.** This is the real case. Go to
  the health strip.

The **health strip at the top of the Terminal tab** is the whole answer for a
wedged session, and it summarises itself: *Agent running* / *Idle* / *Events
stale* / *Agent state out of sync* / *Worker unreachable* / *Container
\<state\>*. Read it and say what it shows before anyone restarts anything. Its
controls, in increasing order of violence — **Diagnostics**, **Kill agent**,
**Restart agent**, **Rescue session** — are covered in
[sessions.md](sessions.md). All four are always on the strip, but **Kill agent**
is greyed out unless the worker is reachable *and* reports an agent actually
running, and all of them grey out while a restart is in progress. A greyed
**Kill agent** on an apparently busy session is itself a finding: it means the
worker is not answering, so say that rather than waiting for the button.

A restart that fixes nothing twice is worth a bug report, not a third: the
**Diagnostics** panel has a copy button that yields the whole payload as JSON,
which is what `/shipit-docs/bug-filing.md` wants.

## "It says connection lost" / "the chat box is greyed out"

A pill appears in the header (under it on a phone) for the websocket:
*Reconnecting to server...*, or *Connection lost* with a **Reconnect now**
button — **Reconnect** on a phone — and a green *Reconnected* flash when it
comes back. It waits about a second and a half before announcing a disconnect,
so a blink shows nothing.

The pill only ever appears after the socket has connected successfully at least
once. A page that never connected at all shows no pill and no reconnect button,
which is a different problem: ShipIt itself is unreachable from that browser.
See [installing-and-updating.md](installing-and-updating.md) for access.

Once it has connected, this is transport only. It never stops the server, the
agent, the container or the commit — a turn running when the browser dropped
keeps running, and the transcript is replayed on reconnect. Say that plainly;
users assume they lost the work.

"Greyed out" is two different states, and only the first actually disables the
text box:

| What they see | Cause | Whose move |
|---|---|---|
| The box is inert and reads *Add a model provider to start chatting* | The install has no provider it can run a turn with | Theirs — **Settings → Model providers**, then **Add a model provider** |
| They can type, but the send button will not go | The websocket is not open, or the repository is untrusted (below), or an attachment is still uploading or has failed | Wait, **Reconnect now** on the pill, trust the repo, or drop the failed attachment |

That distinction matters when a user says "I typed it and nothing happened" —
their text is still there, and it is the send that was refused, not the typing.

## "It won't respond on this repo" / "nothing runs after I added it"

A freshly added remote is **untrusted**. ShipIt clones it, renders files and
diffs, and refuses everything that would execute the repo's own code: agent
turns, `agent.install`, and every Compose `command:`/`build:`. The user can
read; nothing runs.

Two surfaces offer the same one-time consent, and both say **Trust this
repository**: a card above the composer, and the Preview tab's empty state where
that tab exists. It is remembered per repository, so it is asked once, not once
per session. Repos created from a ShipIt template never reach this state.

This is a security consent, not a chore — do not talk the user out of reading
the repo first.

## "The turn just failed" / "it says I'm out of usage"

A failed turn lands in the transcript as a message beginning **`Error:`** with
the provider's own text. Three shapes:

- **A usage or quota limit.** ShipIt recognises the provider's exhaustion
  notice, records when that account's window resets, and — where the session's
  routing allows it — moves to the next configured account rather than showing
  an error at all. Several accounts per provider, in a fallback order, live in
  **Settings → Model providers**. What the install actually has is
  `shipit agent params` and `shipit agent roles`; never quote a limit from
  memory.
- **A credential that stopped working.** The account's row in **Settings →
  Model providers** says *reconnect needed*, or *credential rejected* for a
  pasted key. The recovery is in that row's own overflow menu, not a button on
  the row, and it is labelled for the state it is in: **Connect** for an
  account that is not working, **Reconnect** for one that is (a deliberate
  re-login), and **Replace secret** for a pasted credential. Name the menu, the
  row and the item; the sign-in itself is theirs.
- **Anything else** — the error text is the provider's. Read it before
  retrying.

Background work ShipIt does *outside* a turn — naming the session, writing a
pull-request description — fails quietly instead, as a **notice** card saying
what it fell back to (for instance, the session kept its placeholder title). It
is not an alert and nothing is broken; dismissing it collapses it to one muted
line rather than deleting it, so a repeating failure stays visible.

## "It stopped committing my work"

**Commits are blocked — a likely secret in your changes.** A credential-shaped
line in the working tree refuses the auto-commit, and the banner above the
composer stays up until the condition is false. It lists each finding by file,
line and rule. This is not one turn: nothing commits or pushes afterwards
either, including later, unrelated work.

Yours to fix, and you should: move the value to an environment variable or a
ShipIt secret (`/shipit-docs/secrets.md`). If it is genuinely a false positive,
a `gitleaks:allow` comment on that line clears it. The next turn then commits
everything that piled up at once.

For what happens to uncommitted work when a session is reclaimed or archived —
the short answer is that ShipIt refuses to reclaim a checkout it cannot confirm
is on the remote — see [sessions.md](sessions.md).

## "The branch won't push" / "it says my branch diverged"

**Branch is behind `<base>`. Update to resolve.** — the auto-push was rejected
as non-fast-forward, which means **this session's branch and its own remote ref
have diverged**: the remote carries commits the local branch does not. A base
branch merely moving ahead does not do this on its own, so do not diagnose it as
that. ShipIt measures which side carries what before it says anything, and
**withholds the button entirely** when the force-push behind it could discard
commits that exist only on the remote — so a divergence with no button offered
is the dangerous shape, and worth saying so.

The **Update branch** button rebases onto the repository's real default branch
(a `master` repo is never told it is behind `main`). Conflicts during that
rebase are listed by path, with **Abort rebase**, and can be handed to you to
resolve in the session rather than locally.

Two neighbouring causes that look the same:

- **No git identity.** ShipIt asks for one through the GitHub connection;
  **Settings → Git** holds it.
- **A GitHub token that expired.** See the next entry — the same token pushes
  and opens pull requests.

Never reach for `git rebase` or `git reset --hard` on a published branch to
"catch up". The sanctioned moves are in `/shipit-docs/github.md`.

## "The pull request won't open"

The PR card in the conversation shows **Failed to create PR** with GitHub's own
message, and a **Retry**. When the cause is authentication it adds *"Your GitHub
token is missing or expired — reconnect to keep pushing"* and a **Sign in to
GitHub** button that opens **Settings → Integrations**. That reconnection is
theirs; the retry is yours, and it is greyed out while a turn is running.

A different shape has no card at all: your own `gh pr create` prints an existing
PR's URL and exits 0. That is the command, not the card, and its **stderr** is
the part that matters — it names the PR's state. A merged or closed PR being
reprinted means the branch has nowhere to put new work and it is **not**
shipped; the branch's tree simply matching the base means there is genuinely
nothing new to open one for. `/shipit-docs/github.md` has the branch shapes and
which one needs `shipit branch reset-to-base`.

**GitHub API rate-limited** is a different thing entirely — a bar across the top
counting down to the reset, saying PR and CI status updates are paused. Nothing
is broken and nothing needs doing; the polling resumes itself.

## "CI is failing and it won't say why"

The PR card's CI chip is the first read, and each state means something
different:

- **CI n/m** in red — checks failed. The card lists the failing checks by name
  with a one-line summary under them (capped, with "and N more") — **except
  while auto-fix is running**, which hides the list. A red chip with no
  explanation under it usually means auto-fix already has it.
- **No checks** in grey — ShipIt has stopped expecting any. Usually no workflow
  matched the pull-request event, but it also appears when checks were expected
  and none arrived before ShipIt's grace window closed. So report it as an
  observed absence, not as proof: check the repo's `.github/workflows/`
  triggers, and if a workflow *should* match, look at GitHub's own run list
  (`gh run list -b <branch>`) before telling the user nothing will come.
- A spinner with no counts — the checks have not started yet.

The summaries are short by design. The detail is yours to fetch:
`gh run view --log-failed` gives the failed jobs' logs, and `gh run rerun
--failed` re-runs only what failed when the cause was infrastructural rather
than the code. Full rules, including what re-run refuses and why, are in
`/shipit-docs/github.md`.

ShipIt can also drive a fix itself when the install has auto-fix on: the session
row shows a wrench while it runs. Whether it is on is
`shipit settings list`, not a fact for this page.

## "The container keeps dying" / "it restarted itself"

Three distinct causes, each with its own banner:

**Session disabled — agent container OOM-killed N times.** A circuit breaker:
the orchestrator stopped recreating a container that keeps being killed for
memory. **Rescue session** on the health strip resets the breaker and retries —
that click is theirs. The banner's own advice to raise `agent.memory` in
`shipit.yaml` is stale: that field was removed and is ignored with a warning.
Session memory is now sized automatically from host capacity, and the only
overrides are the deployment env vars `DEFAULT_SESSION_MEMORY_MB` and
`MAX_SESSION_MEMORY_MB` — a host-level change, covered in
[installing-and-updating.md](installing-and-updating.md).

**Container creation failed**, with Docker's stderr under it, on the health
strip. Read the error; it is usually the host — disk, image, or network space.

**Update available for this session.** Not a failure at all: the session's agent
container predates the running ShipIt build. **Restart agent** on that banner
recreates just the agent container and leaves the Compose stack up. While a turn
is running the button is **disabled** and reads *Restart after turn* — that is a
label, not a promise: nothing is queued, and someone has to press it once the
turn ends.

A container that has simply *stopped* is not automatically one of these. It may
be idle reclaim, which is normal and explained in [sessions.md](sessions.md), or
it may have exited on its own. The health strip's **Diagnostics** carries the
exit code; read it before calling it either.

## "Everything's getting slow" / "my sessions keep stopping"

**Docker memory: X / Y (n%)** across the top of the app, amber or red. It
measures every running container on the host, not only ShipIt's, and it says
whether Y is a memory **budget** or the whole machine — the two call for
different reactions, and "80% of the machine" is a milder fact than "at the
budget you set". Above the threshold ShipIt reclaims idle containers,
longest-idle first.

Two details worth having straight. The word *budget* does not mean the user
chose one — some installs get an automatic budget without anyone configuring it,
so do not tell them to go and look at a value they never set; `shipit settings
list` is the live answer. And the banner is not always amber first: against a
budget it appears at the same level that renders it red, so a red bar is not
necessarily a situation that was ignored while amber.

The banner still fires before reclaim starts, deliberately, so the user gets to
choose what goes. Theirs: close or archive inactive sessions; the budget itself
is in **Settings → Advanced**. What reclaim takes, in what order, and which
exemptions hold is [sessions.md](sessions.md) — answer from there, because users
conflate the memory ladder with the disk one constantly.

## "It can't download anything" / "it can't reach the internet"

In **Contained** mode a session reaches only an allowlist — the model API, the
git host, package registries, connected MCP servers, and hosts the user added.
When something else is wanted, an **Egress blocked** card appears in the
conversation naming the exact host, with **Allow once**, **Add to allowlist**
and **Deny**. That decision is theirs and takes one click; say which host and
why you need it, and stop.

The per-session choice is **Session settings** on the session's menu; the
workspace default is **Settings → Network**. Both are covered in
[sessions.md](sessions.md), and the agent-side view is
`/shipit-docs/environment.md`.

**A blocked host usually arrives as a DNS failure, not as a refused
connection**, and the message names the wrong resolver. A contained session's
DNS is redirected to ShipIt's own resolver inside the session's network
namespace, which forwards only allowlisted domains and answers everything else
REFUSED — so a Go program prints `lookup api.example.com on 127.0.0.11:53:
server misbehaving`, Python raises `Temporary failure in name resolution`, and
curl prints `Could not resolve host`. **The `127.0.0.11` is the address the
program sent to, not the resolver that answered**: `resolv.conf` still names
Docker's embedded DNS and the packets are redirected out from under it, so that
address appears whether the session is contained or not. Read the signature as
"this host is not on the allowlist", and never conclude a session is uncontained
because the error names Docker's address.

The one-line check, in the session's terminal: resolve the failing host **and a
host you know is allowlisted**. If the allowlisted one resolves and the other
does not, that is the allowlist — Docker's DNS forwards everything, so it cannot
produce that split. If both fail, it is a real DNS problem.

One warning worth knowing, because it means two opposite things: **Contained —
NOT enforced on this deployment**, in Settings → Network. The containment policy
is on and the install cannot apply it — and which way that falls depends on how
the host is configured.

- **Enforcement is on but the egress sidecar image is missing.** Contained
  sessions **fail to start**, with an error naming the missing image. Loud, and
  obvious.
- **Enforcement was switched off at the deployment.** Sessions start fine and
  run with **open egress** — no allowlist, no prompts, nothing blocked. This is
  the one to surface: the user believes their sessions are contained and they
  are not, and nothing else on screen says so.

Either way the fix is on the host, not in a session — see
[installing-and-updating.md](installing-and-updating.md). If a user is
surprised that a session reached the internet freely, check this warning before
looking anywhere else.

## "A service won't start" / "it says crashed"

The Services drawer under the preview shows each service with a coloured rail
and a word: *Running*, *Starting…*, *Stopped*, or **Crashed**. A crashed one
expands with its error and an **Ask the agent to fix →** link. In the
multi-service list, a container the kernel killed for memory also gets an **OOM**
tag — the drawer's single-service layout has no such tag, so never rule memory
out just because the user does not see one. `shipit service logs <name>` settles
it. The fix is the service's own memory limit in `docker-compose.yml`.

Do the work rather than reading the drawer out: `shipit service logs <name>`,
then fix the compose file or the app, then `shipit service start <name>`. A
first start may pull a large image or run a `build:` and take minutes — a
`start` that times out is still running, so re-check with `shipit service list`.

Changing the *shape* of the stack is always an edit to `docker-compose.yml`;
there is no create or delete command. `/shipit-docs/compose.md`.

## "Dictation isn't working"

The voice panel replaces itself with the failure's own message and offers
**Dismiss**, **Settings**, and either **Try again** or — when the recording
survived — **Re-record** and **Resend**. Resend is the one to suggest: it
retries the transcription without making them speak again. Voice configuration
is **Settings → Voice**.

## When none of this fits

Say so. An invented cause costs more than an honest "I can't tell from here" —
and ShipIt has a real path for it: open the full **Diagnostics** panel from the
health strip, copy its JSON, and file the report through
`/shipit-docs/bug-filing.md`, which redacts it and asks the user to confirm
before anything is sent.

## Who does what

| The user does | You do |
|---|---|
| Clicks **Rescue session**, **Restart agent**, **Kill agent** | Read the health strip and diagnostics first, and say what they show |
| Reconnects a provider or GitHub account | Name which account, and which panel it is in |
| Decides an egress host, once, on the card | Say which host and why, in one line |
| Trusts a repository | Nothing — this one is consent, not configuration |
| Closes sessions under memory pressure | Say which are idle and which are still doing something |
| Chooses to widen the host's memory or disk | Everything inside the session that could avoid needing it |
