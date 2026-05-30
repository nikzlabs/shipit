---
status: planned
priority: medium
title: Native goal command (CLI-backed)
description: Expose `/goal` in chat by adapting each backend CLI's native goal feature — Codex's stable `thread/goal/*` JSON-RPC API (from 0.133.0); Claude has no programmatic surface yet. Finishable once Codex ≥0.133.0 is pinned.
---

# Native goal command (CLI-backed)

## Problem

ShipIt should support `/goal …` in chat: set a long-running objective, view
it, pause/resume it, and clear it. Rather than build a ShipIt-managed
substrate that re-implements goal state ourselves (the rejected
[docs/153](../153-goal-command/plan.md) design), this doc adapts the goal
features the agent CLIs already ship natively. The CLI owns persistence,
budget tracking, and the model-side goal tools; ShipIt is a thin transport
and rendering layer.

This is the [docs/132](../132-slash-commands/plan.md) Bucket-4 command
`/goal`, implemented via the native-CLI path that became viable once the
backends grew programmatic goal APIs.

## Backend support

| Backend | Native `/goal` API | Status for ShipIt |
|---|---|---|
| **Codex CLI** | Yes — stable, on-by-default JSON-RPC from **0.133.0** | Implementable once the pin reaches ≥0.133.0 |
| **Claude Code CLI** | No programmatic surface (TUI-only) | Not supported yet — see below |

### Codex

Codex goal mode is a documented, stable JSON-RPC surface as of CLI
**0.133.0** (on-by-default; previously experimental). The relevant API:

- Requests: `thread/goal/get`, `thread/goal/set`, `thread/goal/clear`.
- Notifications: `thread/goal/updated`, `thread/goal/cleared`.
- Codex owns persistence in its own store (status `active | paused |
  budget_limited | complete`, optional token budget, running usage).
- Model-side tools: `create_goal`, `update_goal`, `get_goal`.

Because Codex persists the goal and drives the cross-turn loop itself,
ShipIt's adapter is thin: forward set/get/clear/pause/resume, subscribe to
the `updated`/`cleared` notifications, and render the goal inline in chat.

### Claude

Claude Code's `/goal` is a session-scoped, Stop-hook-backed slash command
that only runs in the interactive REPL. It does **not** dispatch through
`claude -p` or stream-json input, and there is no SDK/CLI surface for it.
Until Anthropic exposes a programmatic API, ShipIt cannot adapt it — `/goal`
is simply unavailable on the Claude backend. The composer autocomplete and
capability map should reflect this (no `/goal` entry when the active agent is
Claude). If Claude later ships an API, add a Claude branch to the adapter
layer here.

## Blocked on: Codex pin ≥ 0.133.0

The agent CLIs are installed from a committed lockfile at the version pinned
in `docker/agent-cli/package.json` (see
[docs/141](../141-cli-version-strategy/plan.md)). Today that pin is Codex
**0.130.0** — below the 0.133.0 that makes goal mode a stable API. This doc
**cannot be completed or implemented** until the pin advances to ≥0.133.0
(bumped by Renovate, gated on the Axis-3 CLI contract test).

When the pin lands, finish this doc by filling in:

- `CodexAdapter` calls for `thread/goal/{get,set,clear}` and the
  `updated`/`cleared` notification handlers (verify the exact request/response
  shapes against the pinned binary — the rejected doc's notes were taken
  against pre-stable builds and must be re-confirmed).
- The capability flag on `AgentCapabilities` so the composer only offers
  `/goal` (and `/goal pause` / `/goal resume`) when the active agent supports
  it.
- The interception in `send-message.ts` (Bucket-4 path) routing `/goal …`
  to the adapter rather than sending it as a literal prompt.
- WS server messages for goal updates and the inline chat chip/card.
- Whether the persistent-process keep-alive interactions documented in
  docs/153 are needed here, or whether Codex's own cross-turn loop makes
  them unnecessary (likely the latter, since Codex owns the loop).

## Relationship to docs/153

[docs/153](../153-goal-command/plan.md) is the **rejected** ShipIt-managed
substrate design — it re-implements goal state inside ShipIt. This doc is the
opposite approach: adapt the CLI's own goal engine. 153 is retained only as a
reference for a hypothetical future where ShipIt must own goal mode
end-to-end (e.g. a Go re-implementation, or a backend with no native API).
For the foreseeable product, this doc (154) is the live path.

## Key files (to wire when unblocked)

- `docker/agent-cli/package.json` — the Codex pin that gates this work.
- `src/server/session/agents/codex-adapter.ts` — `thread/goal/*` calls +
  notification handling.
- `src/server/shared/types/agent-types.ts` — `AgentCapabilities` goal flag.
- `src/server/orchestrator/ws-handlers/send-message.ts` — Bucket-4
  interception of `/goal`.
- `src/client/components/MessageInput.tsx` — `/` autocomplete entry,
  capability-gated.
- `docs/132-slash-commands/plan.md` — governing slash-command classification.
