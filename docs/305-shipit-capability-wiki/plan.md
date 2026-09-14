---
issue: planning#564
title: ShipIt capability wiki — design
description: Where the wiki lives, the voice every page is written in, how the agent finds the right page, and the page map.
---

# ShipIt capability wiki — design

Implements [`requirements.md`](./requirements.md). Requirements are cited as
`(req N)`. Remaining pages: [`checklist.md`](./checklist.md).

## The gap this closes

`src/server/shipit-docs/` is 27 files and ~7,200 lines, and none of it answers
"can ShipIt do X?". Every file there is an **operating manual for the agent's
own CLI surface** — how to write a compose file, how to spawn a session, how to
file an issue. The product the user works in — the sidebar, the pull-request
card, rewind, mute, themes, the phone — appears in none of it.

That matters most in the case the existing docs never consider: a session on the
**user's own project**. The ShipIt repository's `docs/NNN-*` folders are not in
that container, and neither is the repository README. The agent has no material
to answer from, so it guesses (req 1).

## Placement

`src/server/shipit-docs/wiki/`, one directory below the existing docs. It is
carried into the session worker image by the `COPY src/server/shipit-docs/
/shipit-docs/` already present in both worker Dockerfiles, so it lands at
`/shipit-docs/wiki/` with no build change.

The same path serves req 10. The directory is in a public repository, so a host
agent installing ShipIt reads it over `raw.githubusercontent.com` without ShipIt
running at all. One source, both readers.

## The voice contract (req 9, req 10)

This is the load-bearing decision, and it is what makes the wiki different from
every other doc in the repository. **The reader is an agent; the subject is the
user.** Three rules, restated at the top of the wiki index so a page written
later inherits them:

1. **If ShipIt gives the agent a way to do it, the agent does it.** The page
   carries the command for the agent to run, and never a command for the user to
   type. "Run `shipit service start db`" addressed to a human is a defect — the
   user is talking to an agent precisely so they don't.
2. **If it is genuinely the user's act, say so and say exactly where.** Merging
   a pull request, an OAuth sign-in, a setting only they should choose. Name the
   control and the panel; do not make them hunt.
3. **Outside a session, the acting agent is a host agent.** The install pages
   are written to an agent with a shell on the user's machine and no ShipIt.

This is product principle §5 applied to documentation: chat is the input
surface, the agent is the actor. A wiki that tells users to type commands would
document a different product than the one being described.

## Discovery (req 4)

Grep plus one index, and nothing else. No new API, no viewer, no MCP tool
(req 3).

`wiki/README.md` carries a **question map** — the left column is the user's
words ("can I get back to how it was before that change?", "why did my session
stop?"), the right column is the page. It exists because the vocabulary problem
is real in both directions: the user says "go back", ShipIt says "rewind"; the
user says "on my phone", ShipIt says "Tailscale". The map is the translation
layer, so `grep -ril <the user's word> /shipit-docs/wiki/` lands somewhere even
when the feature's name shares no letters with the question.

The existing `shipit-docs/README.md` gains a row pointing at the wiki, which is
how an agent that only ever learned about `/shipit-docs` arrives.

## What the wiki does not hold (req 5)

Anything with a live query stays a live query. `shipit settings list` already
prints every setting with its current value and the user's own description of
it; `shipit service list`, `shipit agent roles`, and `shipit agent params` do
the same for their surfaces. A wiki page names the command and explains what the
answer means. It never restates a value that would then drift — the failure mode
the whole `shipit settings` surface was built to avoid.

The wiki is also not a second copy of the operating docs. Where a page describes
a feature the agent operates, it describes the feature and links to the
operating doc for the flags.

## Page map

Written in this slice:

| Page | Answers |
|---|---|
| `wiki/README.md` | The index, the question map, and the voice contract |
| `wiki/how-shipit-works.md` | Repo → session → container → branch → preview → PR → merge, and the full capability census |
| `wiki/sessions.md` | Everything about a session's life: create, fork, pin, mute, archive, children, idle, rewind |
| `wiki/installing-and-updating.md` | Install, update, uninstall, reach it from a phone — written to a host agent |

Commissioned but not yet written — one page each, listed in
[`checklist.md`](./checklist.md): the chat surface, previews and services,
the git and pull-request loop, issues and docs, settings and accounts, repos
and sandboxes, plugins and skills, deploys, troubleshooting.

## Freshness (req 7)

The `CLAUDE.md` Workflow rule that already says to update
`src/server/shipit-docs/` when agent-facing behaviour changes is extended to
name the wiki and to cover **user-facing** behaviour — a new panel, a renamed
control, a changed default. No mechanical gate: the pull-request diff is the
enforcement, as it is for the other 27 docs.

## Key files

| File | Change |
|---|---|
| `src/server/shipit-docs/wiki/*.md` | New — the wiki |
| `src/server/shipit-docs/README.md` | New row pointing at the wiki |
| `CLAUDE.md` | Maintenance rule extended to user-facing behaviour and the wiki |
| `README.md` | Links the wiki, so a host agent finds it from the repository root |
