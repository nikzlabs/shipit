---
description: Quick Capture overlay derives the agent from the selected model so a stale vibe-agent-id can't pin a new session to the wrong agent.
---

# Quick Capture agent pin — derive agent from model

## Problem

The Quick Capture overlay created sessions pinned to the **wrong agent**
(Codex) even though the overlay UI showed Claude and the user hadn't used Codex
in days. The agent pin is write-once at session creation, so the user was then
stuck on Codex for that session and had to manually switch back to Claude every
time. Normal (non-quick) new sessions were unaffected.

This is a **client-side source-of-truth violation**, with a worthwhile
server-side defense-in-depth guard. It is distinct from the
"quick-session first turn exits 0 / agent never starts" spawn bug fixed on
branch `shipit/qttory` — that spawn bug merely *masked* this one (a failed
first turn produced no output, so the user never saw Codex run and only later
noticed the wrong pin).

## Root cause

The documented architecture (`src/client/utils/agent-for-model.ts` docstring;
docs/142 "agent-auth-recovery-and-model-source-of-truth", Problem C) is: **the
model is the single source of truth and the agent must be derived from the
model, never tracked independently.** Most of the app obeys this — e.g.
`useSessionWebSocket.ts` does `agentIdForModel(model, agentList) ?? getSavedAgentId()`.

`QuickCaptureOverlay.tsx` violated it:

- It tracked `selectedAgentId = getSavedAgentId()` (the `vibe-agent-id`
  localStorage key) as an **independent** source of truth.
- On submit it sent `agent: selectedAgentId` — not an agent derived from
  `selectedModel`.
- `selectedModel` came from `getSavedModelId()` (`vibe-model-id`), a *different*
  localStorage key.

Why the two keys disagree (the crux): in `ModelAgentSelector.handleModelSelect`,
the call that persists the agent (`onAgentChange` → `saveAgentId`) is gated
behind `if (!pinnedAgentId)`. In an already-pinned session (every working
Claude session is pinned to Claude after its first turn), picking a model
updates `vibe-model-id` but **does not** update `vibe-agent-id`. So a user who
explicitly picked Codex once in a new/unpinned context and has worked in Claude
since ends up with `vibe-agent-id="codex"` (stale) and `vibe-model-id=<a Claude
model>` (current).

In the overlay this produced:

- `selectedAgentId` = stale `"codex"`.
- `selectedModel` = a Claude model.
- The selector's label is model-derived, so **the UI showed Claude** — matching
  the report.
- On submit it sent `agent: "codex"`, and the server pinned it write-once.

Server pin path (write-once at creation, independent of the first turn):
`headless-sessions.ts` `const agentId = opts.agent ?? defaultAgentId` →
`prepareSessionAgentEnvironment` → `setAgentId` + `setAgentPinned`.
`defaultAgentId` resolves to `"claude"`, which is why a *dropped* agent locks to
Claude — Codex must have been sent explicitly.

## Fix

**Primary (client) — restore the model-source-of-truth rule in the overlay**
(`src/client/components/QuickCaptureOverlay.tsx`):

- Removed the independent `selectedAgentId` state. The displayed + sent agent is
  now `agentIdForModel(selectedModel, agentList) ?? getSavedAgentId()` — derived
  from the model, mirroring `useSessionWebSocket.ts`. Display and send are the
  same derived value, so they can never diverge again.
- `onAgentChange` still persists the picked agent (`saveAgentId` + ui-store) so
  the global preference stays in sync, but the overlay never reads
  `vibe-agent-id` back as an independent agent source.

**Defense-in-depth (server)** (`src/server/orchestrator/services/headless-sessions.ts`,
`src/server/shared/agent-registry.ts`):

- Added a server-side `agentIdForModel(model)` that maps a model to its owning
  agent via the static `AGENT_DEFS` model lists (mirrors the client util).
- `createHeadlessSession` now resolves the agent as
  `agentIdForModel(opts.model) ?? opts.agent ?? defaultAgentId`. When a
  recognized model is supplied, the model wins over a conflicting `opts.agent`,
  protecting any other/legacy caller of `POST /api/sessions/headless`. The
  `opts.agent ?? defaultAgentId` fallback is preserved for the no-model and
  unrecognized-model cases (e.g. versioned ids the picker doesn't surface).

The deeper latent issue (the gated `saveAgentId` in `handleModelSelect` letting
`vibe-agent-id` go stale) is intentionally left as-is to keep the change small;
the overlay no longer trusts that key, and the server guard catches any caller
that still sends a mismatch.

## Key files

- `src/client/components/QuickCaptureOverlay.tsx` — derive agent from model.
- `src/client/utils/agent-for-model.ts` — the architecture being restored.
- `src/client/hooks/useSessionWebSocket.ts` — the correct pattern that was mirrored.
- `src/server/shared/agent-registry.ts` — server `agentIdForModel`.
- `src/server/orchestrator/services/headless-sessions.ts` — server guard.

## Tests

- `src/client/components/QuickCaptureOverlay.test.tsx` — with a stale
  `vibe-agent-id="codex"` and a Claude model saved, the create request carries
  `agent: "claude"` (and the picker shows `claude`).
- `src/server/orchestrator/integration_tests/quick-capture-headless.test.ts` —
  `POST /api/sessions/headless` with a Claude model and conflicting
  `agent: "codex"` pins `agentId: "claude"`.

Reverting either fix makes the matching test bite.

## Follow-up — overlay picker inherited a background session's lock

A second, distinct symptom of the same "overlay reuses session-scoped UI"
class: in the quick-capture overlay the agent/model selector was sometimes
**locked to a single agent** (every other agent's rows disabled) even though the
new session hadn't started. Most visible on mobile, where quick-capture is the
primary way to start a session.

**Root cause.** `ModelAgentSelector` computes its cross-agent lock from the
*globally-active* session in the session store
(`currentSession?.agentPinned ? currentSession.agentId : undefined`). That is
correct for the in-session composer, but the overlay reuses the same picker to
start a **new** session and reads the same store. When a background session was
already pinned (it took its first turn on Claude/Codex), the overlay picker
inherited that pin and locked all other agents — for a session that didn't
exist yet. This is the *lock/disabled-rows* sibling of the *wrong-agent-sent*
bug above; the earlier fix corrected what got submitted, not the picker's
interactivity.

**Fix.** Gate the lock on `hasActiveSession`
(`src/client/components/ModelAgentSelector.tsx`). The overlay already passes
`hasActiveSession={false}`, the in-session composer passes `!!sessionId`. The
`pinnedAgentId` is now `hasActiveSession && currentSession?.agentPinned ? … :
undefined`, so a new-session picker never inherits a background pin while the
in-session `agentPinned`-based lock (other agents only, mid-session model
changes within the pinned agent still allowed) is unchanged. `hasActiveSession`
was previously read-but-unused (`_hasActiveSession`); it now drives the lock.

**Test.** `src/client/components/ModelAgentSelector.test.tsx` — with a pinned
background session in the store but `hasActiveSession={false}`, the other
agent's rows stay enabled.

## Related

- docs/142 — agent-auth-recovery-and-model-source-of-truth (Problem C).
- docs/138 — per-agent-credential-isolation (the `agentPinned` lock this gates).
- `shipit/qttory` — the separate quick-session spawn-flow fix (not touched here).
