---
status: planned
priority: medium
description: Support Codex's experimental /goal command in ShipIt by routing chat slash commands to the Codex app-server goal API and rendering goal state inline.
---

# Codex `/goal` command

## Problem

Codex CLI has an experimental `/goal` slash command in its TUI. In Codex's
native terminal UI, `/goal <objective>` creates a persistent objective for the
thread, starts goal-managed work, and keeps visible goal status in the footer
(`Pursuing goal (...)`, `Goal paused (/goal resume)`, etc.).

ShipIt does not run the Codex TUI. It talks directly to `codex app-server`
through `CodexAdapter`, so a user typing `/goal ...` in ShipIt chat currently
goes through the normal message path as plain model input. The TUI slash
command parser never runs.

Supporting this well matters for two reasons:

- It preserves a Codex-native workflow for users who already know the CLI.
- It lets ShipIt expose long-running objective state inline instead of asking
  users to switch to a terminal-shaped surface.

## Verified upstream behavior

Verified against ShipIt's pinned Codex package:

- Package: `@openai/codex@0.130.0` from `docker/agent-cli/package.json`.
- Binary package: `@openai/codex@0.130.0-linux-x64`.
- `codex features list` reports `goals` as `experimental` and disabled by
  default.
- Top-level CLI help does not list `/goal`; the command is a TUI slash command,
  not a normal CLI subcommand.
- `codex app-server generate-json-schema` includes goal notifications:
  `thread/goal/updated` and `thread/goal/cleared`.
- App-server requests for goals are accepted only when both conditions hold:
  `codex app-server --enable goals` and `initialize.capabilities.experimentalApi`
  is `true`.

With those gates enabled, these JSON-RPC methods work:

| Method | Behavior |
| --- | --- |
| `thread/goal/get` | Returns `{ goal: null }` or the current `ThreadGoal`. |
| `thread/goal/set` | Creates or updates the thread goal and emits `thread/goal/updated`. |
| `thread/goal/clear` | Clears the goal and emits `thread/goal/cleared`. |

`ThreadGoal` shape from the generated schema:

```ts
type ThreadGoal = {
  threadId: string;
  objective: string;
  status: "active" | "paused" | "budgetLimited" | "complete";
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
};
```

Observed runtime behavior:

- Calling `thread/goal/set` with an objective stores the goal and starts
  runtime-managed work for that thread.
- The app-server emits `thread/goal/updated` after set/update and
  `thread/goal/cleared` after clear.
- The TUI accepts `/goal <objective>` as the command form.
- Interrupting a running goal pauses it in the TUI and shows
  `Goal paused (/goal resume)`.

Open verification item: the exact app-server mechanism behind `/goal resume`.
The generated request schema exposes `thread/goal/get`, `thread/goal/set`, and
`thread/goal/clear`, but no obvious `thread/goal/resume` method. This likely
uses the runtime continuation path after reading the paused goal, and needs a
targeted probe before implementation.

## Product fit

Support this as a chat command, not as a button or quick action. The user should
type `/goal ...` in the composer, and ShipIt should handle the command inside
the existing chat/session flow.

This preserves ShipIt's product principle that chat is the input surface and
the agent is the actor. It also keeps Codex goal status inline in ShipIt rather
than pushing the user to the Codex terminal UI.

## Design

### 1. Enable the app-server feature

Update `CodexAdapter.run()` to spawn:

```ts
const args = ["app-server", "--enable", "goals"];
```

Update the `initialize` request to declare:

```ts
capabilities: { experimentalApi: true }
```

The `experimentalApi` capability is broader than goals, so this should be
treated as an explicit app-server protocol opt-in. Add a regression test that
the initialize payload includes the capability and the spawn args include the
feature flag.

### 2. Add adapter goal methods

Add goal operations to the Codex adapter, not to generic prompt steering:

- `getGoal()`
- `setGoal({ objective, tokenBudget? })`
- `clearGoal()`

These should call `sendRequest()` with `threadId: this.threadId`. They require
an initialized thread. If no thread exists yet, return a visible error to the
orchestrator rather than starting an unrelated thread implicitly.

Do not map `/goal` through `sendUserMessage()` or `writeStdin()`. Codex
steering uses `turn/steer`; goal control uses distinct JSON-RPC requests.

### 3. Proxy goal operations through the container boundary

Production ShipIt talks to session containers over HTTP. Mirror the existing
agent proxy chain:

- Session worker endpoint, e.g. `POST /agent/goal`.
- `worker-http.ts` helper.
- `ContainerSessionRunner` method.
- `ProxyAgentProcess` method.
- Shared `AgentProcess` interface additions or a Codex-specific capability
  wrapper.

Because goals are Codex-specific today, keep the generic interface small. A
reasonable first pass is an optional method on `AgentProcess`, guarded by
`agentId === "codex"` and a capability flag such as `supportsGoals`.

