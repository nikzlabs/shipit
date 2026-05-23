---
status: done
priority: high
description: Make agent-spawned sessions take the same env-prep and agent-start code path as user-spawned sessions, so they get OAuth, MCP, system prompt, settings, model, and PR lifecycle treatment identically.
---

# Align agent-spawned session startup with the user path

## Context

When a user creates a session from the UI, the first turn runs through
[`runAgentWithMessage` in `agent-execution.ts`](../../src/server/orchestrator/ws-handlers/agent-execution.ts).
That handler does a substantial amount of work *before* it invokes
`agent.run(...)`: it provisions per-session credentials, syncs the freshest
OAuth token in from the orchestrator source, refreshes expiring MCP OAuth
tokens, pushes the merged agent-env (compose secrets + MCP keys) to the
session worker, builds the agent's system prompt and managed-settings path,
and supplies the selected model, permission mode, MCP servers, and
`autoCreatePr` gate. Post-turn it writes the rotated token back, runs the
auto-commit, and emits the PR lifecycle card.

When an *agent* spawns a sibling session via `shipit session create`, the
first turn runs through `runner.sendSystemMessage(...)` →
[`runSystemTurn` in `session-runner.ts`](../../src/server/orchestrator/session-runner.ts#L129-L218).
That path does only a fraction of the above: it broadcasts a "started"
event, persists the user message, and calls `agent.run({ prompt, sessionId,
cwd })`. No token sync, no secrets push, no system prompt, no settings, no
model, no MCP config, no post-turn token write-back, no PR lifecycle card.

The reported symptom — and what brought us here — is that spawned sessions
report `Failed to authenticate. API Error: 401 Invalid authentication
credentials` on the first turn. That is the most user-visible consequence
of this divergence (the Anthropic OAuth refresh token is single-use, so a
write-once cred copy from the orchestrator source goes stale the moment any
other session rotates it). But it is one symptom among many: spawned
sessions also lack the agent system instructions, the
`/etc/shipit/managed-settings.json` hooks (branch-block + Stop-hook PR
enforcement), the user's selected model, any user-enabled MCP servers, and
the auto-create-PR flow that fires on first commit.

The same path is used by:

- `spawnChildSession` (agent-initiated session create) — first turn.
- `sendChildMessage` (`shipit session message`) — follow-up turns.
- `triggerCiAutoFix` (`services/github-ci-fix.ts`) — system-initiated
  CI repair turn.

All three share the same gap. Fixing it once fixes all three.

## Two separable concerns

Reading `runAgentWithMessage` carefully, the per-turn work splits cleanly
into two **independent** concerns. Today they're interleaved inline; the
fix is to factor them apart so neither path can drift from the other.

**Environment preparation** is about the container being ready to talk to
its upstream dependencies — Anthropic OAuth, MCP servers, GitHub. It is
*session-scoped*, *idempotent*, and orthogonal to whether we're about to
start a turn. Concretely: per-session credential subtree provisioned,
freshest OAuth token synced in, expiring MCP OAuth tokens refreshed,
agent-env pushed to the worker so `process.env` carries the right secrets.

**Agent start** is about telling the CLI "run this prompt with this system
prompt / model / settings / MCP config." It is *turn-scoped* and produces
the `AgentRunParams` payload.

Today, both happen inline inside `runAgentWithMessage`. The right
abstraction is **two named, decoupled operations**:

```
prepareSessionAgentEnvironment(runner, { sessionId, agentId, deps })
runner.sendSystemMessage(prompt)             // or agent.run(...) for the WS path
```

At the call site it should be obvious what's environment and what's agent
startup. Bundling them into a single "preparePerTurn" hook (an earlier
draft of this design) just re-creates the same opaque mixing one layer
down.

## Design

### Module 1 — environment preparation

New file `src/server/orchestrator/session-agent-env.ts` exposes two
free functions:

```ts
export interface SessionAgentEnvDeps {
  credentialsDir: string;
  credentialStore: CredentialStore;
  sessionManager: SessionManager;
}

export async function prepareSessionAgentEnvironment(
  runner: SessionRunnerInterface,
  args: { sessionId: string; agentId: AgentId; deps: SessionAgentEnvDeps },
): Promise<void>;

export function finalizeSessionAgentEnvironment(
  runner: SessionRunnerInterface,
  args: { sessionId: string; agentId: AgentId; deps: SessionAgentEnvDeps },
): void;
```

`prepareSessionAgentEnvironment` is **idempotent** and safe to call
unconditionally. It performs, in order:

1. If the runner is a `ContainerSessionRunner` and the session is not
   yet pinned: `provisionAgentCredentials` (write-once), then
   `setAgentId` + `setAgentPinned`. Mirrors
   [`agent-execution.ts` lines 798–811](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L798-L811).
2. `syncAgentTokenIn(credentialsDir, sessionId, agentId)` — every call,
   not just first. Mirrors
   [`agent-execution.ts` lines 818–824](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L818-L824).
   This is the line whose absence causes the 401.
3. `refreshExpiredMcpOAuthTokens({ credentialStore })`. Mirrors
   [`agent-execution.ts` lines 766–770](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L766-L770).
4. `runner.tryPushAgentSecrets(selectAgentEnvForPush({ serviceManager, credentialStore }))`.
   Mirrors [`agent-execution.ts` lines 826–833](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L826-L833).

Each step is fault-tolerant in the same way the inline equivalents are
today (logged warning on failure, no throw) — env prep must not block a
turn.

`finalizeSessionAgentEnvironment` runs `syncAgentTokenBack` so a token the
CLI rotated during the turn flows back into the orchestrator source for
future sessions. Mirrors
[`agent-execution.ts` lines 369–377](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L369-L377).

Both functions live outside any turn-execution code. `runSystemTurn` does
not know they exist; the caller is responsible for invoking them.

### Module 2 — agent run params

New file `src/server/orchestrator/session-agent-run-params.ts` exposes:

```ts
export interface BuildAgentRunParamsDeps {
  credentialStore: CredentialStore;
  githubAuthManager: { authenticated: boolean };
  sessionManager: SessionManager;
  readSystemPrompt: () => Promise<string | undefined>;
  getSelectedModel: () => string | undefined;
}

export async function buildAgentRunParams(args: {
  deps: BuildAgentRunParamsDeps;
  sessionId: string;
  agentId: AgentId;
  prompt: string;
  agentSessionId: string | undefined;   // for --resume
  sessionDir: string;
  permissionMode?: PermissionMode;
}): Promise<AgentRunParams>;
```

It builds the full `AgentRunParams`:

- `systemPrompt` from `buildAgentSystemInstructions({ agentId })` joined
  with `readSystemPrompt()` (`agentInstructions` block in
  [`agent-execution.ts` 706–717](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L706-L717)).
- `settingsPath = "/etc/shipit/managed-settings.json"` for Claude, else
  `undefined`. Carries the branch-block PreToolUse hook and the
  Stop-hook PR enforcement.
- `model` from `getSelectedModel()`.
- `permissionMode` from caller (defaults to whatever the WS handler
  passes today; system turns can default to undefined).
- `mcpServers` from `credentialStore.getAllMcpServers()` filtered by
  `enabled`.
- `autoCreatePr = credentialStore.getAutoCreatePr() && githubAuthManager.authenticated`.

`runAgentWithMessage` calls this directly. `runSystemTurn` calls it via a
single new hook on `SystemTurnDeps`:

```ts
buildRunParams: (sessionId: string, agentId: AgentId, prompt: string) => Promise<AgentRunParams>;
```

`SystemTurnDeps` grows by exactly one mandatory hook (no credentialing
concerns mixed in). The hook is wired in `runner-registry-factory.ts`
using `buildAgentRunParams`, closing over the same deps the registry
already receives.

### Module 3 — post-turn PR lifecycle

The PR lifecycle card / auto-create-PR block currently lives **twice** in
`agent-execution.ts` — once in the streaming branch
([lines 444–519](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L444-L519))
and once in the non-streaming `done` handler
([lines 593–686](../../src/server/orchestrator/ws-handlers/agent-execution.ts#L593-L686)).
Extract it to a single helper:

```ts
// src/server/orchestrator/services/pr-lifecycle.ts
export async function emitPrLifecycleAfterCommit(args: {
  ctx: AppCtx;       // for sessionManager, prStatusPoller, githubAuthManager,
                     // credentialStore, chatHistoryManager, generateText
  sessionId: string;
  sessionDir: string;
  commitHash: string;
  emit: (msg: WsServerMessage) => void;
}): Promise<void>;
```

`runAgentWithMessage` calls it from both branches (de-dup). `runSystemTurn`
calls it via a second `SystemTurnDeps` hook:

```ts
postTurnPrFlow?: (sessionId: string, sessionDir: string, commitHash: string,
                  emit: (msg: WsServerMessage) => void) => Promise<void>;
```

Optional because the CI auto-fix path's post-turn already produces a PR
update through the poller; tests can decide whether to wire it.

### `runSystemTurn` changes

[`runSystemTurn`](../../src/server/orchestrator/session-runner.ts#L129-L218)
becomes `async`. The structural changes are minimal:

- Before `agent.run({...})`: `const runParams = await deps.buildRunParams(host.sessionId, agentId, text); agent.run(runParams);`. The current
  hard-coded `{ prompt, sessionId, cwd }` shape goes away — `runParams`
  carries those plus `systemPrompt`, `settingsPath`, `model`,
  `permissionMode`, `mcpServers`, `autoCreatePr`.
- On `agent_result` and on `done`: nothing new — token write-back is
  caller-driven via `finalizeSessionAgentEnvironment`, not a deps hook.
  (The post-turn token write-back conceptually belongs to env, not to the
  turn machinery. Keeping it out of `SystemTurnDeps` preserves the
  separation.)
- After `autoCommit` + `scheduleAutoPush`: `await deps.postTurnPrFlow?.(host.sessionId, host.sessionDir, commitHash, host.emitMessage);`

`sendSystemMessage` already returns `void`, so the async hop is
`void this._runSystemTurn(...)`. No public API churn.

Critically: `runSystemTurn` still knows nothing about credentials,
secrets, or MCP. Those are guaranteed by the caller having invoked
`prepareSessionAgentEnvironment` first.

### Call-site changes

Every place that's about to start an agent gains an explicit env-prep
call. The two operations stay visibly separate:

| Call site | Before | After |
|---|---|---|
| `runAgentWithMessage` | Inline blocks 798–833 prep + inline `agent.run(...)` + 369–377 token write-back + duplicated PR blocks | `prepareSessionAgentEnvironment(...)`<br>`agent.run(await buildAgentRunParams(...))`<br>`finalizeSessionAgentEnvironment(...)` in post-turn handlers<br>`emitPrLifecycleAfterCommit(...)` once (not duplicated) |
| `spawnChildSession` ([lines 321–340](../../src/server/orchestrator/services/child-sessions.ts#L321-L340)) | `getOrCreate` → `provisionAgentCredentials` → `setAgentId` + `setAgentPinned` → `sendSystemMessage` | `getOrCreate` → `prepareSessionAgentEnvironment` (subsumes the cred + pin block) → `sendSystemMessage` |
| `sendChildMessage` ([lines 529–531](../../src/server/orchestrator/services/child-sessions.ts#L529-L531)) | `getOrCreate` → `sendSystemMessage` | `getOrCreate` → `prepareSessionAgentEnvironment` → `sendSystemMessage` |
| `triggerCiAutoFix` ([line 263](../../src/server/orchestrator/services/github-ci-fix.ts#L263)) | `sendSystemMessage` | `prepareSessionAgentEnvironment` → `sendSystemMessage` |

`prepareSessionAgentEnvironment`'s deps (`credentialsDir`, `credentialStore`,
`sessionManager`) are already present in every one of these call sites'
ambient context. The two spawn-service entry points already receive
`credentialsDir` through their existing signatures; CI auto-fix already
threads `CredentialStore`. No new deep-plumbing required.

`finalizeSessionAgentEnvironment` is called from `runSystemTurn`'s
caller-side post-turn observation (or by the agent-execution handler on
the WS path). For symmetry we add it to the `runSystemTurn` deps as
nothing — instead, the registry's `onRunnerCreated` wires a listener on
the runner that calls `finalizeSessionAgentEnvironment` when the agent
exits cleanly. This keeps `runSystemTurn` env-agnostic while still
guaranteeing the write-back happens for system turns. (Alternative: a
third optional hook on `SystemTurnDeps`. Decide during implementation —
either works; the listener is cleaner because it matches the env-prep
asymmetry.)

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/session-agent-env.ts` | **new** — `prepareSessionAgentEnvironment`, `finalizeSessionAgentEnvironment`. |
| `src/server/orchestrator/session-agent-run-params.ts` | **new** — `buildAgentRunParams`. |
| `src/server/orchestrator/services/pr-lifecycle.ts` | **new** — `emitPrLifecycleAfterCommit`. |
| `src/server/orchestrator/session-runner.ts` | `runSystemTurn` becomes async; add `buildRunParams` (required) and `postTurnPrFlow` (optional) to `SystemTurnDeps`. |
| `src/server/orchestrator/runner-registry-factory.ts` | Wire `buildRunParams` and `postTurnPrFlow` using the new modules; register the post-turn `finalizeSessionAgentEnvironment` listener on each created runner. |
| `src/server/orchestrator/ws-handlers/agent-execution.ts` | Replace the four inline blocks (prep, run-params assembly, token write-back, PR lifecycle ×2) with helper calls. |
| `src/server/orchestrator/services/child-sessions.ts` | Add `prepareSessionAgentEnvironment` call before each `sendSystemMessage`; drop the now-redundant cred-provision block. |
| `src/server/orchestrator/services/github-ci-fix.ts` | Add `prepareSessionAgentEnvironment` call before `sendSystemMessage`. |
| `src/server/orchestrator/integration_tests/agent-spawned-session.test.ts` | New assertions; see Tests below. |

## Tests

The existing `agent-spawned-session.test.ts` covers the orchestrator
end-to-end but never inspects the `AgentRunParams` the runner ultimately
hands to the CLI. Extend it with:

1. **Run-params parity.** Spawn a child via `POST /api/sessions/:parentId/spawn`,
   drive the first `FakeClaudeProcess` to start, and assert its captured
   `run(...)` argument includes:
   - non-empty `systemPrompt` (contains the agent-instructions sentinel),
   - `settingsPath === "/etc/shipit/managed-settings.json"` for Claude,
   - the parent's `model` if propagated,
   - the enabled MCP servers,
   - `autoCreatePr` reflecting the gate.
2. **OAuth token freshness.** Seed the orchestrator's source token, spawn a
   child, rotate the source token *before* the child's first turn starts,
   then assert the child's per-session token file matches the rotated
   source by the time `agent.run` is called. Today this assertion fails
   (the 401 root cause).
3. **Post-turn write-back.** Have the `FakeClaudeProcess` write a refreshed
   token into the session's credential subtree before emitting `done`;
   assert the orchestrator source picks it up. Mirrors the user-path
   coverage that docs/142 added.
4. **Idempotence.** Call `prepareSessionAgentEnvironment` twice in a row;
   confirm `provisionAgentCredentials` runs only the first time (write-once
   semantics preserved by the `agentPinned` flag).

CI auto-fix tests get the same env-prep guarantees for free. Spot-check
they still pass.

## Tradeoffs / risks

- **`SystemTurnDeps` grows by two hooks.** `buildRunParams` is required to
  reach parity. `postTurnPrFlow` is optional and only the registry wires
  it; tests can omit it. No credentialing concerns enter the deps — that
  stays a caller responsibility.
- **CI auto-fix improves silently.** Today's CI auto-fix turn has the same
  gaps and may have been quietly running without a system prompt, settings,
  or model. This change lifts it — a net upgrade, not a regression.
- **Streaming-agent reuse (docs/140)** is WS-handler-specific:
  `runSystemTurn` keeps fresh-agent semantics. A system turn is by
  definition a one-shot; reusing a streaming agent across system turns is
  out of scope.
- **`runSystemTurn` becomes async.** All current callers go through
  `sendSystemMessage`, which is `void`. The async hop is internal
  (`void this._runSystemTurn(...)`) — no external API change.
- **Two new files plus one new services module.** Could be inlined into
  existing modules, but keeping env, run-params, and PR lifecycle in
  their own files makes the separation visible and lets future tests
  target each concern independently.

## Out of scope

- Surfacing the spawned session's PR lifecycle card on the parent's chat.
  The card already emits via the child's runner; routing it up to the
  parent is its own design.
- Per-spawn agent override beyond what docs/117 already supports.
- Streaming-agent reuse across system turns.

## Implementation notes

- **Token write-back hook instead of registry listener.** The plan left the
  finalize-env wiring as an implementation choice between "listener on the
  runner" and "third optional hook on `SystemTurnDeps`." Settled on the hook
  (`finalizeAgentEnv?: (sessionId, agentId) => void`) — adding a new event to
  `SessionRunnerEvents` would have rippled through every runner fake in the
  test suite, while the hook is one line in `runSystemTurn`'s `agent.on("done")`
  and one line in the registry factory.
- **`resolveAgentSessionId` deleted from `SystemTurnDeps`.** The `--resume` id
  lookup is now done inside `buildRunParams`, so the standalone resolver is
  redundant. `session-runner.test.ts` updated to use `buildRunParams` directly
  in the deps fixture.
- **`buildRunParams` is required, but tolerant of missing `credentialStore`.**
  Production wires it through the credential store; test setups that don't
  supply one fall back to the legacy minimal `{ prompt, sessionId, cwd }`
  shape rather than crashing. Keeps the new contract clean while preserving
  behavior for thin test harnesses.
- **`selectAgentEnvForPush` relocated to `session-agent-env.ts`.** The
  function was inside `ws-handlers/agent-execution.ts`, which would have
  created a cycle (env-prep importing from ws-handlers). Moved to the new
  module; `agent-execution.ts` re-exports it so `agent-env-push.test.ts`'s
  import path keeps working.
- **`readSystemPrompt` hoisted to app scope.** The WS handler reads
  `.shipit/system-prompt.md` from `workspaceDir` via a per-connection helper;
  duplicated the same closure at app scope in `index.ts` so the system-turn
  `buildRunParams` hook can read it without per-connection state.
- **Lazy `PrStatusPoller` resolver.** The poller is constructed after the
  runner registry (depends on it), but the registry's post-turn PR-lifecycle
  hook needs it at runtime. Threaded through as `getPrStatusPoller: () =>
  PrStatusPoller | undefined` so the closure resolves it at fire time.
- **Tests.** Added `session-agent-env.test.ts` (idempotence, OAuth freshness,
  agent-env push, write-back) using a fake `ContainerSessionRunner` with its
  prototype reparented so the `instanceof` checks fire. The integration test
  gets a run-params parity assertion driven by extending `FakeClaudeProcess`
  to capture `settingsPath` / `model` / `mcpServers` / `autoCreatePr`.
