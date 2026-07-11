---
issue: https://linear.app/shipit-ai/issue/SHI-133
description: Remove the global "Authentication Required" OAuth overlay; an unauthenticated agent now blocks the turn with an error pointing to Settings → Agents, and the selector keeps disabling unauthenticated agents.
---

# Remove the global auth overlay — point to Settings instead

## The problem

When Claude ran without credentials, the orchestrator **auto-launched the OAuth
flow** (`claude /login`). That flow's verification URL was delivered to the
client over a **global SSE broadcast** (`agent_auth_pending`) and stored in a
**global** Zustand slice (`sessionStore.authUrl`). A standalone `AuthOverlay`
modal rendered whenever `authUrl !== null`.

The result: a sign-in modal popped up in **every open browser window**, not just
the tab driving the session that needed auth. A second window doing unrelated
work was interrupted by a blocking overlay for a session it had nothing to do
with.

Two server paths auto-launched the flow:

- **Pre-flight gate** — `ensureActiveAgentAuthenticated()` in
  `ws-handlers/send-message.ts`, when a `send_message` arrived for an
  unauthenticated Claude session.
- **Mid-turn 401** — `surfaceReauth()` in `ws-handlers/agent-listeners.ts`, when
  the CLI emitted `auth_required` during a turn (token expired/revoked).

