---
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

## Open questions

- In an ops session, does the ops block replace the general block, or is it
  added to it? And when the ops block is empty, does an ops session receive the
  general block, or no user instructions at all?
- A sandbox session also receives internal instructions of its own. Does a
  sandbox session get its own block too, or is the separate block only for ops
  sessions?

## Resolved questions

- (none yet)
