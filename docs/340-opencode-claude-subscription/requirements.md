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

## Open questions

None.

## Resolved questions

None yet.