Notably, the **Codex** branch of the same pre-flight gate already did the right
thing: it returned an actionable error ("Sign in to Codex or add OPENAI_API_KEY
in Settings → Agents") and never auto-launched a flow. The two backends were
inconsistent.

## The decision

Make Claude behave like Codex. **Do not auto-launch the interactive OAuth flow**
on an unauthenticated run. Authentication lives in **Settings → Agents** (the
`ClaudeAuthCard` / `CodexAuthCard` already host the full OAuth + API-key flows),
and the **model selector already disables unauthenticated agents**
(`ModelAgentSelector` — `isAvailable = installed && authConfigured`, plus a
"needs auth" badge). An unauthenticated turn is simply **blocked with an error**
that points the user to Settings.

This was a deliberate product choice (chat conversation): the alternatives
considered were (a) an inline, session-scoped re-auth prompt and (b) only
fixing the broadcast scope while keeping the overlay. We chose the simplest —
disable + point to Settings — because the selector already disables and the
Settings cards already host auth, so the overlay was redundant surface.

## What changed

### Server

- **`ws-handlers/send-message.ts`** — the Claude branch of
  `ensureActiveAgentAuthenticated()` no longer calls `startOAuthFlow()`. It
  sends `{ type: "error", message: "Claude is not authenticated. Sign in to
  Claude or add ANTHROPIC_API_KEY in Settings → Agents." }` (mirrors Codex) and
  returns `false`.
- **`ws-handlers/agent-listeners.ts`** — `surfaceReauth()` (the mid-turn 401
  handler) no longer calls `mgr.start()` / `authManager.startOAuthFlow()`. It
  emits an agent-neutral error pointing to Settings. It **still** calls
  `onAgentAuthRequired(failingAgentId)`, which nudges the per-agent **silent**
  OAuth refresher (not the interactive overlay) — on a genuine revocation that
  refresher broadcasts `agent_auth_failed reason:revoked`, which already
  produces the "Sign in" toast that opens Settings → Agents. The docs/179
  silent auto-recovery path (`willRecoverAuth` / `recoverAuth`) is untouched.
- **`services/agent.ts`** — the HTTP-dispatch auth gate's Claude error copy now
  matches ("… add ANTHROPIC_API_KEY in Settings → Agents").

`startOAuthFlow()` now runs **only** from user-initiated entry points:
`POST /api/auth/start` (Settings "Sign in"), the onboarding wizard, and the
provider-account add flow (`provider-account-manager.ts`).

### Client

- **Deleted** `components/AuthOverlay.tsx` (the standalone modal) and its test.
- **`AuthOverlay.tsx`** (container) no longer renders the modal; it only gates
  the `OnboardingWizard`. `authUrl` is still threaded to onboarding's Claude
  sign-in step (the one place an inline OAuth prompt is intentional). The
  popup-only props (`onPasteCode`, `onApiKey`, `onDismissAuth`) were removed.
- **`App.tsx`** drops those three props from the `AuthOverlayContainer` call.

The `agent_auth_pending` SSE event and `sessionStore.authUrl` remain — they now
feed only the Settings card's inline Step 1 / Step 2 view and onboarding. The
`auth_required` **WS server message** type and its no-op client handler remain
but are no longer emitted by the server (left in place to avoid churning the
discriminated server-message union).

### Claude auth diagnostics

The Claude Settings card also receives a progressive diagnostic stream for the
current or most recent `claude /login` attempt. This is deliberately secondary
UI: the card first renders structured progress (`starting`, `waiting_for_cli`,
`waiting_for_url`, `waiting_for_code`, `checking_credentials`, `complete`,
`failed`) and only then offers a collapsed **Claude CLI output** disclosure with
sanitized, chronological ShipIt/CLI observations.

Two SSE events carry the diagnostics:

- `agent_auth_progress` — `{ agentId, accountId?, attemptId, phase, message, elapsedMs? }`
- `agent_auth_log` — `{ agentId, accountId?, attemptId, timestamp, level, source, message }`

`AuthManager` sanitizes diagnostic text before emitting either event. The
sanitizer strips ANSI and redacts OAuth URL query strings, token/code-like
assignments, bearer/API-key values, email addresses, and credential paths. The
existing `agent_auth_pending` event still carries the full verification URL
because the sign-in button needs it, but diagnostics never do.

The client keeps a bounded 200-entry buffer in `settings-store` and preserves
the last failed attempt so users can copy useful details after a failed or
oddly-exited CLI run. A new auth attempt replaces the previous buffer.

## Key files

- `src/server/orchestrator/ws-handlers/send-message.ts` — pre-flight auth gate
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `surfaceReauth()`
- `src/server/orchestrator/services/agent.ts` — HTTP-dispatch auth gate
- `src/client/AuthOverlay.tsx` — onboarding gate (modal removed)
- `src/client/components/ModelAgentSelector.tsx` — disables unauthenticated agents
- `src/client/components/ClaudeAuthCard.tsx` / `CodexAuthCard.tsx` — Settings auth flows
- `src/server/orchestrator/agents/claude/auth-diagnostics.ts` — Claude auth diagnostic redaction/types
- `src/client/stores/settings-store.ts` — bounded Claude auth diagnostic buffer
- `src/client/hooks/useServerEvents.ts` — auth progress/log SSE handlers

## Tests

- `integration_tests/claude-auth.test.ts` — unauthenticated `send_message`
  returns an `error` pointing to Settings (not `auth_required`, no OAuth launch).
- `integration_tests/auth-401-auto-retry.test.ts` — the heal-fails surface path
  emits an `error` and does **not** call `startOAuthFlow`; the silent-heal path
  is unchanged.
- `ws-handlers/agent-listeners.test.ts` — both surface paths emit a Settings
  error and never call `startOAuthFlow`.
- `integration_tests/prompt-queuing.test.ts` — mid-turn `auth_required` still
  tears the turn down; the client now receives an `error`.
- `agents/claude/auth-manager.test.ts` — diagnostic emission + sanitizer redaction.
- `ClaudeAuthCard.test.tsx` / `useServerEvents.test.ts` — status rendering,
  expandable diagnostics, copy action, and failed-attempt retry state.

## Known residual

If two browser windows both have Settings → Claude open and one starts the OAuth
flow, the other's card also flips to the pending Step 1/2 view (because
`authUrl` and `authConfigured` are global). This is non-blocking and far
narrower than the old every-window modal; scoping `agent_auth_pending` per
connection is a possible follow-up but was out of scope for this change.
