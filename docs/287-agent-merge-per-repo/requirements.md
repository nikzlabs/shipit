---
issue: planning#499
title: Agent merge, granted per repository
description: A per-repository permission that lets an agent merge the pull request its own session opened, stored by ShipIt and never readable from the repository.
---

# Agent merge, granted per repository

Today an agent can merge only in a **sandbox** session, and only when the user
granted `dangerousGitHubOps` at creation
(`docs/224-sandbox-merge-capability`). In an ordinary repo-bound session the
merge is refused with a 403, so the agent can take a pull request to green CI
but cannot land it. This feature moves the permission to the **repository**.

## Requirements

1. A user can allow agents to merge pull requests in a given repository, and can
   withdraw that permission again at any time.
2. The permission is off for every repository until the user turns it on.
3. ShipIt stores the permission, and only ShipIt's own interface can set it. No
   file inside the repository grants it, so an agent cannot give itself the
   permission by writing to the repository.
4. When the permission is on, an agent in a repo-bound session can merge the
   pull request that its own session opened.
5. An agent cannot merge any other pull request. This includes a pull request
   opened by a different session, by another agent, or by a person.
6. When the permission is off, an agent that tries to merge gets a refusal that
   says the permission is off for this repository and where the user turns it
   on.
7. These guardrails apply to every agent merge, with the permission on:
   required checks must pass, a draft pull request is refused, an administrator
   override is refused, and GitHub's own refusal is shown word for word.
8. A merge that GitHub's review rules block is refused, and the refusal says
   that a review is missing or that changes were requested.
9. Each agent merge is recorded in the chat transcript. The record names the
   pull request, says the agent merged it, and is still there after a page
   reload.
10. After the agent merges its own pull request, the session can open the next
    pull request without help from the user.
11. After an agent merge, the pull request card and the session state are the
    same as after a merge from the card's own merge button.
12. The permission for sandbox sessions does not change. A sandbox session has
    no repository record, so it keeps its own per-session grant.
13. Ops sessions cannot merge. Their behaviour does not change.

## Open questions

None.

## Resolved questions

- 2026-09-02 — Should the grant let the agent merge directly, or only arm
  auto-merge so that ShipIt merges when CI turns green? **Answer: direct merge,
  with the guardrails.** The agent decides both readiness and timing; the
  guardrails in req 7 and req 8 are what hold. (req 4, 7, 8)
- 2026-09-02 — How wide is the grant? **Answer: the pull request of the agent's
  own session only.** This removes the dead end but gives no agent power over
  another agent's or a person's pull request, and it removes the case where
  text in a different pull request talks the agent into merging it. (req 4, 5)
- 2026-09-02 — Where does the switch live: ShipIt's repository settings, or
  `shipit.yaml` in the repository? **Answer: ShipIt's repository settings.** An
  agent can write `shipit.yaml`, so a permission declared there is a permission
  the agent can grant itself. This keeps the rule from
  `docs/224-sandbox-merge-capability`: a capability is set server-side and is
  never inferred from workspace files. (req 3)
