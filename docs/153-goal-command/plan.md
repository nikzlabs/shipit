---
status: planned
priority: medium
title: Goal command
description: Support provider-native goal commands in ShipIt chat — Codex's experimental app-server goal API and Claude's session-scoped Stop-hook goal slash command.
---

# Goal command

## Problem

ShipIt should support provider-native "goal" workflows in chat without adding a
new command surface. Both supported CLIs ship a `/goal` slash command today —
Codex CLI as an experimental TUI command backed by an app-server JSON-RPC API,
and Claude Code as an interactive slash command backed by a session-scoped
Stop hook. They look the same in chat but use very different mechanisms, and
ShipIt has to handle each on its own terms.

## Codex design

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

### Verified upstream behavior

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

## Claude design

Claude Code also ships a `/goal` slash command, but the mechanism is not an
app-server JSON-RPC API. It is a slash command processed inside the running
`claude` CLI itself, implemented on top of the existing hook system. The CLI
registers a session-scoped Stop hook with the supplied condition, evaluates it
after every turn, and surfaces achievement/cleared state as system messages in
the same stream ShipIt already consumes.

This is significant for ShipIt because there is nothing to call. The agent
already does the work as long as the user's input reaches the CLI verbatim and
the surrounding flags don't suppress slash-command or hook processing.

### Verified upstream behavior

Verified against ShipIt's pinned Claude CLI:

- Package: `@anthropic-ai/claude-code@2.1.140` from `docker/agent-cli/package.json`,
  resolved to the platform-specific ELF binary
  (`@anthropic-ai/claude-code-linux-x64/bin/claude.exe`).
- `claude --help` does not list `/goal`; the command is an interactive slash
  command, not a CLI subcommand. There is no `claude goal …` entry point and
  no JSON-RPC analogue to Codex's `thread/goal/*` methods.
- Slash-command dispatch is on by default. The CLI accepts a
  `--disable-slash-commands` flag, and ShipIt's spawn args
  (`src/server/session/claude.ts`) deliberately do not pass it.

Command forms observed in the CLI strings:

| Chat input | Behavior |
| --- | --- |
| `/goal <condition>` | Set or replace the goal. CLI emits `Goal set: <condition>` and announces `A session-scoped Stop hook is now active with condition: …`. |
| `/goal active` | Print the current goal (`Goal active: <condition>`) or `No goal set`. |
| `/goal clear` | Drop the goal. CLI emits `Goal cleared: <condition>`. |
| `/goal` (no args) | Help fallback: `No goal set. Usage: \`/goal <condition>\``. |

Other observed behavior:

- After each turn's Stop hook fires, if the condition is satisfied the CLI
  emits `Goal achieved` and reports telemetry `tengu_goal_achieved` /
  `goal_met`. The session-scoped Stop hook is then torn down.
- The transcript persists the goal. On `--resume`, the CLI restores it via
  `findGoalToRestore` / `restoreGoalFromTranscript` and emits telemetry
  `tengu_goal_restored_on_resume`.
- The condition string has a length cap (`Goal condition is limited to …`).
- Two hard preconditions block `/goal`:
  - `"/goal is only available in trusted workspaces. Restart, accept the trust dialog, and try again."`
  - `"/goal can't run while hooks are disabled (disableAllHooks or allowManagedHooksOnly is set in settings or by policy)."`

Unlike Codex's `/goal`, Claude has no pause/resume primitive and no token-budget
knob. The model is "session-scoped Stop hook with a condition" — set, cleared,
or achieved.

### ShipIt context

Three things have to stay true for Claude's `/goal` to work end-to-end inside
ShipIt:

1. **The text reaches the CLI verbatim.** ShipIt spawns Claude with
   `--input-format stream-json --output-format stream-json --print` (see
   `src/server/session/claude.ts`). Slash-command dispatch runs on stream-json
   user messages just as it does on TUI input, so `/goal …` typed in the
   composer arrives at the CLI's slash-command processor unchanged. ShipIt
   must not strip or rewrite leading `/`.
2. **Hooks are enabled.** ShipIt already relies on a managed Stop hook for
   auto-PR (docs/130) and does not pass `--bare`, so `disableAllHooks` /
   `allowManagedHooksOnly` are not in effect. If we ever add `--bare` for a
   mode, `/goal` must visibly degrade.
3. **The workspace is trusted.** ShipIt runs Claude non-interactively
   (`-p`/print), which already bypasses the trust dialog. The trust gate is
   relevant only if a future mode runs Claude interactively against an
   un-trusted directory; we should not regress that path.

### Design

The Claude path is light: pass-through plus surfacing.

#### 1. No interception

Do not intercept `/goal …` for Claude sessions in
`ws-handlers/send-message.ts`. The CLI handles it. The orchestrator should
treat it as ordinary chat input. The Codex-only interception path described
above must explicitly guard on `agentId === "codex"` so a future change does
not accidentally route Claude `/goal` through a Codex code path.

#### 2. Validate the pass-through guarantees in tests

Add adapter regression tests that:

- The Claude spawn args do not contain `--disable-slash-commands` and do not
  contain `--bare`.
- A `/goal …` user message passed through `ClaudeAdapter.sendUserMessage()` or
  the streaming-input path is forwarded verbatim with no prefix stripping.
- The managed Stop hook used for auto-PR coexists with Claude's
  session-scoped Stop hook (the CLI supports multiple Stop hooks; this is
  factual but worth a unit-level guard).

