---
issue: planning#365
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

## Follow-up — deriving the harness left the harness picker with nothing to write

The fix above assumed what its own key file says: "the model dropdown is the
only model/agent control in the UI — there is no standalone agent switcher".
docs/252 built one. From then on, tapping **Codex** in a quick session did
nothing at all: `onAgentChange` wrote `vibe-agent-id` and the ui-store, the
overlay derived the harness from the (unchanged) model, and the derivation
handed the previous harness straight back — to the display *and* to the
creation params. The in-session composer gets away with a bare `set_agent`
because the server re-resolves that session's model for the new harness; a
quick session has no session to send it to, so the model it is created with is
the last word.

Three things were wrong, and all three are fixed:

- **A harness pick now moves the model onto that harness.** It KEEPS the current
  model when the new harness runs it — a harness switch is not a model switch,
  and the shared models below are exactly the ones both harnesses offer — with
  the same `(service, billing mode)` preferred so the switch cannot silently
  re-bill an identical id through another service. Only when the harness cannot
  run it does the model become that harness's first eligible row, which is what
  the model picker itself falls back to (`rows[0]`). Nothing about the "model is
  the source of truth" rule changes: the pick is expressed *in* the model, which
  is the only thing the creation path carries.
- **A model no longer decides the harness when both can run it.** docs/252 also
  ended "each model belongs to exactly one agent" — `deepseek-v4-flash` and
  `deepseek-v4-pro` are in both harnesses' model lists today, and
  `agentIdForModel` answers with whichever agent sorts first. On such a model
  the harness pick was unwinnable. `newSessionAgentId` now lets the saved
  harness break that tie, and only that tie: a model only one harness runs still
  overrides a stale saved harness (Problem C above), and a saved harness this
  deployment did not install — or that has no credential — never wins it.
- **The server was discarding the pick after the client honoured it.** The
  defense-in-depth guard added above resolves
  `agentIdForModel(opts.model) ?? opts.agent`, so for a shared model it returned
  Claude and overrode an explicit `agent: "codex"` — write-once, at creation.
  That guard exists for a caller whose agent *disagrees* with its model; a
  caller naming a harness that runs the model is not that case, so an explicit
  agent that can run the submitted model is now honoured. Everything else, and
  the installed-harness fallback after it (req 14), is unchanged.

The overlay also stopped re-implementing `newSessionAgentId` and now calls it,
so the harness the picker displays and the harness the session is created on
cannot drift apart — which is the same failure this doc opened with, one level
up.

Tests: `QuickCaptureOverlay.test.tsx` (a picked harness reaches the creation
params, with its own model; and a shared model survives the switch),
`new-session-agent.test.ts` (the tie-break, that it stays a tie-break, and that
an uninstalled or credential-less harness never wins it),
`quick-capture-headless.test.ts` (the server honours a harness that can run the
submitted model, and still overrides one that cannot).

## Second follow-up — the composer had the same bug, one step later

The follow-up above fixed the harness pick in Quick Capture and left the
composer alone, on the reasoning quoted there: the in-session composer "gets
away with a bare `set_agent` because the server re-resolves that session's model
for the new harness". That is true of the SESSION and false of the SEED. The
server never touches the browser's `vibe-model-id`, and `useUiStore.reset()` —
which runs on every new session and every session switch — recomputes
`activeAgentId` from it via `newSessionAgentId`. So a harness picked in the
composer held for exactly as long as the page did, and the user's next session
derived the old harness again. Reported as "the dropdown in the new session
always switches from Claude to Codex", which is what it looks like from outside:
the pick appears to work, and is gone by the next session.

The rule is now one function, `persistHarnessPick`
(`client/utils/harness-seed.ts`), called by the composer and by Quick Capture —
a third copy is how the two would have drifted apart on exactly the models it
exists for. `modelRowsFor` moved to `client/utils/model-rows.ts` so a plain
module and a hook can reach it without importing the picker's React tree.

The in-session half is deliberately unchanged: `set_agent` remains the only
thing that moves a live session's model, so the server stays the sole authority
on what a session runs. What the composer now also writes is the answer to a
different question — what the NEXT session will be created on.

Tests: `harness-seed.test.ts`, including the regression itself (a pick still
names its harness after `useUiStore.reset()`) and its counter-example (writing
only the harness key fails the same way the bug did).

## Related

- docs/142 — agent-auth-recovery-and-model-source-of-truth (Problem C, and the
  auth redirect whose one-way persistence is fixed there).
- docs/138 — per-agent-credential-isolation (the `agentPinned` lock this gates).
- `shipit/qttory` — the separate quick-session spawn-flow fix (not touched here).
