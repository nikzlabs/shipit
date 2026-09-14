# Issues and docs

Two tabs in the right-hand panel, and both are always there — **Issues** holds
the work items, **Docs** holds every piece of written material in the
repository. This page covers what the user can do in each, and what they should
ask you to do instead.

When a step here is something **you** can do, do it — do not read the command
out to the user. When it is a control in a panel, name the control and stop.

## Where the issues come from

ShipIt speaks to **GitHub Issues** and **Linear**, through one tracker-neutral
path. You use `shipit issue` for all of it (`/shipit-docs/issues.md`); the user
gets the same issues rendered in the Issues tab. The tracker's token never
enters the session container either way.

The sub-tabs across the top of the Issues panel are exactly:

- **This session's repository's own GitHub Issues**, which needs no
  configuration and no name.
- **Every tracker the repository declares** in its `shipit.yaml`. A repository
  that declares *itself* replaces the unnamed tab rather than adding a second
  one.

A declared **plugin repository** is a destination you can file feedback into,
but it renders **no tab** and is never what an unqualified list means.

**Never state which trackers are declared — read them.** `shipit.yaml` is the
answer, and a `shipit issue list --tracker <name>` naming one that is not
declared fails with the list of the ones that are.

### Adding a tracker is your job, connecting it is theirs

Declaring a tracker is an edit to the repository's `shipit.yaml`. There is no
settings screen for it, so when the user says "I want my Linear team in here",
**make the edit**:

```yaml
issues:
  trackers:
    - kind: linear
      team: SHI
      name: roadmap
    - kind: github
      repo: owner/planning
      name: planning
```

The credential is the half only they can supply. **Linear**: an API token in
**Settings → Integrations**, which is workspace-wide and holds nothing about
which team is shown. **GitHub**: the same GitHub connection the rest of ShipIt
uses.

That split explains the question users actually ask — *"I connected Linear and
nothing appeared."* A connected Linear token with no declaration produces no
Linear tab at all, because the team lives in the repository's declaration. The
fix is the `shipit.yaml` edit above, not the credential.

Two empty states name the missing half for you. An unconnected Linear tab
offers a **Connect Linear** button, which opens Settings → Integrations. A
GitHub tab with no repository in context reads *"No GitHub repo in context"* —
that session has nothing to draw issues from.

## The Issues list

Each row carries the identifier, the title, its labels, priority, status,
assignee, and a **Start session** button. In a narrow panel the row folds: the
status, assignee and nesting controls move onto their own lines.

The controls above the list, and when each exists:

| Control | When it is there | Does |
|---|---|---|
| Sub-tab per tracker | One per reachable tracker (above) | Switches tracker |
| Issue count | Always | Shows `N issues`, or `N of M` while a filter is on |
| **Show done** | Only once the tracker is connected | Adds completed, canceled and **duplicate** issues, which are all hidden by default |
| **Sort & group** | Only once the tracker is connected | See below. A dot on the button means the sort is not the default |
| **Refresh** | Always | Re-reads the tracker |
| The filter bar | Only when the tracker is connected **and** returned at least one issue | Search box, plus Priority / Status / Assignee / Labels facets, each option showing its count |

**Sort & group** takes a primary key and a secondary key — priority, status,
title, last updated, or assignee — each with its own direction, plus optional
grouping into sections by priority, status or assignee. The default is
priority then status, ungrouped. The choice is remembered between visits, as
is **Show done**.

**Sub-issues nest under their parent**, and are sorted within it rather than
being lifted into the top-level order. That is **Linear only** — GitHub issues
are flat and carry no parent. A sub-issue whose parent is not in the current
list (filtered out, done and hidden, outside the fetch) is shown at the top
level with a `↳ in PARENT` hint rather than disappearing. Nested rows start
expanded in a wide panel and collapsed in a narrow one.

## Reading and changing one issue

Clicking a row opens it in place: status, priority, title, assignee, labels, the
description, and the whole comment thread, with a box to add a comment.

**What the user changes here**, directly:

- **Status** — from the pill at the top, or the status cell on a list row.
- **Priority** — Linear only. GitHub Issues has no priority field, so a GitHub
  issue shows its priority as a read-only badge.
