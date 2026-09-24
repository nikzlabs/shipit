# Chat

The conversation is where the user spends nearly all of their time, and almost
everything they can do to you they do from the composer at the bottom of it.
This page is that surface: what they can put in a message, what happens while a
turn is running, how you ask them for something, and what the conversation does
to itself as it gets long.

When a step here is something **you** can do, do it. Where the act is genuinely
theirs — a key only they can press, a setting only they can change — name the
control and the panel, once, and stop.

## The composer

One box, with a row of controls under it:

| Control | Does |
|---|---|
| **+** | Opens a file picker. Also the drop target: files dragged anywhere onto the composer are attached |
| **Permission mode** | Plan / Guarded / Auto, below. The same control carries the session's **network access** — see [sessions.md](sessions.md) — except in a sandbox session, where egress is one of the capability grants instead |
| **Harness · model · reasoning**, or a **role** in their place | What this session runs on. `shipit agent params` and `shipit agent roles` for what this install offers |
| **The ring** | The context dial — how full the conversation is, and what it has spent. Below |
| **Mic** | Dictation. Present only when the user has turned voice input on |
| **Send**, or **Stop** while a turn runs | Below |

**Enter sends and Shift+Enter makes a new line**, and neither is rebindable. On
a phone Enter makes a new line — the Send button is the only way to send. The
composer keeps a **draft per session**, so switching away mid-sentence and
coming back does not lose it.

Below about 700px of composer width — the chat panel is a draggable split, so
this happens on a wide window with a narrow panel too — the harness, model and
reasoning controls fold into a single settings menu. The permission-and-network
control keeps its own place in the row on every width, as do the mic, Stop and
Send.

### Permission mode

Three modes, offered as an oversight ladder. Only the modes the active harness
supports appear, so on a harness with one mode there is nothing to choose.

| Mode | Means |
|---|---|
| **Plan** | Read-only. You research and plan; you do not edit |
| **Guarded** | Autonomous, but every shell and network command is safety-checked before it runs and risky ones are blocked. Slower, and costs a little more. Conditions below |
| **Auto** | Autonomous, no command safety check |

**Guarded mode can be picked and then not happen, and this is worth getting
right** — it is the one place where reassuring the user wrongly has a cost. The
menu enforces the model half: guarded needs a Sonnet or Opus model, and it
refuses the pick otherwise. The *account* half is only discovered when the turn
starts: it also needs a Max, Team or Enterprise plan, and where the account or
the model cannot run it, ShipIt says so in the conversation and **runs the turn
in auto — with no command safety check at all**, as do the turns after it. So if
the user asks whether their commands are being checked, look for that notice
rather than answering from the control's label.

In Plan mode your plan arrives as a card with **Accept & Execute**, **Accept in
Guarded Mode** (only where the harness has a guarded mode) and **Suggest
Changes**, which opens a text field. Accepting moves the session out of plan
mode for you; suggesting changes sends the text as the next message.

## Attaching files and images

Three different things land in a message, and they behave differently:

**Uploads — files from the user's own machine.** Attached with **+**, by
dragging them onto the composer, or by pasting an image. They are copied to the
host and mounted into the session container at **`/uploads/<name>`,
read-only** — outside the git repo, so they are never committed. Copy one into
`/workspace` or `/persist` before modifying it. An image upload is decoded and
put into the message as an image; a text file is inlined, unless it is over
100KB; a binary one, and an oversized text one, arrive as a note telling you to
read the file from `/uploads` yourself. Uploading has its own limits, separate
from the `@` ones below: **50MB per file, 20 files at a time, 500MB per
session**. The session's uploads are also listed under **Uploads** at the bottom
of the **Files** tab, where the user can delete one they no longer want.

**Workspace file references — `@`.** A pointer at a file in the session's own
checkout, picked from the `@` menu (next section), added from the **Files** tab
with "Add to chat", or dragged out of the file tree onto the composer. Each one
shows as a chip. ShipIt reads the file and inlines its contents, marked as
untrusted content — **at the moment the message runs**, not the moment it was
typed, so a message that sat in the queue carries the file as it is when its
turn starts. Limits: **10 files per message, 100KB per file, 500KB in total** —
over any of them the send is refused with a message saying which.

