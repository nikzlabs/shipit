---
issue: planning#39
title: Sub-agent spawning — requirements for the run limit
description: What the limit on sub-agent runs must do, in the user's terms. Covers the run limit only; the rest of the feature predates requirements discipline.
---

# 144 — Sub-agent spawning: requirements for the run limit

The design that implements these requirements is in [`plan.md`](./plan.md).

Written after the feature shipped, so it is **not** a complete record of its
original requirements. It covers one part only: the limit on how many sub-agent
runs a session may have. Everything else about the feature is described in
`plan.md`. What is numbered here is what the user has stated, so that a later
change can be checked against it. Append as the user states more; do not
backfill from `plan.md`.

## Requirements

1. Work that runs with nobody present must not stop because a session reached a
   limit on the number of sub-agent runs in one turn.

2. Review agents have a limit similar to the one on child sessions: a number
   that can be in progress at the same time.

3. The limit must not stop a machine with plenty of memory from using it. A
   machine with little memory is the user's to handle: they ask the agent not
   to start many reviewers.

## Requirement provenance

All three come from the user on 2026-10-13, in their own words:

- Requirement 1: "3 subagent calls per turn seems prohibitive, often the works
  stops at night because of that and I wake up to unfinished work", and "in
  practice I've never \[seen\] the current limit helping, and a lot of times
  preventing work".
- Requirement 2: "how many child sessions can be in progress now? The review
  agents should have a similar limit".
- Requirement 3: "on a small RAM machine the user could ask the agent not to
  spawn many reviewers. But now on a big machine it is not possible to utilize
  it".

## Open questions

None.

## Resolved questions

- 2026-10-13 — Where should the number of runs in progress come from? The agent
  proposed a memory measurement. The user's answer is requirement 2: a limit
  similar to the one on child sessions in progress, which is 16 for each parent.
  The agent read "similar" as the same value and said so.
- 2026-10-13 — A run shares the memory of its session's container, and a child
  session has a container of its own, so 16 runs at once can be more than a
  small container holds. Should the number be lower because of that? The user's
  answer is requirement 3: no.