- **Labels** — add from the label editor, remove with the `✕` on a chip.
  This one *replaces* the issue's label set, so a removal really removes.
- **A comment** — the box at the bottom of the thread.

**Everything else is yours**, and there is no button for it in the panel:
creating an issue, assigning it, editing its title or body, nesting it under a
parent, creating or editing labels, and correcting a comment you wrote. All of
it is `shipit issue` — `create` and the `label` verbs always name a tracker
with `--tracker <name>`, so a forgotten flag can never file into the wrong
place.

Two differences worth stating when they come up:

- **Your writes leave a card in the chat; theirs do not.** Everything you do
  through `shipit issue` posts an inline provenance card recording the change,
  with an **Undo** button the user can press. A change they make in the panel is
  their own act in front of them, so it posts nothing.
- **On GitHub the write is genuinely the user's** — it goes out under their
  own GitHub token. On Linear it goes out under one deployment-wide token, so
  it is attributed to that token's owner. The card says which.

The header carries an **Open in GitHub / Open in Linear** link. That is the
escape hatch, not the answer — everything above is why the user should not
need it.

## Starting a session from an issue

**Start session** sits on every list row and in the footer of an open issue.
It does not send anything: it **prefills the composer** with a prompt seeded
from the issue, for the user to edit and send.

- It is disabled, reading *"Add a repo first to start a session"*, when no
  repository is in context.
- When more than one repository is registered it becomes a split button — the
  caret picks which repository to start the issue in. A declared tracker is
  often a planning repo or a Linear team shared across projects, so the issue
  frequently belongs somewhere other than the session they are sitting in.
- If the current session already has messages, or another repository was picked,
  ShipIt opens a fresh session first rather than appending to that conversation.

When that first message is sent, three things happen that you should not repeat
by hand:

1. The session's **branch and title come from the issue**, not from the usual
   naming pass.
2. **ShipIt moves the issue to `started`** and posts the provenance card. Do not
   run `shipit issue status … started` in a session that was seeded this way.
3. The reference travels **alongside** that first message rather than inside the
   editable prompt — so 1 and 2 still happen if the user rewrites the prompt
   entirely.

**The one case where you do mark it started yourself** is the other one: the
user pasted a pointer into chat instead of starting from the panel. Then run
`shipit issue status <pointer> started` when you begin.

## Closing an issue by merging the pull request

The finishing PR declares what it finishes, in its **body**, and the merge does
the rest. Do not run `status completed` by hand for it.

- **`Closes <pointer>`** (or `Fixes` / `Resolves`) — on merge ShipIt moves the
  issue to **completed** and posts a resolved-by comment naming the PR.
- **`Refs <pointer>`** — on merge it posts a progress comment and leaves the
  issue **open**. This is the intermediate PR in a multi-PR effort; *omitting*
  `Closes` is exactly how you say "more to come".
- A PR naming no pointer gets no issue activity at all.

Both are ShipIt parsing the body and routing through the brokered path, so they
work for Linear as well as GitHub, and both post a provenance card with Undo.
Do not rely on GitHub's own `Closes #N` keyword instead: it only reaches
same-repository GitHub issues and it bypasses the card and the comment.

The pull-request card in the conversation carries a chip per reference, in
descending order of commitment: **Closes**, then **Refs**, then **From
session** — the last read out of the session's first message, so an issue the
work started from is shown even when the PR body never names it. Each chip
opens the issue inside ShipIt; one naming no declared tracker still renders,
as a plain badge, because hiding what the PR body says would be worse.

## Issue references open in place, everywhere

The user never has to leave to read an issue that was mentioned:

- A **bare reference in chat prose** — an uppercase key like `SHI-304`, or the
  name form `planning#57` / `roadmap#SHI-304` — renders as a badge that opens
  the issue in the Issues tab. A token that resolves to no declared tracker
  stays exactly the text it was, so `PR#3` and `UTF-8` are not badged.
- A **tracker issue URL**, or the `owner/repo#N` short form written as a link,
  opens in the panel too when that tracker is reachable here; when it is not, it
  stays an ordinary external link rather than a dead end.