#### 3. Optional: surface goal state inline

Claude has no structured "goal updated" event. State arrives as system
messages in the assistant stream. If we want a status chip parallel to the
chat (and consistent with the Codex `agent_goal_updated` event), the cheapest
v1 is **string detection in the assistant stream** for the announcement
phrases:

- `Goal set: <condition>` → `agent_goal_updated` with `status: "active"`.
- `Goal active: <condition>` → status query result; emit the same event.
- `Goal achieved` → `agent_goal_updated` with `status: "complete"` (or a
  dedicated `agent_goal_achieved`), then `agent_goal_cleared`.
- `Goal cleared: <condition>` → `agent_goal_cleared`.
- `No goal set` → no event; ensure the chip is hidden.

Implementation lives in `claude-adapter.ts`'s event mapping. Token budget /
time-used fields stay `null`/`0` for Claude — those are Codex-only.

This is brittle by nature (string scraping a vendor CLI), so it should be
optional v2 work, gated behind a feature flag and covered by adapter tests
that pin the exact phrases. If upstream changes them, the chip degrades but
the underlying command still works because the CLI is doing the work, not
ShipIt.

#### 4. Resume parity

Claude restores the active goal from the transcript on `--resume`. ShipIt's
session activation already resumes via `--resume`, so this works for free. If
we add the optional surfacing in step 3, the resume path needs to listen for
the restore announcement (or call `/goal active` once on activation) so the
chip rehydrates after reload. Verify against the
`tengu_goal_restored_on_resume` telemetry path.

#### 5. Do not paper over Claude's preconditions

If we ever hit one of the two block messages
(`"only available in trusted workspaces"`, `"can't run while hooks are
disabled"`), the right behavior is to surface the CLI's own error inline.
Don't suppress, retry, or rewrite it — the user needs to know which gate is
closed.

## Product fit

Support this as a chat command for both providers, not as a button or quick
action. The user types `/goal …` in the composer; the active agent (Codex or
Claude) gets the same chat input, and ShipIt does only as much work as the
provider's protocol requires.

This preserves ShipIt's product principle that chat is the input surface and
the agent is the actor. It also keeps goal status inline in ShipIt rather than
pushing the user to either CLI's terminal UI.

The asymmetry between providers is load-bearing: Codex requires real
orchestrator work (feature flag, JSON-RPC plumbing, dedicated proxy methods)
because `/goal` is an app-server primitive; Claude requires almost no
orchestrator work because `/goal` is handled inside the CLI. The design below
spells out the Codex implementation in detail; the Claude implementation is
covered above and reduces to "don't get in the way."

## Codex implementation

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

Codex adapter tests:

- Spawn args include `--enable goals`.
- Initialize request includes `capabilities.experimentalApi: true`.
- `thread/goal/updated` maps to a normalized ShipIt event.
- `thread/goal/cleared` maps to a normalized ShipIt event.
- Goal request methods send the expected JSON-RPC payloads.

Claude adapter tests:

- Spawn args do **not** include `--disable-slash-commands` or `--bare`.
- A user message starting with `/goal ` is forwarded verbatim to the CLI in
  both one-shot and streaming-input modes (no prefix stripping or rewriting).
- If optional inline surfacing (Claude design §3) is implemented, the
  recognized announcement strings each map to the expected normalized event,
  and unknown stream text never produces a spurious goal event.

Orchestrator integration tests:

- In a Codex session, `/goal Build X` calls the goal endpoint rather than
  starting a normal prompt turn.
- `/goal status` renders the current goal.
- `/goal clear` clears and renders confirmation.
- In a Claude session, `/goal Build X` is delivered to the CLI as a normal
  user message and is **not** routed through the Codex goal endpoint.

Client tests:

- Goal status renders active, paused, budget-limited, complete, and cleared
  states. (Paused / budget-limited apply to Codex only.)
- Goal UI is passive status display only; no shell-shaped command button.

## Key files

Codex:

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
- `src/server/orchestrator/ws-handlers/send-message.ts` — Codex `/goal`
  interception (Claude must remain a pass-through).
- `src/server/shared/types/ws-server-messages.ts` — normalized goal state
  message types.

Claude:

- `src/server/session/claude.ts` — verify spawn args keep slash commands and
  hooks enabled (no `--disable-slash-commands`, no `--bare`).
- `src/server/session/agents/claude-adapter.ts` — pass-through verification
  and (optional) string-detection mapping of CLI announcements onto the same
  normalized goal events.
- `src/server/session/agents/claude-adapter.test.ts` — pass-through regression
  tests; if surfacing is added, pin the exact announcement phrases.

Shared client:

- `src/client/components/MessageList.tsx` or adjacent message rendering
  components — inline goal status display.

## Non-goals

- No command palette entry, toolbar button, or quick action for `/goal`.
- No generic slash-command framework in v1; intercept only the Codex goal
  command forms needed here, and leave Claude as a pure pass-through.
- No attempt to mimic the full Codex TUI footer. ShipIt should render goal
  state in its own chat/session UI.
- No ShipIt-managed goal layer that re-implements goal checking on top of
  Claude. Claude already does this via its own Stop hook; building a parallel
  ShipIt mechanism would duplicate state, fight the CLI, and break on resume.
- No pause / resume semantics for Claude (the CLI has none) — only `set`,
  `active`, `clear`, and the CLI's own `achieved` lifecycle.
