---
issue: https://linear.app/shipit-ai/issue/SHI-186
title: Per-agent reasoning controls
description: Two reasoning/effort controls — a global per-agent default (Settings, governs sub-agents) and a per-session composer control (governs the active session's turns).
---

# Per-agent reasoning controls

## Context

ShipIt lets the user pick a model per agent (Claude, Codex) but has **no** way to
control how hard the agent *reasons*. Both backends expose a reasoning/effort
knob, named and valued differently per agent:

- **Claude Code CLI** — `--effort <level>`; valid values `low, medium, high, xhigh, max`
  (omit the flag → the model's adaptive default). *Verified by running `claude --effort __bogus__`,
  which printed `Valid values: low, medium, high, xhigh, max`.*
- **Codex CLI** — config key `model_reasoning_effort`; valid values
  `none, minimal, low, medium, high, xhigh` (omit → Codex's own default). *Verified by running
  `codex -c model_reasoning_effort=__bogus__`, which printed `expected one of none, minimal, low,
  medium, high, xhigh`.*

There is currently **zero** reasoning handling anywhere in the codebase.

## Two controls, two scopes

There are **two** independent reasoning controls, because the two places an agent
runs have different ownership:

| Control | Where | Scope | Governs | Source of truth |
|---|---|---|---|---|
| **A — Sub-agent default** | The agent's own Settings tab (`ClaudeTab`/`CodexTab`), beside its connection/auth card | Global, **per agent** | **Sub-agent** spawns (`shipit agent run --agent <id>` from inside another session) — these run server-side with no composer UI | `CredentialStore` map (server) |
| **B — Session control** | Composer, below the input field | **Per session** (scoped to the session's active agent) | The **active session's own turns** | Session DB row + per-agent localStorage seed (mirrors model selection) |

They are **independent**: the per-agent Settings value does *not* drive the main
session's turns, and the composer value does *not* drive sub-agents. A sub-agent
invoked from a session uses **control A** for the invoked agent; the session's own
agent uses **control B**.

### Control A is a per-agent "Sub-agent defaults" group

Control A lives on each agent's existing Settings tab — the page that already
holds that agent's connection/auth info (`ClaudeAuthCard` + `ProviderAccountSection`
in `ClaudeTab.tsx` / `CodexTab.tsx`). It is framed as a **"Sub-agent defaults"**
section: the settings a *parent* agent's sub-invocation of *this* agent should
run with. Reasoning effort is the first member; a **default model** for the
sub-agent invocation is the natural next member of the same group (sub-agents
otherwise fall back to the agent's `models[0]`). The server store is therefore
shaped to grow — keep the per-agent sub-agent settings together rather than as a
single scalar.

Both controls share the **same per-agent option metadata** and the **same
spawn-time plumbing** (`AgentRunParams.reasoningEffort` → CLI flag); only the
*source* of the value differs by code path.

### Per-agent option metadata (registry-driven)

Add a `reasoning` block to `AgentCapabilities` in
`src/server/shared/agent-registry.ts` so the option set is agent-defined and flows
to the client via the existing `agent_list` SSE broadcast (which already carries
`models`):

```ts
reasoning?: {
  label: string;                                 // "Reasoning" (claude) | "Reasoning effort" (codex)
  options: { value: string; label: string }[];  // does NOT include the default
}
```

- `claude`: `low, medium, high, xhigh, max`
- `codex`: `none, minimal, low, medium, high, xhigh`

Both UIs prepend a **"Default"** entry (selected when no value is stored) → stores
nothing / passes no CLI flag, so each backend uses its own native default.

## Shared spawn plumbing

1. **Type** — add `reasoningEffort?: string` to `AgentRunParams`
   (`src/server/shared/types/agent-types.ts`). `undefined` = pass no flag.
2. **Claude adapter** (`session/agents/claude/process.ts`): add `reasoningEffort` to
   `ClaudeRunOptions`; `if (reasoningEffort) args.push("--effort", reasoningEffort)` in **both**
   the PTY and streaming arg builders. `claude/adapter.ts` forwards `params.reasoningEffort`.
3. **Codex adapter** (`session/agents/codex/adapter.ts:260`): build spawn args as
   `reasoningEffort ? ["-c", \`model_reasoning_effort=${reasoningEffort}\`, "app-server"] : ["app-server"]`.
   `-c` is a global flag applied at app-server startup (consistent with the file's existing
   "config from app-server startup" note). Thread `reasoningEffort` from the run params into the spawn.

## Control A — Sub-agent defaults (per-agent Settings tab → sub-agents)

1. **Store (extensible shape)** — `CredentialStore` (`orchestrator/credential-store.ts`): add
   `agentSubAgentDefaults?: Record<string, { reasoningEffort?: string }>` — a per-agent object so the
   group can grow (a default `model` is the planned next member; sub-agents otherwise use `models[0]`).
   Accessors `getAgentSubAgentDefaults(agentId)` and `setAgentSubAgentDefaults(agentId, partial)`
   (merge; `reasoningEffort: null`/undefined clears → default), each calling `save()`. Persists to the
   global `/credentials/shipit-credentials.json`, alongside `autoCreatePr`, `enableSubAgents`, etc.
2. **Global settings surface** — add `agentSubAgentDefaults` to the `GlobalSettings` type and to
   `getGlobalSettings()` / `saveGlobalSettings()` (`orchestrator/services/settings.ts`); extend
   `PUT /api/settings` (`api-routes-bootstrap.ts`) to accept a partial map and merge per-agent.
   Returned in `/api/bootstrap`.
3. **Validation** (`orchestrator/validation.ts`): agentId must be registered and `reasoningEffort`
   must be in that agent's `reasoning.options` (or null). Reject with `ServiceError(400, …)`.
4. **Sub-agent run-params** — thread `reasoningEffort` through `buildSubAgentRunParams`
   (`src/server/shared/sub-agent-run.ts`) / `runSubAgent` (`services/sub-agent.ts`), sourced from
   `getAgentSubAgentDefaults(subAgentId).reasoningEffort` so the invoked backend gets **its own** default.
5. **Settings UI** — add a **"Sub-agent defaults"** section to each agent's tab
   (`Settings/tabs/ClaudeTab.tsx`, `CodexTab.tsx`), beside the auth card. It renders that agent's
   `reasoning.options` (+ "Default") and writes the map via the settings store → `PUT /api/settings`.
   Built to host the future default-model selector in the same section.

## Control B — Session control (composer → active turns)

Mirror model selection (`docs/142`/`docs/166`), which already persists per-session in the DB and
seeds new sessions from localStorage.

1. **Session persistence** — add a `reasoning_effort TEXT` column to `sessions`
   (`shared/database.ts` migration); read/write in `orchestrator/sessions.ts` (`fromRow`,
   `setReasoning`), exactly like `model`.
2. **WS message** — add `set_reasoning` (`ws-client-messages.ts`) handled in the dispatch alongside
   `set_model`: validate against the active agent's options, persist via `sessionManager.setReasoning`,
   and hold the value in per-connection state for the turn.
3. **User-turn run-params** — `session-agent-run-params.ts` `buildAgentRunParams`: set
   `reasoningEffort` from the per-connection / per-session reasoning value (agent already resolved here).
4. **Agent-switch self-heal** — pre-pin, if the stored value isn't valid for the newly-selected
   agent's options, reset to default (same self-heal model selection already does).
5. **Composer UI** — new `components/ReasoningSelector.tsx` placed **next to** `ModelAgentSelector`
   in the composer toolbar. Reads the active agent the same way `ModelAgentSelector` does, renders
   that agent's `reasoning.options` (+ "Default"), shows the current per-session value, sends
   `set_reasoning` on change, and seeds new sessions from a per-agent localStorage key
   (`shipit-reasoning-<agentId>`) so switching agents restores each agent's last composer pick.
   Hidden when the active agent has no `reasoning` capability.

## Notes / known limitation

Reasoning is a spawn-time argument. Codex (one app-server per turn) and the non-streaming Claude path
pick up a change on the very next turn. With Claude **live steering** (a resident
`--input-format stream-json` process, docs/140) a change applies when that process next respawns —
the same characteristic model selection already has. Acceptable; no special handling.

## Key files

- `src/server/shared/agent-registry.ts` — `reasoning` capability metadata + values (shared by both controls)
- `src/server/shared/types/agent-types.ts` — `reasoningEffort` on `AgentRunParams`
- `src/server/session/agents/claude/process.ts` + `adapter.ts` — `--effort`
- `src/server/session/agents/codex/adapter.ts` — `-c model_reasoning_effort=`
- **Control A:** `orchestrator/credential-store.ts`, `services/settings.ts`, `api-routes-bootstrap.ts`,
  `validation.ts`, `shared/sub-agent-run.ts`, `services/sub-agent.ts`,
  `client/components/Settings/tabs/ClaudeTab.tsx` + `CodexTab.tsx` (new "Sub-agent defaults" section)
- **Control B:** `shared/database.ts`, `orchestrator/sessions.ts`, `ws-client-messages.ts` + dispatch,
  `session-agent-run-params.ts`, `client/components/ReasoningSelector.tsx`, `client/stores/settings-store.ts`
- Co-located `*.test.ts` for each touched module (see checklist.md).

## Verification

Full suite / integration tests OOM in-session — verify with `npm run typecheck`, `npm run lint:dev`,
and targeted co-located unit tests (`npx vitest run <file>.test.ts`). Browser-check both controls:
the Settings per-agent default and the composer control beside the model selector, each showing
Claude's `low…max` vs Codex's `none…xhigh`. Spot-check spawned commands: a Claude turn includes
`--effort <level>`; a Codex turn spawns with `-c model_reasoning_effort=<level>`; "Default" passes
neither. Confirm a Claude session that invokes Codex as a sub-agent uses the **global** Codex
reasoning (control A), independent of the composer value (control B).
