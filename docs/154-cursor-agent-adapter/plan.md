---
title: Cursor agent adapter
description: Optional pinned installation of third-party agent CLIs, with Cursor Agent as the first new backend using ShipIt's AgentProcess adapter boundary.
---

# Cursor Agent adapter and optional CLI installation

ShipIt already treats agent backends as pluggable process adapters. Claude Code
and Codex are installed in the session image, detected by the shared
`AgentRegistry`, selected in the client, then launched inside the session worker
through the `AgentProcess` interface.

This feature adds Cursor Agent as an optional backend while also generalizing how
agent CLIs are installed. The installation path is deliberately admin-selected,
version-pinned, and auditable: the production setup asks which CLIs should be
available in session containers, records that choice in deployment config, and
builds the session image with only those selected CLIs.

The Cursor runtime path is separate from installation. Once `cursor-agent` is
present and authenticated, ShipIt runs it through a new `CursorAdapter` that
maps Cursor's stream output into ShipIt's normalized `AgentEvent` contract.

## Goals

1. Add a production setup flow that lets the admin choose which agent CLIs to
   install into session containers.
2. Install selected CLIs at manually approved versions, using the existing
   pinned manifest / lockfile approach.
3. Add Cursor as an optional `AgentId` with registry detection, auth status, and
   client selection.
4. Implement a `CursorAdapter` that launches `cursor-agent` in headless mode and
   maps its streaming events into ShipIt's existing chat, tool, result, and
   post-turn flow.
5. Keep Cursor disabled unless the deployment explicitly installs it and the
   user/admin provides Cursor credentials.

## Non-goals

- Making Cursor the default agent backend.
- Pooling or brokering Cursor credentials.
- Replacing Claude or Codex installation paths.
- Implementing Cursor-specific UX beyond the existing agent/model selector and
  auth/config surfaces needed to make the backend usable.
- Depending on an undocumented protocol path for the first version. If Cursor's
  ACP mode becomes a stable documented contract, it can be evaluated as a later
  adapter transport.

  Considered and rejected: starting with a generic ACP adapter so any
  ACP-speaking CLI (Cursor, Gemini CLI, etc.) shares one transport. The reuse
  argument is thinner than it looks — Claude Code is already driven via native
  stream-json, Codex does not speak ACP, and Cursor's ACP mode is still
  undocumented (the reason it was excluded above). An ACP-first path would
  trade Cursor's documented headless contract for an undocumented one without
  unifying the existing adapters. Better sequencing: ship Cursor on its
  documented stream-json surface now, then add a separate `AcpAdapter` as its
  own backend when ACP becomes a published Cursor contract or Gemini CLI
  warrants a backend — that is the point where one adapter pays for multiple
  CLIs.

## Current agent architecture

Relevant existing files:

- `src/server/shared/types/agent-types.ts` — `AgentId`, `AgentCapabilities`,
  `AgentEvent`, `AgentProcess`, and `AgentRunParams`.
- `src/server/shared/agent-registry.ts` — static agent definitions, binary
  detection, and auth detection.
- `src/server/session/agents/claude-adapter.ts` — wraps Claude Code's stream
  events as normalized `AgentEvent`s.
- `src/server/session/agents/codex-adapter.ts` — wraps Codex app-server JSON-RPC
  events as normalized `AgentEvent`s.
- `src/server/session/session-worker.ts` — creates and runs the selected agent
  inside the session container.
- `src/server/orchestrator/proxy-agent-process.ts` and
  `container-session-runner.ts` — proxy agent start/stdin/interrupt/kill over
  HTTP when the orchestrator talks to a containerized session worker.
- `src/client/components/ModelAgentSelector.tsx` and related stores — expose
  installed/authenticated agents and their models to the user.

Cursor should use the same adapter seam rather than introducing a separate
execution path.

## Installation model

### Deployment config

Production setup should ask which CLIs to install and write explicit config into
the deployment `.env`:

```env
INSTALL_CLAUDE_CLI=1
CLAUDE_CLI_VERSION=approved-version

INSTALL_CODEX_CLI=1
CODEX_CLI_VERSION=approved-version

INSTALL_CURSOR_CLI=0
CURSOR_CLI_VERSION=approved-version
```

The boolean controls whether the CLI is installed in the session image. The
version controls the exact approved version or approved artifact entry to use.
Setup defaults should keep the current backends enabled and Cursor disabled
until explicitly selected.

If a combined form is easier to manage in scripts, keep the per-CLI variables as
the canonical resolved output:

```env
INSTALL_AGENT_CLIS=claude,codex,cursor
```

The production setup script can parse the combined list, validate each selected
CLI has an approved version, then emit the per-CLI build args.

