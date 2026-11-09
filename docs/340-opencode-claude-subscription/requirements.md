---
issue: planning#718
title: OpenCode on a Claude subscription — requirements
description: The OpenCode 1 and OpenCode 2 harnesses run Claude models on the user's Claude subscription login.
---

# OpenCode on a Claude subscription — requirements

Requirements for letting both OpenCode harnesses use a Claude subscription.
[plan.md](./plan.md) holds the design and the probe results.

Source: the user's 2026-11-09 instruction, "make opencode and opencode 2 work
with claude subscription in shipit", given after the session found that
OpenCode 2.2.3 added a built-in Claude Agent provider.

## Requirements

1. **OpenCode 2 on a Claude subscription.** A session or role on the OpenCode 2
   harness can run a Claude model using the user's Claude subscription sign-in
   — the same sign-in the Claude Code harness uses.
2. **OpenCode 1 on a Claude subscription.** The same holds for the OpenCode 1
   harness.
3. **Existing routes unchanged.** API keys and the ChatGPT subscription keep
   working on both OpenCode harnesses, and the Claude Code harness keeps
   working on the Claude subscription as before.
4. **Automatic harness choice.** When ShipIt picks a harness by itself, the
   reviewer may run a Claude model on the Claude subscription through either
   OpenCode harness. Background work prefers Claude Code whenever it is
   installed.

## Open questions

None.

## Resolved questions

- 2026-11-09 — Now that OpenCode can carry the Claude login, the reviewer's
  "different harness" rule can pick OpenCode for a Claude Code session when a
  Claude subscription is the only credential. Keep that? The user: "Allow
  OpenCode, but background work would prefer Claude code if it is installed."
  Recorded as req 4.
