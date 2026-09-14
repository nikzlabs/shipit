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
| **Permission mode** | Plan / Guarded / Auto, below. The same control carries the session's **network access** — see [sessions.md](sessions.md) |
| **Harness · model · reasoning**, or a **role** in their place | What this session runs on. `shipit agent params` and `shipit agent roles` for what this install offers |
| **The ring** | The context dial — how full the conversation is, and what it has cost. Below |
| **Mic** | Dictation. Present only when the user has turned voice input on |
| **Send**, or **Stop** while a turn runs | Below |

**Enter sends and Shift+Enter makes a new line**, and neither is rebindable. On
a phone Enter makes a new line — the Send button is the only way to send. The
composer keeps a **draft per session**, so switching away mid-sentence and
coming back does not lose it.

Below about 700px of composer width — the chat panel is a draggable split, so
this happens on a wide window with a narrow panel too — the permission, harness,
model and reasoning controls fold into a single settings menu, and the mic, Stop
and Send stay where they are.

### Permission mode

Three modes, offered as an oversight ladder. Only the modes the active harness
supports appear, so on a harness with one mode there is nothing to choose.

| Mode | Means |
|---|---|
| **Plan** | Read-only. You research and plan; you do not edit |
| **Guarded** | Autonomous, but every shell and network command is safety-checked before it runs and risky ones are blocked. Slower, and costs a little more. Needs a Sonnet or Opus model — the menu says so and refuses the pick otherwise |
| **Auto** | Autonomous, no command safety check |

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
put into the message as an image; a text file is inlined; a binary one arrives
as a note telling you to read it from `/uploads` yourself. The session's uploads
are also listed under **Uploads** at the bottom of the **Files** tab, where the
user can delete one they no longer want.

**Workspace file references — `@`.** Typing `@` opens a file picker over the
session's own checkout. Picking one writes
`@path` into the message and adds a chip. On send, ShipIt reads that file **as
it is at that moment** and inlines its contents, marked as untrusted content.
Limits: **10 files per message, 100KB per file, 500KB in total** — over any of
them the send is refused with a message saying which. The same chip can be added
from the **Files** tab ("Add to chat") or by dragging a file out of the file tree
onto the composer.

**A large paste.** Pasting **2000 characters or more** attaches it as
`pasted-text.txt` instead of dumping it into the box.

Two refusals worth recognising, because the user will ask why Send is dead:
while an attachment is still uploading, and while one has failed — the button's
tooltip says which, and a failed chip offers Retry. And a message carrying an
image sent on a model known to be text-only is refused outright, naming the
model and offering the two ways out: remove the attachment, or switch the
session's model.

## `@` files and `/` skills

`@` opens its menu anywhere in the message; `/` opens its own only as the first
character of one, so a slash written mid-sentence is just a slash. Both take
arrow keys, Enter or Tab to accept, and Escape to dismiss.

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
  and a message sent now is injected into the turn you are already running. It
  appears in the transcript as an ordinary message from them, and you see it
  mid-turn. This is the default; the switch is *Inject messages mid-turn* in
  **Settings → Advanced** (`shipit settings get advanced.liveSteering`).
- **Otherwise** the message is **queued**. A strip above the composer lists the
  queued messages in order, each with an ✕ to drop it, and **Clear all**. A
  queued message runs as its own turn once the current one has finished and its
  work is committed.

**Stop** interrupts you where you are — and ShipIt still commits whatever the
turn had already written, so nothing is lost by stopping. A stop that does not
take is what **Force-kill the agent** on the Terminal tab's health strip is for
([sessions.md](sessions.md)).

While you work, a line under the transcript names what you are doing. When the
turn ends, ShipIt commits and pushes; that flow is in `/shipit-docs/github.md`.

## When you need the user

Four things stop and ask, and they look different on purpose.

| Card | Appears when | The user can |
|---|---|---|
| **Permission needed** | A tool call needs approval | **Approve**, **Deny**, or **Approve & remember** — the last only when the request names a file, and it then allows that file for the rest of the session. **Show details** expands the full gated call. There is no timeout; it waits |
| **A question** | You call `AskUserQuestion` | Pick an option, tick several where the question allows it, or choose **Other** and type — with a mic on that field. Answering starts a turn |
| **Plan ready** | You leave plan mode | Accept, accept guarded, or suggest changes (above) |
| **Voice note** | You call `voice_note` | Play the spoken headline. Below |

A permission prompt counts as you still working, so the session is not "waiting
on the user" in the sidebar's sense and cannot be muted — see
[sessions.md](sessions.md). A question does put the session in that state.