### Version manifest

The implementation should extend the existing CLI version strategy instead of
adding ad hoc curl installs in Dockerfiles. The desired shape is a committed,
reviewed manifest that records:

- CLI id: `claude`, `codex`, `cursor`.
- Display name.
- Binary name.
- Approved version.
- Install source.
- Integrity metadata when available.
- Contract-test status.

For npm-distributed CLIs this can continue to be a lockfile-backed install under
`docker/agent-cli/`. If Cursor's installable artifact is not npm-based, add a
small manifest entry plus an installer script that downloads the exact approved
artifact and verifies checksum before placing `cursor-agent` under ShipIt's
agent bin directory.

Do not rely on "latest" resolution in the Dockerfile. The Dockerfile should only
consume already-approved version data.

### Image layout

Selected CLIs should be installed under ShipIt-owned prefixes rather than
scattered global paths:

```text
/opt/shipit/agents/claude/bin/claude
/opt/shipit/agents/codex/bin/codex
/opt/shipit/agents/cursor/bin/cursor-agent
```

The registry can still expose each CLI as a logical agent id, but adapters should
prefer absolute binary paths from a shared resolver:

```ts
resolveAgentBinary("cursor") // /opt/shipit/agents/cursor/bin/cursor-agent
```

Using absolute paths avoids accidental coupling to whatever happens to be on
`PATH` inside the container.

### Docker build args

The session-worker image should accept one build arg per CLI:

```dockerfile
ARG INSTALL_CLAUDE_CLI=1
ARG CLAUDE_CLI_VERSION
ARG INSTALL_CODEX_CLI=1
ARG CODEX_CLI_VERSION
ARG INSTALL_CURSOR_CLI=0
ARG CURSOR_CLI_VERSION
```

The install layer then delegates to a checked-in script:

```dockerfile
RUN /usr/local/bin/install-agent-clis \
      --claude "${INSTALL_CLAUDE_CLI}:${CLAUDE_CLI_VERSION}" \
      --codex "${INSTALL_CODEX_CLI}:${CODEX_CLI_VERSION}" \
      --cursor "${INSTALL_CURSOR_CLI}:${CURSOR_CLI_VERSION}"
```

The script should:

- no-op for disabled CLIs;
- fail fast if an enabled CLI has no approved version;
- install only from the approved source for that version;
- verify lockfile or checksum data;
- write a machine-readable install report such as
  `/opt/shipit/agents/installed.json`.

That report gives `AgentRegistry` a fast, deterministic way to detect what the
image contains without spawning every CLI during bootstrap.

### Production setup flow

The production setup script should add a step:

```text
Select agent CLIs to install into session containers:
[x] Claude Code
[x] Codex
[ ] Cursor Agent
```

For each selected CLI, the script should show the approved version that will be
installed. The setup result becomes part of the deployment config used by Docker
Compose build args.

This is configuration, not a user-run command surface. Users still ask the agent
to do work in chat; admins only choose which backend binaries are present in the
self-hosted deployment.

## Cursor adapter design

### CLI invocation

Cursor's documented headless mode supports print prompts and streaming output.
The adapter should start with that public CLI surface:

```bash
cursor-agent -p "$PROMPT" --output-format stream-json --model "$MODEL"
```

ShipIt should invoke it through `child_process.spawn` with piped stdio, not
through a shell:

```ts
spawn(cursorBinary, [
  "-p",
  params.prompt,
  "--output-format",
  "stream-json",
  ...(params.model ? ["--model", params.model] : []),
], {
  cwd: params.cwd,
  env: spawnEnv,
});
```

Avoid passing the prompt through shell interpolation. If Cursor supports reading
the prompt from stdin or a file, prefer that once verified, because it avoids
large prompt argv limits and makes image/file-reference prompts easier to
serialize.

### Auth

Cursor should be considered auth-configured when either of these is true:

- `CURSOR_API_KEY` is present in the agent environment.
- a future Cursor login file check is implemented and reports an authenticated
  local CLI session.

Initial implementation should use `CURSOR_API_KEY`, because it is straightforward
inside session containers and matches the headless/CI use case.

Changes:

- Add `CURSOR_API_KEY` to the agent-env allowlist in
  `src/server/shared/agent-registry.ts`.
- Add a Cursor auth check branch to `AgentRegistry.isAuthConfigured`.
- Surface Cursor auth as the same "installed but not configured" state used by
  other agents.
- Keep the credential value in existing credential-store plumbing; do not add a
  Cursor-specific persistence path until a file-login flow is implemented.

### Capabilities

Initial Cursor capabilities should be conservative:

