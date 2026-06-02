---
title: How to add a new agent backend
description: Step-by-step walkthrough for wiring a new agent (Cursor, Gemini, …) into ShipIt using the per-agent folder layout from docs/155.
---

# How to add a new agent backend

After [docs/155 Phase 5](../155-agent-abstraction-hairs/plan.md), every agent
backend lives behind two per-agent folders — one in the session worker layer,
one in the orchestrator layer — plus a handful of shared registry entries.
Adding Cursor, Gemini, or any other backend is mostly "create folder, fill in
the same files Claude/Codex have, add two registry entries." This doc walks
through the exact steps.

If something in this doc is wrong, treat it as a bug in the abstraction —
either the walkthrough is stale or the abstraction grew a new hair we haven't
named. Fix the abstraction before working around it.

## The seam

Every backend implements the same contract surface:

| Layer | What it owns | Interface |
|---|---|---|
| Session (`src/server/session/agents/<id>/`) | The CLI integration — spawning the process, parsing its output, writing its MCP config | `AgentProcess` |
| Orchestrator (`src/server/orchestrator/agents/<id>/`) | Auth flow, token refresh, subscription limits, run-params shaping, system-prompt fragment | `AgentAuthManager`, `LimitsProvider`, `PrepareRunParamsFn`, plus per-agent strings |
| Shared (`src/server/shared/agent-registry.ts`) | Capability fixtures: binary name, auth env key, MCP support flags, skills dir name, skill prefix | `AgentInfo` entry in `AGENT_DEFS` |
| Client | A theme palette and (if needed) UI strings | `client/themes/<id>.css` |

The orchestrator never knows which CLI is running — it talks to whatever the
adapter spawns through `AgentProcess` and over HTTP+SSE. The session worker
never knows about subscription pills, OAuth flows, or PR-creation hooks — it
just runs the agent and streams events.

## Step 1 — Widen the registry

Pick an `AgentId` slug. Use lowercase, no punctuation: `cursor`, `gemini`.

1. **`src/server/shared/types/agent-types.ts`** — add the slug to the
   `AgentId` union.
2. **`src/server/shared/agent-registry.ts`** — append one entry to
   `AGENT_DEFS`:

   ```ts
   {
     id: "cursor",
     name: "Cursor",
     binary: "cursor-agent",
     capabilities: {
       models: ["…"],
       supportsReview: false,
       supportsSteering: false,
       supportedPermissionModes: ["auto"],
       skillsDirName: ".cursor",
       skillInvocationPrefix: "/",
       // …other capability flags
     },
   }
   ```

   If the backend reads an env-var API key, also add the slug → env-key
   entry to `AUTH_ENV_KEYS` so `getAuthEnvKey()` finds it.

That's it for the registry. Every "what backends exist?" code path is now
aware of the new slug — `agentRegistry.list()`, the client agent picker, the
WS dispatch tables, etc.

## Step 2 — Session-side adapter