### 4. Intercept `/goal` in the message path

Intercept before normal turn dispatch for active Codex sessions:

| Chat input | Behavior |
| --- | --- |
| `/goal <objective>` | Call `thread/goal/set` with the objective. |
| `/goal status` | Call `thread/goal/get` and render current status. |
| `/goal clear` | Call `thread/goal/clear`. |
| `/goal resume` | Implement after verifying the app-server resume path. |

For non-Codex sessions, either pass the text through as normal or return a
small inline message that `/goal` is Codex-only. Prefer returning an inline
message only when the user typed exactly a recognized `/goal` command; avoid
blocking arbitrary prompts that happen to start with `/goal` unless we know how
to handle them.

The right interception point is the orchestrator WebSocket send-message path,
near the code that already resolves the active runner and agent. This keeps the
command in chat history and lets the server emit a normal assistant/system
message about the result.

### 5. Render goal state inline

Add a normalized server message or agent event for goal state:

```ts
{
  type: "agent_goal_updated",
  agentId: "codex",
  goal: {
    objective: string;
    status: "active" | "paused" | "budgetLimited" | "complete";
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
  }
}
```

Also support a clear event:

```ts
{ type: "agent_goal_cleared", agentId: "codex" }
```

Client display can start modestly:

- A compact inline message when the goal is set, cleared, or queried.
- A session-level status chip while a goal is active/paused.
- No separate command button.

### 6. Revisit Codex process lifetime

The current adapter kills the app-server process at `turn/completed` to match
the one-shot-per-turn Claude pattern. Goal mode can run continuation work and
maintain runtime state after `thread/goal/set`, so the process-lifetime model
needs careful validation.

Implementation should answer:

- Does `thread/goal/set` start a turn that completes normally and then needs
  app-server to stay alive for continuation?
- Can a paused goal be resumed after ShipIt kills and recreates the app-server?
- Is the persisted thread goal in Codex state enough to recover after a new
  app-server process starts?

Until this is verified, keep the first implementation narrow: set/get/clear and
render state. Gate automatic continuation/resume behavior behind explicit tests.

## Error handling

- If the Codex CLI rejects `--enable goals`, surface a clear adapter error and
  mark `supportsGoals` false for that process.
- If app-server returns `goals feature is disabled`, treat it as a configuration
  bug in the adapter and log the exact response.
- If `thread/goal/set` fails because no thread exists, ask the user to start the
  Codex session with a normal prompt first or create the thread explicitly as
  part of the command handler after a product decision.
- If a goal is already active, upstream `thread/goal/set` updates it. ShipIt
  should mirror that behavior unless product wants a confirmation step later.

## Tests

Adapter tests:

- Spawn args include `--enable goals`.
- Initialize request includes `capabilities.experimentalApi: true`.
- `thread/goal/updated` maps to a normalized ShipIt event.
- `thread/goal/cleared` maps to a normalized ShipIt event.
- Goal request methods send the expected JSON-RPC payloads.

Orchestrator integration tests:

- In a Codex session, `/goal Build X` calls the goal endpoint rather than
  starting a normal prompt turn.
- `/goal status` renders the current goal.
- `/goal clear` clears and renders confirmation.
- In a Claude session, recognized `/goal` input does not accidentally call the
  Codex path.

Client tests:

- Goal status renders active, paused, budget-limited, complete, and cleared
  states.
- Goal UI is passive status display only; no shell-shaped command button.

## Key files

- `src/server/session/agents/codex-adapter.ts` — app-server spawn args,
  initialize capabilities, goal request/notification handling.
- `src/server/session/agents/codex-adapter.test.ts` — adapter protocol tests.
- `src/server/shared/types/agent-types.ts` — optional goal capability/method
  typing if the interface is extended.
- `src/server/session/session-worker.ts` — container-side HTTP endpoint for
  goal operations.
- `src/server/orchestrator/worker-http.ts` — orchestrator HTTP helper.
- `src/server/orchestrator/proxy-agent-process.ts` — proxy delegation.
- `src/server/orchestrator/container-session-runner.ts` — runner method exposed
  to WebSocket handlers.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `/goal` chat command
  interception.
- `src/server/shared/types/ws-server-messages.ts` — normalized goal state
  message types if implemented as WS messages.
- `src/client/components/MessageList.tsx` or adjacent message rendering
  components — inline goal status display.

## Non-goals

- No command palette entry, toolbar button, or quick action for `/goal`.
- No generic slash-command framework in v1; intercept only the Codex goal
  command forms needed here.
- No attempt to mimic the full Codex TUI footer. ShipIt should render goal
  state in its own chat/session UI.
- No support for Claude goals unless Claude exposes an equivalent native
  primitive later.
