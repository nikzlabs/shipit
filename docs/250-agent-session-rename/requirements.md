---
issue: https://linear.app/shipit-ai/issue/SHI-309
title: Agent session rename
description: Let the agent keep a session's title current as it does more work, unless the user has renamed it.
---

# 250 — Agent session rename: requirements

The design that implements these requirements will be in `plan.md` (not yet written — this feature still has open questions).

Today a session's title is decided once, from the first message, and never changes again on its own. A session that goes on to do several rounds of work keeps a name describing only its first PR, so the sidebar stops describing what the session is actually about.

1. A session's title reflects the work the session has actually done, not only the work it started with.

2. The agent can change the title of the session it is running in.

3. The agent can only rename its own session — renaming somebody else's session is not something it can do.

4. If the user has ever renamed the session by hand, the agent's renames are ignored from then on. The user's chosen name is final and nothing overwrites it.

5. Nothing about renaming requires the user to do anything. A session the user never renames stays named sensibly on its own.

6. The agent reconsiders the title at two moments: when it opens a pull request, and when the session picks up work again after its pull request has merged — the point where the user's next message moves the branch onto the updated base and the session starts a fresh round of work. It is not asked to weigh this up on every turn.

7. What locks a title is the user renaming the session by hand. A title the session was simply born with does not lock it — neither a title taken from the issue the session was started from, nor one a parent agent chose when spawning it as a child. Those describe the task the session was given, which is exactly what goes stale as it does more.

8. The automatic naming that runs shortly after a session's first message never overwrites a title the user or the agent has already set.

9. When the agent renames the session, the chat transcript records that it did, so the name can be explained after the fact.

## Open questions

- **Does renaming a session ever change its branch name?** ShipIt's automatic naming today renames both the title and the git branch.
  - (a) *No — renaming only ever changes the title the user sees.* **Recommended**: by the time the agent wants to rename, a PR usually exists on that branch, and renaming the branch underneath it would strand the PR.
  - (b) *Yes, while no PR exists yet* — keeps title and branch consistent for early renames, at the cost of a rule the user has to know.

## Resolved questions

- 2026-08-04 — When does the agent rename? Chosen: at two specific moments rather than as a standing per-turn judgement — when a pull request is created, and when a merged session picks work back up (the user's next message, which moves the branch onto the updated base). Added as requirement 6.
- 2026-08-04 — What counts as "the user renamed it" and permanently locks the title? Chosen: only a rename the user typed by hand; issue-derived and parent-agent-chosen starting titles stay replaceable. Added as requirement 7, refining requirement 4.
- 2026-08-04 — Must the automatic naming at session start also respect the lock? Chosen: yes — with the note that in practice this window is rarely hit, so it should be satisfied by the simplest ordering check rather than by machinery built for it. Added as requirement 8.
- 2026-08-04 — Should the user see that the agent renamed the session? Chosen: yes, a line in the chat transcript, so the name can be explained after the fact. Added as requirement 9.
