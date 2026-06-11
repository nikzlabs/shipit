---
issue: https://linear.app/shipit-ai/issue/SHI-116
description: Fix the Claude/Codex model selector showing a stale "needs auth" after a revoked OAuth token silently recovers.
---

# Model selector stale "needs auth" after OAuth recovery

## Symptom

The Claude model selector sometimes shows **"needs auth"** and refuses to let
you change the model, even though the agent is running fine — i.e. the
credentials are actually valid. Reloading or switching sessions doesn't clear
it; only a manual sign-in does.

## Root cause

The selector's per-agent `authConfigured` flag (rendered by
`ModelAgentSelector.tsx`, driven by the `agent_list` SSE) is derived in
`AgentRegistry` from `ProviderAccountManager.hasAnyAuthForProvider()`, which is
true only when a provider-account row has `status === "ready"` (or an env key is
set). It is a cached snapshot, recomputed only on `AgentRegistry.refreshAuth()`.

The orchestrator-owned Claude OAuth refresher (docs/153) classifies a failed
token rotation. When the CLI output matches a terminal auth-failure pattern
(`invalid_grant`, `401 …`) it calls `emitUnauthenticated` → `account_unauthenticated`,
which `index.ts` wires to `markProviderAccountUnauthenticated`:

- sets the account row to `auth_failed`,
- calls `agentRegistry.refreshAuth("claude")` (now `false`),
- broadcasts `agent_list` → selector shows "needs auth". ✔ correct *at that moment*.

But the **recovery** was asymmetric. When a later tick rotated the token back to
healthy (`handleSuccess` with `wasUnauthenticated === true`), it only:

- cleared the in-memory `emittedUnauthenticated` flag, and
- emitted a `claude_account_authenticated` SSE that **nothing consumes**.

It never flipped the row back to `ready`, never called `refreshAuth`, and never
re-broadcast `agent_list`. So the row stayed `auth_failed` and the selector
stayed "needs auth" — while the agent kept working, because `handleSuccess`
re-pushes the (valid) rotated token into pinned sessions. Transient/misclassified
revokes (a brief blip whose CLI output happened to match a terminal pattern)
made this reachable without the token ever being truly dead.

## Fix

Add the missing recovery counterpart, mirroring the failure path:

- **`ClaudeOAuthRefresher` / `CodexOAuthRefresher`** emit a new
  `account_reauthenticated` event in `handleSuccess`, on the revoked → recovered
  transition only (inside the existing `if (wasUnauthenticated)` block, next to
  the `*_account_authenticated` SSE). Not fired on routine healthy rotations.
- **`markProviderAccountReauthenticated`** (`app-lifecycle.ts`) — symmetric to
  `markProviderAccountUnauthenticated`: flips the row to `ready`, calls
  `agentRegistry.refreshAuth`, and re-broadcasts `provider_accounts` + `agent_list`.
  Idempotent: a no-op when the row is already `ready`, so signaling recovery
  never forces a redundant broadcast.
- **`index.ts`** wires `refresher.on("account_reauthenticated", …)` for both
  Claude and Codex to that helper.

## Key files

- `src/server/orchestrator/agents/claude/oauth-refresher.ts` — `account_reauthenticated` event + emit in `handleSuccess`.
- `src/server/orchestrator/agents/codex/oauth-refresher.ts` — same, mirrored.
- `src/server/orchestrator/app-lifecycle.ts` — `markProviderAccountReauthenticated`.
- `src/server/orchestrator/index.ts` — listener wiring for both refreshers.
- `src/client/components/ModelAgentSelector.tsx` — renders `needs auth` from `authConfigured` (unchanged; consumer of the now-repaired `agent_list`).

## Tests

- `agents/{claude,codex}/oauth-refresher.test.ts` — `account_reauthenticated`
  fires on revoked → recovered, and NOT on a routine healthy rotation.
- `app-lifecycle.test.ts` — `markProviderAccountReauthenticated` flips
  `auth_failed` → `ready` + broadcasts, and is a no-op when already `ready`.

## Notes / follow-ups

- The fix repairs the **live** recovery path (the reported case). A separate,
  rarer edge — an orchestrator restart while a row is persisted `auth_failed` —
  resets the in-memory `wasUnauthenticated` flag, so the next healthy rotation
  won't signal recovery. The idempotent helper makes a future "emit on every
  success" widening safe if that edge needs covering.