Create `src/server/session/agents/<id>/` with these files (skip the ones that
don't apply):

- **`adapter.ts`** — implements `AgentProcess` from `../agent-process.js`.
  This is the bulk of the work. The adapter:
  - Spawns the CLI process (child_process, node-pty, or whatever the wire
    protocol needs).
  - Parses its output into normalized `AgentEvent`s.
  - Implements `run()`, `kill()`, `interrupt()`, `writeMcpConfig()`, and the
    other interface methods.
  - Emits events: `event`, `done`, `error`, plus optional `running_state`.

- **`process.ts`** — only if the adapter wraps a separate low-level
  process helper (Claude uses one for its PTY abstraction; Codex spawns
  directly so it has no `process.ts`). Asymmetry is intentional —
  present-file-means-needed is clearer than empty stubs.

- **`mcp-writer.ts`** *(or whatever the MCP shape needs)* — colocated with
  the adapter. The adapter's `writeMcpConfig()` is called once per spawn;
  whether it writes JSON, mutates `config.toml`, or returns `runtimeEnv` is
  the adapter's call.

- **`tool-map.ts`** — exports the per-agent slice that `../tool-map.ts`
  merges into `AGENT_TOOL_MAPS`. Add one new entry to that file:

  ```ts
  import { CURSOR_TOOL_MAP } from "./cursor/tool-map.js";

  const AGENT_TOOL_MAPS: Record<AgentId, Record<string, CanonicalTool>> = {
    claude: CLAUDE_TOOL_MAP,
    codex: CODEX_TOOL_MAP,
    cursor: CURSOR_TOOL_MAP,
  };
  ```

- **`adapter.test.ts`** + any other unit tests, colocated.

Finally, **`src/server/session/session-worker.ts createWorkerAgent()`** —
the factory dispatches construction by `agentId`. Add the new case:

```ts
agentId === "cursor"
  ? new CursorAdapter()
  : agentId === "codex"
    ? new CodexAdapter()
    : new ClaudeAdapter(new ClaudeProcess());
```

The regression test in `session-worker-agent-factory.test.ts` will fail
until this is updated, which is the point.

## Step 3 — Orchestrator-side per-agent folder

Create `src/server/orchestrator/agents/<id>/` with these files:

- **`auth-manager.ts`** — implements `AgentAuthManager` from
  `../../agent-auth-manager.js`. Required methods: `start()`, `cancel()`,
  `signOut()`, `isConfigured()`, `kill()`. Required events: normalized
  `pending`, `complete`, `failed`. The auth flow itself (OAuth, device flow,
  API key, file login) is up to the backend — the interface only constrains
  the *lifecycle*.

  If the backend has no UX-flow auth (env-var-only, like Cursor v0), this
  file can be a minimal stub whose `start()` is a no-op and
  `isConfigured()` checks the env var.

- **`limits-provider.ts`** — implements `LimitsProvider` from
  `../types.js`. Returns a `SubscriptionLimits` snapshot for the header
  badge. Event-fed providers (Claude, Codex) capture the numbers from the
  adapter's `agent_rate_limits` event; pull-based providers can be added
  later. If the backend has no subscription pill, omit the file *and* the
  entry in `buildAgentRuntime()` — backends without a provider just don't
  render a pill.

- **`oauth-refresher.ts`** *(optional)* — only present if the backend has
  a centralized refresh loop (Claude does; Codex `docs/154-codex-oauth-refresh-readiness`
  may add one).

- **`run-params-prep.ts`** — exports a `PrepareRunParamsFn`. Identity is
  fine if the backend has no Claude-style settings file or
  `SHIPIT_AUTO_CREATE_PR` env-var wiring:

  ```ts
  import type { PrepareRunParamsFn } from "../../agent-run-params-prep.js";
  export const prepareCursorRunParams: PrepareRunParamsFn = (params) => params;
  ```

- **`system-prompt.ts`** — exports the "Parallel sessions" fragment for the
  agent's system prompt. Copy Codex's wording if the backend has no
  in-process subagent primitive; copy Claude's if it does. Backends without
  a fragment can omit the file and the entry; the call site in
  `agent-instructions.ts` falls back to the empty string.

- **`index.ts`** — barrel re-exporting everything above so
  `agents/index.ts buildAgentRuntime()` can import via `import * as cursor
  from "./cursor/index.js"`.

- Colocated tests.

## Step 4 — Wire it into `buildAgentRuntime()`

`src/server/orchestrator/agents/index.ts` builds the four runtime tables.
Adding Cursor is four new map entries:

```ts
import * as cursor from "./cursor/index.js";

export function buildAgentRuntime(deps): AgentRuntime {
  const authManagers = new Map<AgentId, AgentAuthManager>([
    ["claude", deps.authManager],
    ["codex", deps.codexAuthManager],
    ["cursor", deps.cursorAuthManager],
  ]);
  const limitsProviders = new Map<AgentId, LimitsProvider>([
    ["claude", new claude.ClaudeLimitsProvider(…)],
    ["codex", new codex.CodexLimitsProvider(…)],
    ["cursor", new cursor.CursorLimitsProvider(…)],
  ]);
  // …same for runParamsPreps and parallelSessionsSections
}
```

`BuildAgentRuntimeDeps` will need a `cursorAuthManager` field; the auth
manager itself is constructed in `app-di.ts` like the existing two.

## Step 5 — Add to `app-di.ts`

`src/server/orchestrator/app-di.ts`:

1. `import { CursorAuthManager } from "./agents/cursor/auth-manager.js";`
2. Add `cursorAuthManager?: CursorAuthManager;` to `AppDeps`.
3. Add `cursorAuthManager: CursorAuthManager;` to `ManagerSet`.
4. Construct it: `const cursorAuthManager = deps.cursorAuthManager ?? new CursorAuthManager();`
5. Add it to the returned object.
6. Add a `case "cursor":` to `buildLocalAgentFactory()`.

Then in `src/server/orchestrator/index.ts`, the existing
`buildAgentRuntime({ authManager, codexAuthManager })` call grows by one
arg:

```ts
const agentRuntime = buildAgentRuntime({
  authManager,
  codexAuthManager,
  cursorAuthManager,
});
```

Everything downstream — the runner registry, WS handlers, SSE event
wiring, shutdown hook — consumes the per-agent maps and so picks up the
new backend automatically.

## Step 6 — Client

Most of the client narrows on `AgentId` exhaustively, so TypeScript flags
the new case at compile time. The two manual edits:

- **`src/client/themes/cursor.css`** + **`cursor-light.css`** — copy
  `claude.css` and re-color. The theme switcher reads `AGENT_DEFS` at
  runtime; once the registry entry exists (Step 1), the dropdown shows the
  new option.
- **Local-storage validators / `isKnownAgentId()`** — runtime checks
  against `agentRegistry.list()`; widen if a hardcoded set lives somewhere
  outside `AgentId`.

If the backend has a unique auth UX (e.g. an API-key paste card), add the
component to the auth-manager's per-agent module folder under `client/` and
register it the same way as `CodexAuthCard`.

## Step 7 — Tests

The minimum bar before merging:

- Adapter unit tests (`agents/<id>/adapter.test.ts`) covering at least one
  successful turn and one error path.
- Limits-provider unit tests if the backend has a pill.
- Auth-manager unit tests covering `start()`, `cancel()`, `signOut()`, and
  the normalized `complete`/`failed` events.
- The `session-worker-agent-factory.test.ts` regression case for the new
  agent.
- A capability-flag test that the `skillsDirName` and
  `skillInvocationPrefix` are correctly populated.

## What you do NOT have to touch

The whole point of the per-agent folders is that this list is short:

- `ws-handlers/agent-listeners.ts` — already dispatches via `authManagers`,
  `runParamsPreps`, and the limits-registry map.
- `services/marketplace.ts`, `services/skills.ts`, `services/settings.ts` —
  consume capability flags via `agentRegistry`, not hardcoded branches.
- `agent-instructions.ts` — reads the parallel-sessions fragment from the
  runtime map.
- `session-agent-run-params.ts` — calls the per-agent prep hook via the map.
- `wireEventHandlers` / `shutdown-manager.ts` — iterate the auth-manager map.

If you find yourself editing one of these to make the new backend work,
stop. That's a hair that hasn't been cleaned up yet — file a new
docs/155-style entry instead of working around it.

The ESLint rule `no-restricted-syntax` in `eslint.config.js` enforces this
guardrail by flagging any new `agentId === "claude" | "codex"` (or the
`something.agentId === …` form) outside the per-agent folders. If your new
backend genuinely needs a per-CLI-shape branch in shared code (a real
CLI-shape difference, not a hair), add `eslint-disable-next-line
no-restricted-syntax -- <one-line rationale>` and link the doc that
documents the difference. Don't widen the exempt-folders glob.

## File-count target

At a glance, adding a new backend should touch roughly:

- **5 files outside the new per-agent folders**:
  `shared/types/agent-types.ts` (AgentId widening),
  `shared/agent-registry.ts` (one `AGENT_DEFS` entry),
  `session/session-worker.ts` (one factory case),
  `app-di.ts` (auth-manager construction),
  `orchestrator/index.ts` (one `buildAgentRuntime()` arg).
- **One new per-agent folder per layer** (session + orchestrator), plus
  the client theme files.

Anything more than that is a sign the abstraction is leaking. The success
criteria in `docs/155-agent-abstraction-hairs/plan.md` codifies this as
"≤5 files to touch outside the new per-agent folder."
