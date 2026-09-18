---
issue: planning#545
title: Your Instructions — user-written agent instructions
description: What the user's own instructions must do, including a separate block for ops sessions whose internal instructions the general block can contradict.
---

# 014 — Your Instructions: requirements

What the user-written instruction blocks must do. The mechanism lives in
[`plan.md`](plan.md).

1. The user can write custom instructions in Settings. ShipIt sends them to the
   agent with every message, in addition to ShipIt's own built-in agent
   instructions.
2. The instructions are global. One set applies to every session. They are not
   per repository and not per session.
3. An empty box means ShipIt sends no user instructions. It does not send an
   empty instruction block.
4. An ops session takes its own instructions block, separate from the general
   one. ShipIt gives an ops session internal instructions of its own — the
   read-only host-debugging contract — and the general block can contradict
   them.
5. The user writes and edits the ops block in Settings, in the same place as the
   general block.
6. An ops session receives only the ops block. It never receives the general
   block. When the ops block is empty, an ops session receives no user
   instructions.
7. Only an ops session has a block of its own. Every other session kind,
   including a sandbox session, receives the general block.

## Open questions

- (none)

## Resolved questions

- 2026-09-13 — In an ops session, does the ops block replace the general block
  or add to it, and what happens when the ops block is empty? Answer: replace
  always. An empty ops block means an ops session receives no user
  instructions, not a fall back to the general block (req 6).
- 2026-09-13 — A sandbox session also receives internal instructions of its own.
  Does it get a block too? Answer: ops only (req 7).
