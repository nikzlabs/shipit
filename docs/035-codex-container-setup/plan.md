
# 035 — Codex Container Setup & Runtime Integration

## Problem

Feature 034 (Phase 2) added a `CodexAdapter` that speaks the Codex App Server JSON-RPC protocol, but the `codex` binary is not installed in the container. When a user selects Codex as their agent, `spawn("codex", ["app-server"])` fails with `ENOENT`. There is also no mechanism to:

- Detect whether the Codex CLI is available at runtime.
- Provide a clear error when it isn't.
- Manage `OPENAI_API_KEY` through the UI (the way Claude uses OAuth via `AuthManager`).
- Prevent users from selecting an agent whose CLI isn't installed.

## Goals

1. **Install Codex CLI** in both dev and prod container images.
2. **Runtime binary detection** — the server checks which agent CLIs are available on startup and exposes this to the client.
3. **Clear error path** — if a user selects Codex but the binary is missing or the API key is not set, show an actionable message instead of a generic error.
4. **API key management** — let users set `OPENAI_API_KEY` through the settings UI, persisted for the container session.
5. **No disruption** — Claude remains the default; Codex is opt-in and degrades gracefully if unavailable.

## Non-goals

- Installing Gemini CLI (that's Phase 4 of 034).
- Multi-model routing or automatic agent selection.
- Persisting API keys across container rebuilds (that's a platform concern).

---

## Design

### 1. Dockerfile changes

Both `Dockerfile.dev` and `Dockerfile.prod` install the Codex CLI alongside Claude Code:

```dockerfile
RUN npm install -g @anthropic-ai/claude-code

RUN npm install -g @anthropic-ai/claude-code @openai/codex
```

The `@openai/codex` package provides the `codex` binary, which includes the `app-server` subcommand used by the adapter.

**Key files:**
- `docker/Dockerfile.prod` — line 22
- `docker/Dockerfile.dev` — line 5

### 2. Agent availability detection

Add an `AgentRegistry` that checks which agent CLIs are installed at server startup. This replaces the hard-coded `validAgentIds` list in the `set_agent` handler.

```typescript
export interface AgentInfo {
  id: AgentId;
  name: string;
  binary: string;
  installed: boolean;
  authConfigured: boolean;
  capabilities: AgentCapabilities;
}

export class AgentRegistry {
  private agents: Map<AgentId, AgentInfo>;

  async detect(): Promise<void>;

  get(id: AgentId): AgentInfo | undefined;

  list(): AgentInfo[];

  available(): AgentInfo[];

  refreshAuth(id: AgentId): void;
}
```

Detection uses `which <binary>` (or `command -v`) to check if the binary is on `$PATH`. Auth checks:
- **Claude**: `AuthManager.checkCredentials()` (existing OAuth flow).
- **Codex**: `process.env.OPENAI_API_KEY` is set and non-empty.

**Key file:** `src/server/agents/agent-registry.ts` (new)

### 3. WebSocket messages

#### `list_agents` — client requests available agents

```typescript
interface WsListAgentsMessage {
  type: "list_agents";
}

interface WsAgentListMessage {
  type: "agent_list";
  agents: Array<{
    id: AgentId;
    name: string;
    installed: boolean;
    authConfigured: boolean;
    models: string[];
  }>;
  defaultAgentId: AgentId;
}
```

The client sends `list_agents` on connect (or when the settings panel opens). The server responds with the detected state of each agent. The agent picker component uses this to show/disable options.

#### Enhanced `set_agent` error

When the user sends `set_agent` for an agent that is not installed or not auth-configured, the server returns a specific error:

```typescript
{ type: "error", message: "Codex CLI is not installed in this environment" }
// or
{ type: "error", message: "OPENAI_API_KEY is not set. Add it in Settings → Agents." }
```

**Key files:**
- `src/server/types.ts` — add `WsListAgentsMessage`, `WsAgentListMessage`
- `src/server/index.ts` — `list_agents` handler, enhanced `set_agent` validation

### 4. API key management via settings UI

The existing Project Settings panel (Agent tab, added in commit `cadd94d`) is extended to support Codex API key entry:

```
┌─────────────────────────────────────┐
│  Agents                             │
│                                     │
│  Claude Code  ✓ Authenticated       │
│  [Manage OAuth...]                  │
│                                     │
│  Codex        ✗ API key not set     │
│  [OPENAI_API_KEY: ___________]      │
│  [Save]                             │
│                                     │
│  Gemini       ✗ Not installed       │
└─────────────────────────────────────┘
```

#### `set_agent_env` — client sets an env var for an agent

```typescript
interface WsSetAgentEnvMessage {
  type: "set_agent_env";
  agentId: AgentId;
  key: string;
  value: string;
}

interface WsAgentEnvSetMessage {
  type: "agent_env_set";
  agentId: AgentId;
  key: string;
  success: boolean;
}
```

The server sets the env var in `process.env` (effective for all subsequent child processes in this container session), then re-runs auth detection for that agent. The value is not persisted to disk — it lives only for the container's lifetime.

**Security:** The server validates that the `key` is in an allowlist (`OPENAI_API_KEY`, `GOOGLE_API_KEY`) and never echoes the value back. The client input field masks the value.

**Key files:**
- `src/server/types.ts` — `WsSetAgentEnvMessage`, `WsAgentEnvSetMessage`
- `src/server/index.ts` — `set_agent_env` handler
- `src/client/components/ProjectSettings.tsx` — Codex key input field

### 5. Adapter startup guard

The `CodexAdapter.run()` already checks for `OPENAI_API_KEY` and emits `auth_required` if missing. Add a parallel check for the binary itself:

```typescript
import { execFileSync } from "node:child_process";

try {
  execFileSync("which", ["codex"], { stdio: "ignore" });
} catch {
  this.emit("error", new Error(
    "Codex CLI is not installed. Install it with: npm install -g @openai/codex"
  ));
  return;
}
```

This gives an immediate, actionable error instead of the opaque `spawn ENOENT` that comes later.

**Key file:** `src/server/agents/codex-adapter.ts`

### 6. Server startup logging

On `buildApp()`, after creating the `AgentRegistry`, log detected agents:

```
[server] Agent CLIs detected: claude ✓, codex ✓, gemini ✗
[server] Agent auth status: claude ✓ (OAuth), codex ✗ (OPENAI_API_KEY not set)
```

This aids debugging when Codex isn't working in a container.

---

## Key files to modify

| File | Change |
|---|---|
| `docker/Dockerfile.prod` | Add `@openai/codex` to `npm install -g` |
| `docker/Dockerfile.dev` | Add `@openai/codex` to `npm install -g` |
| `src/server/agents/codex-adapter.ts` | Binary existence check before spawn |
| `src/server/index.ts` | `AgentRegistry` init, `list_agents` handler, enhanced `set_agent`, `set_agent_env` handler |
| `src/server/types.ts` | `WsListAgentsMessage`, `WsAgentListMessage`, `WsSetAgentEnvMessage`, `WsAgentEnvSetMessage` |
| `src/client/components/ProjectSettings.tsx` | Codex API key input in Agent tab |

## New files

| File | Purpose |
|---|---|
| `src/server/agents/agent-registry.ts` | Runtime detection of installed agent CLIs and auth status |
| `src/server/agents/agent-registry.test.ts` | Unit tests for detection and auth checking |

---

## Migration plan

### Step 1: Dockerfile + binary guard (minimal, safe)

1. Add `@openai/codex` to both Dockerfiles.
2. Add binary check at top of `CodexAdapter.run()`.
3. Test: rebuild container, verify `codex app-server --help` works, verify graceful error when binary is absent.

### Step 2: Agent registry + `list_agents` message

1. Create `AgentRegistry` with `detect()` and `list()`.
2. Add `list_agents` / `agent_list` WebSocket messages.
3. Call `registry.detect()` during `buildApp()`.
4. Update `set_agent` handler to check `registry.get(id).installed`.
5. Integration tests: agent detection, `list_agents` response, rejection of unavailable agents.

### Step 3: API key management UI

1. Add `set_agent_env` handler with allowlist validation.
2. Extend Project Settings Agent tab with key input for Codex.
3. After saving, re-detect auth and send updated `agent_list`.
4. Component tests for key input field.

---

## Testing

- **Unit tests:** `AgentRegistry.detect()` with mocked `which` command; auth checking with/without env vars.
- **Integration tests:** `list_agents` returns correct availability; `set_agent` rejects unavailable agent with descriptive error; `set_agent_env` sets key and updates auth status.
- **Component tests:** Settings panel shows installed/not-installed states; API key field saves and masks value.
- **Container smoke test:** Build image, verify `codex --version` on `$PATH`, start server, confirm `agent_list` reports codex as installed.

---

## Risks

| Risk | Mitigation |
|---|---|
| `@openai/codex` package size bloats container image | Measure before/after; it's an npm CLI package, typically small |
| Codex CLI version incompatibility with adapter | Pin version in Dockerfile; adapter logs binary version on startup |
| API key stored in `process.env` visible to all child processes | Acceptable for single-user container; key is never written to disk or sent over WS |
| `which` command not available in minimal containers | Fall back to `command -v` or attempt spawn and catch `ENOENT` |