**A large paste.** Pasting **2000 characters or more** attaches it as
`pasted-text.txt` instead of dumping it into the box.

Three refusals worth recognising, because the user will ask why Send is dead.
Two are about the attachment: while one is still uploading, and while one has
failed — the button's tooltip says which, and a failed chip offers Retry. The
third is not about attachments at all — when no model provider can run a turn,
the whole composer is dead and says so in its placeholder, *"Add a model
provider to start chatting"*; that is an install with no usable account behind
it, and the answer is Settings → Model providers, not anything about the
message.

Separately, a message carrying an image sent on a model known to be text-only is
refused outright, naming the model and offering the two ways out: remove the
attachment, or switch the session's model.

## `@` files and `/` skills

`@` opens its menu at the start of the message or after any non-alphanumeric
character — so `an @file` opens it and `word@file` does not, and there has to be
a file tree to pick from. `/` opens its own only as the very first character of
the message, so a slash written mid-sentence is just a slash. Both take arrow
keys, Enter or Tab to accept, and Escape to dismiss.

`/` opens the skills-and-commands menu. It lists:

- **Skills the project carries** for the session's active harness, read from
  that harness's skills directory in the workspace. A skill marked
  `user-invocable: false` in its frontmatter is left out, and so is any skill
  ShipIt materialised from a plugin repository — those are yours to invoke, not
  commands the user chose to have. Some harnesses' CLIs bundle skills of their
  own; where they do, those are merged into the list.
- **ShipIt's own commands**, `/compact` and `/goal`, each offered only when the
  active harness can actually do it.

Picking a skill inserts the token that harness uses — which is not `/` on every
harness. The menu handles that; the user never has to know. `/shipit-docs/skills.md`
has the directory layout and the naming, and **Settings → Skills** is where the
user installs more.

## While a turn is running

The Send button is replaced by a red **Stop**. Two things decide whether they
can also send:

- **Live steering is on and the harness supports it** — Send stays beside Stop,
  and a message sent now is normally injected into the turn you are already
  running. It appears in the transcript as an ordinary message from them, and
  you see it mid-turn. The switch is *Inject messages mid-turn* in **Settings →
  Advanced** (`shipit settings get advanced.liveSteering`). Injection also needs
  a live streaming process and a turn that can take one: a ShipIt-driven system
  turn, or a merge being held, sends the message to the queue instead. That is
  the honest answer to "why did it queue when it should have interrupted?".
- **Otherwise** the message is **queued**. A strip above the composer lists the
  queued messages in order, each with an ✕ to drop it, and **Clear all**. A
  queued message runs as its own turn once the current one has finished and its
  work is committed. Without live steering there is no Send button mid-turn at
  all: on a desktop Enter still queues, but **on a phone there is no way to
  queue while a turn runs** — they wait, or they stop the turn.

**Stop** interrupts you where you are — and in an ordinary session ShipIt still
commits whatever the turn had already written, so nothing is lost by stopping.
Stop ends the agent process too, with the background tasks running inside it (a
background shell, a background subagent), so none of them can wake it into a
new turn; the next message resumes the conversation. A brokered
`shipit agent run` is not inside it and keeps running. A
stop that does not take is what **Force-kill the agent** on the Terminal tab's
health strip is for ([sessions.md](sessions.md)).

While you work, a line under the transcript names what you are doing. When the
turn ends, ShipIt commits, and pushes if the session has a remote and GitHub is
connected; that flow is in `/shipit-docs/github.md`. **Ops and sandbox sessions
are exempt from the automatic commit entirely** — work there is committed only
when something asks for it, so say so rather than promising a commit that will
not happen.

## When you need the user

Three things stop and wait for an answer, and they look different on purpose.

| Card | Appears when | The user can |
|---|---|---|
| **Permission needed** | A tool call needs approval | **Approve**, **Deny**, or **Approve & remember** — the last only when the request names a file, and it then allows that file for the rest of the session. **Show details**, where the call has more to show than the one-line summary, expands it in full. There is no timeout; it waits |
| **A question** | You call `AskUserQuestion` | Pick an option, tick several where the question allows it, or choose **Other** and type — with a mic on that field where voice input is on. Answering starts a turn |
| **Plan ready** | You end plan mode with `ExitPlanMode` — the card hangs off that tool call, so plan-shaped prose alone does not produce one | Accept, accept guarded, or suggest changes (above) |