```ts
{
  supportsResume: true,          // if verified against cursor-agent resume
  supportsImages: false,         // until prompt/image attachment behavior is proven
  supportsSystemPrompt: false,   // unless Cursor exposes a stable flag/config path
  supportsPermissionModes: false,
  supportedPermissionModes: [],
  toolNames: ["shell", "file_read", "file_write", "file_edit"],
  models: ["auto"],              // replace with verified Cursor model ids
  supportsReview: false,         // keep off until subagent + MCP review bridge is proven
  supportsSteering: false,       // keep off until mid-turn input behavior is proven
}
```

Before enabling `supportsResume`, verify that `cursor-agent resume` can continue
a prior headless run in the way ShipIt's post-turn flow expects. If the resume
contract is unclear, ship `supportsResume: false` for the first adapter.

### Event parsing

`CursorAdapter` should parse newline-delimited JSON from stdout. Invalid JSON
lines should be emitted as `log` events with source `"cursor"`, matching the
resilience pattern used by Claude.

The exact Cursor event schema should be locked down with a local spike against
the pinned CLI. The adapter should normalize only the events ShipIt needs:

| Cursor stream concept | ShipIt event |
|---|---|
| run/session initialized | `agent_init` |
| assistant text | `agent_assistant` with `{ type: "text" }` blocks |
| tool call start | `agent_assistant` with `{ type: "tool_use" }` block |
| tool result / command output | `agent_tool_result` |
| final status / usage | `agent_result` |
| non-JSON output | `log` |
| auth missing | `auth_required` or `error` with actionable message |

If Cursor streams text deltas rather than complete message blocks, the adapter
should buffer deltas until a message boundary before emitting
`agent_assistant`. ShipIt's current chat grouping expects coherent assistant
blocks, not one event per token.

If Cursor exposes command/file operations as high-level tool events, map them
to existing normalized tool-use names so the UI can reuse current renderers. If
the first CLI schema does not expose enough structure, the MVP can render tool
activity as text/log output while preserving final file changes through
ShipIt's file watcher and git diff flow.

### Process lifecycle

Cursor MVP should follow the one-process-per-turn model:

1. `run(params)` spawns `cursor-agent`.
2. stdout/stderr are parsed until process exit.
3. A Cursor final event maps to `agent_result` if available.
4. If the process exits without a final event, synthesize `agent_result` from
   the exit code.
5. `done(exitCode)` fires after process close so existing post-turn commit,
   auto-push, and queue draining continue to work.

This keeps Cursor aligned with the stable Claude one-shot path and avoids
touching the live-steering lifecycle.

`interrupt()` should send `SIGINT` first, then escalate to `SIGTERM`/`SIGKILL`
on timeout. `kill()` should immediately terminate the child process.

### System instructions and repo instructions

ShipIt already composes provider-neutral agent instructions before starting a
turn. Cursor also reads repo instruction files such as `AGENTS.md` and
`CLAUDE.md`, so there are two possible instruction paths:

1. Pass the ShipIt-managed system prompt if Cursor has a stable headless flag for
   system/developer instructions.
2. Otherwise prepend the ShipIt-managed instructions to the user prompt for the
   Cursor adapter only.

The first implementation should use whichever path is confirmed in the CLI
spike. Do not depend solely on repo files; ShipIt's session-specific rules
include runtime details and must be included in every turn.

### MCP

Cursor documents MCP support via `mcp.json`. CursorAdapter should not enable MCP
by default until the config path and runtime status behavior are verified.

Planned follow-up:

- Generate a Cursor-compatible MCP config from ShipIt's existing
  `McpServerConfig` values.
- Resolve secrets inside the session worker before writing the config.
- Pass the config path to Cursor if there is a stable flag, or place it in the
  documented Cursor config location for the session.
- Emit `mcp_status` only if Cursor exposes real server status. Otherwise leave
  the event silent, matching Codex's conservative behavior.

## Type and registry changes

### `AgentId`

Update:

```ts
export type AgentId = "claude" | "codex" | "cursor";
```

Audit all switch statements and local-storage validators that currently assume
only `"claude" | "codex"`.

### `AgentRegistry`

Add:

```ts
{
  id: "cursor",
  name: "Cursor Agent",
  binary: "cursor-agent",
  capabilities: cursorCapabilities,
}
```

Registry installation detection should prefer `/opt/shipit/agents/installed.json`
or `resolveAgentBinary("cursor")` over `which cursor-agent`. `which` can stay as
a fallback for development.

Auth detection should check `CURSOR_API_KEY` initially:

```ts
const AUTH_ENV_KEYS: Partial<Record<AgentId, string>> = {
  codex: "OPENAI_API_KEY",
  cursor: "CURSOR_API_KEY",
};
```

### Adapter registration