Answered cards stay in the transcript showing what was chosen, and survive a
reload.

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
when to call it. It renders as a card with a Play button, and the user can have
notes autoplay hands-free, with a chime, from **Settings → Voice**. Where a note
goes — inline, to a webhook, or both — is the user's setting and never your
decision; always just call the tool. Separately, the same tab can put a **Play**
button on every completed turn of yours, for reading a whole reply aloud.

## A long conversation

**Collapsed turns.** *Compact completed turns*, in **Settings → Advanced**,
collapses every turn but the newest down to the user's message and your last
reply: tool calls, progress and cards are hidden, while errors and any card that
still needs them stay. Each collapsed turn carries a **Show full turn** button.
It is saved per browser, so it does not follow the user to their phone.

**Search.** The magnifying glass in the strip at the very top of the
conversation opens a search bar over the whole conversation, with a match count
and next/previous (Enter and Shift+Enter step through them, Escape closes). It
is the one that finds text inside a collapsed turn — and it reveals it — where
the browser's own Find can only see what is on screen. The strip carries it in
an ordinary session; a sandbox session has a different strip and no search.

**The context dial.** The ring in the composer row — present once ShipIt knows
the session's model, so not on a session that has never run a turn — shows how
full the model's context window is and, beside it, what the session has cost so far. Opening it
gives the per-turn breakdown, the largest turns, token and cache totals, and a
row that opens the full usage view. It goes yellow, orange and red as the window
fills.

**Compaction** summarises the conversation so far and frees that context. Three
ways it happens:

- The user types **`/compact`**, optionally with instructions after it —
  `/compact keep the API decisions, drop the debugging`. This one is genuinely
  theirs: there is no command that lets you compact your own conversation, so
  when context is the problem, say that and let them type it. The dial's popover
  suggests it once the ring is orange or red.
- **The harness does it itself** when its context fills.
- **After a merge.** When a session's pull request has merged and the user's
  next message will reset the branch to the latest base, the composer offers
  *Compact the context* beside that choice — shipped work is summarised down to
  what it changed, keeping their standing preferences and anything unresolved.
  Offered only where the harness supports compaction, and the user can untick it.

Whichever way it happened, a **Context compacted** card is left in the
transcript with the before/after token counts, which is the record that it ran.

## Goals

`/goal <condition>` sets a condition for the session to work toward; `/goal`
alone (or `/goal status`) reads it, and `/goal clear` removes it. Where the
harness has them, `/goal pause` and `/goal resume` too. A live goal shows as a
chip above the composer with its objective and state, and it disappears when the
goal ends.

Which of those a session offers depends entirely on the harness — the `/` menu
lists only the ones it can actually do, and an action with no equivalent is
answered with a notice rather than being sent to you as ordinary text. Some
actions are answered without running a turn at all; setting a goal generally
starts work immediately, so it rides a normal turn, with a transcript and a
commit like any other.

## Showing something, and offering follow-ups

**The Present tab** renders a self-contained file — a diagram, a mockup, a
chart, a rendered document — with no dev server. Write the file, then call
`present`; `/shipit-docs/present.md` is the full reference. Two conditions worth
knowing, because users ask: **the Present tab only exists once the session has
at least one artifact**, and ShipIt switches the panel to it only for the
**first** one — after that a new artifact raises a count badge instead of taking
the screen. The tab is a carousel with previous/next, a gallery, and a download
button, and the file path is the identity: re-presenting the same path updates
that entry in place. Passing `inline: true` also puts the artifact in the
conversation as a card, where it stays.

Use it. A diagram you described in prose is a diagram the user did not see.

You can also make a place in the running app or in a presented artifact
clickable straight from chat — `/shipit-docs/chat-links.md`.

**Proposed actions.** When you would end a turn by suggesting optional
follow-ups, `propose_actions` renders them as a card instead: one action becomes
a button, several become a checklist the user ticks and submits once, with your
recommendation pre-ticked. **Add comment…** lets them send the same selection
with a note attached. The card stays in the transcript and can be submitted much
later — which is why each action carries a standalone instruction rather than
relying on what was on screen at the time. Ticking declares intent; the work is
still yours to do.

## Quoting and re-using what is on screen

Selecting text anywhere in the conversation raises a **Quote** button, which
drops the selection into the composer as a blockquote with room to reply under
it. It works on your output as well as theirs — the fastest way for a user to
say "this part, specifically".

## Who does what

| The user does | You do |
|---|---|
| Types, dictates, attaches, and sends | Read the message, including the attachments and the `@` files |
| Interrupts, queues, cancels a queued message | Stop cleanly; ShipIt commits the partial work |
| Answers a question, approves or denies a permission, accepts a plan | Ask only when the answer changes what you do |
| Types `/compact` when context is full | Say that context is the problem — you cannot compact it yourself |
| Sets and clears a goal | Work toward it |
| Chooses the permission mode | Say what the work needs, and why |
| Ticks a proposed action | Offer them; then do the work |