A permission prompt counts as you still working, so the session is not "waiting
on the user" in the sidebar's sense and cannot be muted — see
[sessions.md](sessions.md). A question does put the session in that state.

Answered cards stay in the transcript and survive a reload. A question keeps the
answer that was chosen; a plan card reloads as simply resolved, without saying
which way it went.

## Voice

**Dictation into the composer.** The mic button exists only once the user has
turned voice input on in **Settings → Voice**; there is also a push-to-talk
hotkey, rebindable in **Settings → Keyboard**. Click starts and click stops —
press-and-hold is deliberately not a gesture. On a phone, recording takes over
the screen with a large Stop and a Cancel. The transcript is spliced in at the
cursor, so dictation can extend a half-typed message rather than replacing it.
Optionally an LLM cleans the transcript up first — mis-hearings, fillers, casing
— and if that step fails the raw transcript lands anyway, with a note. Which
provider transcribes, and in which language, are settings on the same tab.

**When a message was dictated, you are told.** ShipIt adds a `<dictated_input>`
block to the prompt. Read it as intent rather than literally: expect mis-heard
proper nouns, homophones and missing punctuation, correct the obvious ones
silently, and ask about a garbled part only when it would change what you do.
The same applies to a dictated "Other" answer on a question card.

**Spoken summaries back.** `voice_note` is how you tell a user who is not
looking at the screen that you need them — see `/shipit-docs/voice-notes.md` for
when to call it. It does not block: the note goes out and you carry on, so it is
not one of the three cards above. Where it goes — an inline card in the
conversation, a webhook, or both — is the user's setting and never your
decision; always just call the tool. Where the note does land in the
conversation it is a card with a Play button, and the user can have such notes
autoplay hands-free, with a chime, from **Settings → Voice**. On a webhook-only
setting there is no card at all, which is not a failure. Separately, the same
tab can put a **Play** button on every completed turn of yours, for reading a
whole reply aloud.

## A long conversation

**Collapsed turns.** *Compact completed turns*, in **Settings → Advanced**,
collapses every turn but the newest down to the user's message and your last
reply: tool calls, progress and cards are hidden, while errors, action cards and
any card that still needs them stay — an action card stays whether or not it has
been sent, so an offer is never folded away. Each collapsed turn ends with a
small caret, on the rewind strip below it, that opens the turn again; hovering
it says what the fold is holding ("2 tool calls · 1 message"). The setting is
saved per browser, so it does not follow the user to their phone.

**Search.** The magnifying glass in the strip at the very top of the
conversation opens a search bar, with a match count and next/previous (Enter and
Shift+Enter step through them, Escape closes). It is the one that finds text
inside a collapsed turn — and it reveals it — where the browser's own Find can
only see what is on screen. It searches the **message text** of every turn, and
nothing else: a command inside a tool call, a tool's output, or a label on a
card will not be found, so do not send the user hunting for one that way. The
strip carries it in an ordinary session; a sandbox session has a different strip
and no search.

**The context dial.** The ring in the composer row — present once ShipIt knows
the session's model, so not on a session that has never run a turn — shows how
full the model's context window is. It goes yellow, orange and red as the window
fills. Opening it gives the per-turn breakdown, the largest turns, token and
cache totals, and a row that opens the full usage view.

Money needs care when answering. The dial separates **metered spend** — what an
API key was actually charged — from **at API rates**, which is what turns
already covered by a subscription *would* have cost and is not a bill. The
figures sit beside the ring on a wide composer and inside the popover otherwise,
so "I can't see a number" usually means a narrow panel.

**Compaction** summarises the conversation so far and frees that context. Three
ways it happens:

- The user types **`/compact`**, optionally with instructions after it —
  `/compact keep the API decisions, drop the debugging`. This one is genuinely
  theirs: there is no command that lets you compact your own conversation, so
  when context is the problem, say that and let them type it. The dial's popover
  suggests it once the ring is orange or red. Note that supporting compaction
  and honouring those extra instructions are two different things — some
  harnesses take only the instruction to compact and summarise on their own
  terms, so do not promise that a phrasing will be obeyed.