The session worker's agent factory should instantiate `CursorAdapter` when
`agentId === "cursor"`. Keep all HTTP and SSE proxying unchanged; Cursor should
look like any other `AgentProcess` to the orchestrator.

## Client changes

The client should not need Cursor-specific screens for the MVP. It needs only:

- `AgentId` type updates.
- model selector support for the new agent.
- local-storage validation accepting `"cursor"`.
- settings/auth UI support for entering `CURSOR_API_KEY`.
- clear unavailable states:
  - not installed in this deployment;
  - installed but missing credentials;
  - installed and configured.

No external Cursor UI should be opened automatically from a normal chat flow.

## Tests

### Unit tests

- `agent-registry.test.ts`
  - Cursor absent when binary/install report is missing.
  - Cursor installed but unauthenticated when `CURSOR_API_KEY` is absent.
  - Cursor available when installed and `CURSOR_API_KEY` is set.
  - env allowlist accepts `CURSOR_API_KEY`.
- `cursor-adapter.test.ts`
  - maps init/text/tool/result JSON lines to normalized `AgentEvent`s.
  - emits invalid JSON as `log`.
  - synthesizes an error `agent_result` on non-zero exit without a result event.
  - handles auth-required output as `auth_required` or a clear error.
- client tests for agent/model selector and local-storage validation.

### Contract test

Add Cursor to the CLI contract test suite once an approved version is available:

1. Build or install the pinned Cursor CLI into a test image.
2. Run `cursor-agent -p` in a temporary repo.
3. Ask it to create or edit a small file.
4. Verify:
   - process exits successfully;
   - stream parser receives assistant text and a final result;
   - file watcher/git diff sees the edit;
   - adapter emits one `agent_result`;
   - no post-turn action waits forever.

This test should be the gate for bumping `CURSOR_CLI_VERSION`.

### Integration test

Add a fake Cursor process test at the session-worker/orchestrator boundary:

- select agent `"cursor"`;
- run a turn;
- receive normalized chat events over WebSocket;
- verify post-turn commit path is reached;
- verify queued messages drain after `done`.

The fake process is enough for ShipIt's control flow. The contract test covers
the real CLI.

## Rollout phases

### Phase 1 — Optional install plumbing

- Add install manifest support for enabled/disabled CLIs.
- Add production setup prompt and `.env` output.
- Add Docker build args and installer script.
- Add installed report under `/opt/shipit/agents/installed.json`.
- Keep Cursor disabled by default.

### Phase 2 — Registry and UI availability

- Add `AgentId = "cursor"`.
- Add Cursor registry entry and `CURSOR_API_KEY` auth detection.
- Update client type guards, local storage, selector, and auth settings.
- Cursor can appear as "not installed" or "needs credentials"; it is not yet
  runnable.

### Phase 3 — CursorAdapter MVP

- Implement one-shot `CursorAdapter`.
- Parse stream-json output into normalized events.
- Register the adapter in the session worker.
- Add unit tests with recorded/fake stream lines.
- Run a manual end-to-end test against the pinned CLI.

### Phase 4 — Contract and hardening

- Add Cursor CLI contract test.
- Gate approved version bumps on the contract test.
- Improve prompt delivery if stdin/file prompt mode is supported.
- Add clearer error mapping for missing auth, invalid model, and CLI protocol
  changes.

### Phase 5 — Optional advanced capabilities

- Resume support after the exact Cursor resume contract is proven.
- MCP config generation and status reporting.
- Image attachments if Cursor headless mode supports them.
- Live steering if Cursor exposes a stable mid-turn input path.
- Review support if Cursor can run the review MCP bridge with an equivalent
  subagent/delegation primitive.

## Open questions

- What is the exact JSON schema emitted by the pinned `cursor-agent
  --output-format stream-json` version?
- Does Cursor provide a stable way to pass system/developer instructions in
  headless mode?
- Can prompts be provided through stdin or a file instead of argv?
- What exact model identifiers should ShipIt expose for Cursor?
- Is resume reliable enough to expose `supportsResume: true`?
- Does Cursor expose MCP connection status, or only tool-call results?
- Does the Cursor CLI publish checksums or other integrity metadata for pinned
  non-npm artifacts?

## Success criteria

- A self-hosted admin can choose Cursor during setup and build a session image
  containing the approved Cursor CLI version.
- ShipIt accurately reports Cursor as installed/uninstalled and
  authenticated/unauthenticated.
- A user can select Cursor, send a prompt, see assistant/tool/result output in
  the normal chat UI, and receive normal post-turn commit/PR behavior.
- Cursor version bumps are reviewed through the same pinned-version workflow as
  other agent CLIs and gated by an adapter contract test.