- A doc's **`issue:` frontmatter** becomes a chip, both on its row in the Docs
  list and at the top of the open document. A pointer naming no declared tracker
  degrades to a plain badge.
- **Your own `shipit issue view`** posts a small navigation card, so the user
  can follow what you read and open it themselves. Nothing is needed from you.

When you write a reference yourself — doc frontmatter, a PR body, chat
prose — use the `name#id` form (`planning#42`, `roadmap#SHI-304`). It survives
the declaration being re-pointed.

## The Docs tab

Every `.md` file in the workspace, scanned recursively, skipping `node_modules`
and `.git`. Not just `docs/` — a top-level `README.md` and a stray `notes.md`
are in the list too. Treat any markdown you write as visible to the user.

The list is grouped, top to bottom:

- **Modified in this session** — docs that differ from the pull request's base
  branch. It is the first thing the user sees after you touch a design doc.
- **Tracked** — a `plan.md`, a `checklist.md`, any doc with an `issue:`
  pointer, and any doc in a folder that has a `checklist.md`.
- **Other** — everything incidental.

Tracked and Other render as two sub-tabs only when **both** groups have
something in them; otherwise the list is flat with a heading.

Three rules about that grouping surprise people:

- **Within Tracked, a doc whose sibling `checklist.md` is fully ticked folds
  into a collapsed "Done" group.** That is what checking off the last box does,
  and it is why an abandoned checklist keeps a finished feature in the active
  list.
- **A `checklist.md` next to a `plan.md` is not listed on its own.** Its `N/M`
  progress badge rides on the plan's row instead.
- **An incidental file in a folder that already holds a tracked doc is not
  listed under Other.** A feature folder shows its design, not its leftovers.

Above the list: the doc count, a **search** magnifier that filters on title,
path and description, and **Reload**.

### Opening one

A document opens in a viewer dialog over the app, rendered rather than raw. At
the top, a header built from its frontmatter — the issue chip, the one-line
description, and any other frontmatter keys. When its folder holds two or more
markdown files, tabs across the top switch between them, `Plan` first and
`Checklist` second.

A **Start Session** button appears on that viewer for a `plan.md`, or for any
doc carrying an `issue:` pointer — and only for those. Like the issue button
it prefills the composer rather than sending, with a prompt asking for the
plan to be read and implemented.

## Commenting on a selection inside a document

This is how the user marks up a design doc without writing a paragraph of chat
describing which sentence they mean.

They select text in the rendered document; a floating **Comment** button
appears; the note they write is anchored as a card under the block it came from.
Comments pile up as a **draft**, held per session and per file on the server, so
closing the viewer does not lose them.

The footer appears **once there is a draft comment or a past review** — not
before — and carries the draft count, a collapsible **Past reviews (N)** log
of everything sent for this file, and the **Send** button. Send is refused
while a comment is still open in its editor ("Finish your comment first").
Sending opens a short dialog for an optional overall note, then delivers
**one message** to you quoting every comment with the text it was attached to.
That starts a turn: the comments are the instruction, and answering them is the
work.

Two things to know when you read one:

- **Orphaned comments.** A comment whose quoted text no longer appears in the
  document is collected under that heading and is still sent, flagged. It is on
  you to judge whether the feedback still applies — say so rather than
  silently skipping it.
- The same machinery covers code files, where a comment attaches to a line
  instead of a selection.

An **Ask agent to review** button also sits on the viewer, where the session's
harness supports it, and is disabled while a turn is running. It starts a review
turn on the open file with no comments needed.

## Who does what

| The user does | You do |
|---|---|
| Connects Linear or GitHub in Settings → Integrations | Declare the tracker in `shipit.yaml` so its tab appears |
| Sets status, priority, labels; posts a comment in the panel | Create, assign, edit, nest, and everything else — `shipit issue` |
| Presses Start session on an issue, then edits and sends the prompt | The work; the issue is moved to *started* for you |
| Merges the pull request | Put `Closes <pointer>` in its body so the merge completes the issue |
| Comments on a selection in a doc and presses Send | Answer every comment, including the orphaned ones |
| Ticks nothing by hand in a checklist | Mark `[x]` as you finish, so the doc folds into Done |