- **The harness does it itself** when its context fills.
- **After a merge.** When a session's pull request has merged and the user's
  next message will reset the branch to the latest base, the composer offers
  *Compact the context* beside that choice — shipped work is summarised down to
  what it changed, keeping their standing preferences and anything unresolved.
  Offered only where the harness supports compaction, and the user can untick it.

Whichever way it happened, a **Context compacted** card is left in the
transcript — with the before and after token counts where the harness reports
both, and a plain sentence where it does not. Either way the card is the record
that it ran.

## Goals

`/goal <condition>` sets a condition for the session to work toward; `/goal`
alone (or `/goal status`) reads it, and `/goal clear` removes it. Where the
harness has them, `/goal pause` and `/goal resume` too. A goal shows as a chip
above the composer carrying its objective and its state — active, paused,
blocked, complete.

What happens when the objective is reached depends on the harness, so do not
promise either outcome. Some evaluate the condition themselves and clear the
goal silently; ShipIt re-reads the goal after the turn and the chip goes. Others
leave it in place reading **Complete** until someone clears it, which is why a
session can sit there showing a finished goal. `/goal` reports the truth in both
cases.

Which of those a session offers depends entirely on the harness — the `/` menu
lists only the ones it can actually do, and an action with no equivalent is
answered with a notice rather than being sent to you as ordinary text. Some
actions are answered without running a turn at all; setting a goal generally
starts work immediately, so it rides a normal turn, with a transcript and a
commit like any other.

## Showing something, and offering follow-ups

**The Present tab** renders a self-contained file — a diagram, a mockup, a
chart, a rendered document — with no dev server. Write the file, then call
`present`; `/shipit-docs/present.md` is the full reference. The conditions worth
knowing, because users ask: **the Present tab only exists once the session has
at least one artifact**, and ShipIt takes the user to it exactly once — when the
session's *very first* artifact arrives and it is not inline. Everything after
that raises a count badge on the tab instead of taking the screen. The corollary
catches people out: if the first artifact of the session was `inline: true`, no
later one will ever open the tab by itself, so say where it is rather than
assuming they are looking at it. The file path is the identity — re-presenting
the same path updates that entry in place — and a second artifact gives the tab
its previous/next arrows and gallery, which a single one has no need of. Passing
`inline: true` also puts the artifact in the conversation as a card, where it
stays.

Use it. A diagram you described in prose is a diagram the user did not see.

You can also make a place in the running app or in a presented artifact
clickable — from chat, and from inside an artifact itself, so a row in a table
you presented can open the page that produced it. Workspace-relative and
absolute `/workspace/` links open the same artifact in the current session.
See `/shipit-docs/chat-links.md` for path rules and examples.

**Proposed actions.** When you would end a turn by suggesting optional
follow-ups, `propose_actions` renders them as a card instead: one action becomes
a button, several become a checklist the user ticks and submits once, with your
recommendation pre-ticked. **Add comment…** lets them send the same selection
with a note attached. The card stays in the transcript and can be submitted much
later — which is why each action carries a standalone instruction rather than
relying on what was on screen at the time. Ticking declares intent; the work is
still yours to do.

**Which offer tool you have depends on a setting.** The user can turn on
"Session status card" (Settings → Advanced). While it is on, you have
`session_status` and not `propose_actions`: the offers are part of the status
card the user reads just above the input field, rather than a card in the
transcript. Your own tool list is the answer to which one applies — do not
assume, and read the setting with `shipit settings get advanced.sessionStatusCard`
if you need to say what it is set to.

## Quoting and re-using what is on screen

Selecting text anywhere in the conversation raises a floating **Reply** button,
which drops the selection into the composer as a blockquote with room to write
under it. It works on your output as well as theirs — the fastest way for a user
to say "this part, specifically".

## Who does what

| The user does | You do |
|---|---|
| Types, dictates, attaches, and sends | Read the message, including the attachments and the `@` files |
| Interrupts, queues, cancels a queued message | Stop cleanly; in an ordinary session ShipIt commits the partial work |
| Answers a question, approves or denies a permission, accepts a plan | Ask only when the answer changes what you do |
| Types `/compact` when context is full | Say that context is the problem — you cannot compact it yourself |
| Sets and clears a goal | Work toward it |
| Chooses the permission mode | Say what the work needs, and why |
| Ticks a proposed action | Offer them; then do the work |
