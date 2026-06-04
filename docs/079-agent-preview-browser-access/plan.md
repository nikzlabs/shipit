
# Agent Preview Browser Access

Give the Claude agent the ability to see and interact with the live preview — navigate pages, click buttons, read DOM state, and take screenshots. Today the agent writes code blind; it cannot verify what the preview actually renders.

## Motivation

The agent can edit files and run shell commands, but has zero visibility into the running preview. Common failure modes:

- Agent writes a form but can't verify the submit button works
- Agent fixes a CSS bug but can't confirm the layout looks right
- Agent builds a multi-step flow but can't click through it to test
- User has to manually describe what they see, copy-pasting errors

Browser access closes this loop: the agent can verify its own work, catch regressions, and iterate without round-tripping through the user.

## Design

### Tool delivery: MCP server

Claude CLI natively supports MCP servers via the `--mcp-config` flag. We run a Playwright MCP server inside the session container that exposes browser tools. The agent sees them as regular tools alongside Read, Write, Bash, etc.

No changes to the agent adapter protocol — MCP is handled entirely by the CLI.

### Browser lifecycle

The MCP server process starts with the CLI (lightweight Node process, no browser yet). **The actual Chromium instance launches lazily on the first browser tool call** and is reused for subsequent calls within the same agent turn. This means:

- Sessions that never use browser tools pay zero cost
- The browser starts only when the agent decides it needs to look at something
- Chromium is killed when the agent process exits (end of turn)

### Tool surface

The Playwright MCP server provides these tools (standard `@playwright/mcp` surface):

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to a URL (read-only — does not mutate state) |
| `browser_snapshot` | Get an accessibility-tree snapshot of the page |
| `browser_click` | Click an element by accessibility reference |
| `browser_type` | Type text into an input field |
| `browser_take_screenshot` | Capture a PNG screenshot of the viewport |
| `browser_scroll` | Scroll the page up/down |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Select a dropdown option |

> **Note**: Verify the exact tool surface against the installed `@playwright/mcp` version before implementation. The list above is based on the current published package.

The snapshot tool is the primary way the agent "reads" the page — it returns a structured accessibility tree, not raw HTML. This is far more useful than DOM scraping for understanding what's on screen.

### Container topology

The browser runs inside the **session container** (where the agent lives), connecting to the preview container's dev server over the Docker bridge network:

```
┌─ Session Container ──────────────────┐   ┌─ Preview Container ────┐
│                                      │   │                        │
│  Claude CLI                          │   │  Dev server (:5173)    │
│    ├── MCP: Playwright server        │   │                        │
│    │     └── Chromium (lazy)  ───────┼──→│                        │
│    ├── Read, Write, Edit, Bash...    │   │                        │
│                                      │   │                        │
└──────────────────────────────────────┘   └────────────────────────┘
```

The browser navigates to the preview container's internal URL (e.g., `http://<preview-host>:5173`), not the external proxy URL. This avoids routing through the orchestrator and keeps traffic on the local Docker network.

### Preview URL data flow

The session container doesn't know the preview container's address today. The preview URL is delivered at **agent start time** (not container creation time) via the existing `/agent/start` HTTP body. This avoids the sequencing problem where the preview container hasn't been created yet when the session container starts.

Here's the full data flow:

1. **Orchestrator knows the preview URL.** `ContainerSessionRunner` holds `previewWorkerUrl` (set via `setPreviewWorkerUrl()` when the preview container starts) and `_detectedPorts` (populated from preview status). The preview container's dev server address is derived from these: same host as `previewWorkerUrl`, with the detected preview port.

2. **Orchestrator passes preview URL at agent start time.** `_startAgentViaProxy()` in `container-session-runner.ts` already POSTs to `/agent/start` with `{ agentId, params }`. We add a `previewUrl` field to `AgentRunParams` in `agent-types.ts`. The orchestrator resolves the preview URL from `previewWorkerUrl` + detected port before calling `_startAgentViaProxy()`.

3. **Session worker receives preview URL in `/agent/start` body.** `session-worker.ts` reads `params.previewUrl` from the request, generates the MCP config file, injects the preview URL into the system prompt, and passes the MCP config path to the agent via `params.mcpConfigPath`. Line 160 already spreads params: `this.agent.run({ ...params, cwd: this.workspaceDir })`.

4. **Preview URL is absent when preview isn't running.** If `previewUrl` is null/undefined, the MCP config is still generated (browser tools still work for external URLs), but the system prompt omits the preview URL section and instead says: "The preview is not running yet. You can use browser tools to navigate to external URLs."

5. **Stale URL on port change.** If the preview restarts mid-turn and the port changes, the URL in the system prompt goes stale. Mitigation for v1: the system prompt tells the agent to retry on connection error. Concrete v2 improvement: write the current preview port to a well-known file (`/tmp/preview-port`) that the session worker updates via a new `POST /config/preview-port` endpoint on preview restart. The MCP server's environment can include this path so it resolves the port dynamically.

### MCP configuration

The session worker generates an MCP config file at agent start time and passes it to the CLI. The `@playwright/mcp` package is **pre-installed in the Docker image** with a pinned version (not fetched via `npx` at runtime):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "sh",
      "args": ["-c", "… exec playwright-mcp --browser chromium --headless --no-sandbox --output-dir /tmp/.playwright-mcp"]
    }
  }
}
```

**`--browser chromium` is required.** Our Dockerfiles install Chromium (Google
Chrome doesn't ship for Linux ARM64). Without this flag, `@playwright/mcp`
defaults to `chrome` and every browser tool call fails on first invocation with
`Chromium distribution 'chrome' is not found at /opt/google/chrome/chrome` —
which used to look like a "session died" symptom to the user.

The config file is written to `/tmp/mcp-config-<sessionId>.json` (deterministic path, overwritten per turn rather than accumulated). Cleanup happens in the `onExit` handler of `ClaudeProcess`.

### Preview URL injection

The agent needs to know where the preview is. We add to the system prompt in `agent-instructions.ts`:

```
## Browser access

You have browser tools available (browser_navigate, browser_snapshot, browser_click, etc.)
that let you interact with the live preview. The preview is running at:

  {previewUrl}

This is the primary preview port. If the project serves on multiple ports, adjust
the port number as needed.

Use browser_snapshot to see what's on the page. Use browser_click and browser_type
to interact with UI elements. This is useful for verifying your changes work correctly.

Only use browser tools when you need to verify or debug UI behavior — don't use them
for every change. File edits with hot reload are usually sufficient.

If the preview is not running or you get a connection error, the dev server may not
have started yet. Wait a moment and try again, or check with the user.
```

The `{previewUrl}` placeholder is resolved at agent start time in `session-worker.ts` using the `previewUrl` field from `AgentRunParams`.

### Allowed tools

Browser tools are added to the auto-mode allowlist. The Claude CLI supports `mcp__<server>__*` wildcard patterns in `--allowedTools` to allow all tools from a named MCP server:

```typescript
const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__*";
```

> **Action item**: Verify wildcard support in `--allowedTools` before implementation. If the CLI requires exact names, enumerate each tool explicitly. The plan/normal mode lists below already use explicit names as a fallback-safe pattern.

For plan and normal modes, only read-only browser tools are allowed. `browser_navigate` is included because it's read-only (doesn't mutate state) and is required before `browser_snapshot` can read a page:

```typescript
const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot";
const NORMAL_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot";
```

### `ClaudeProcess.run()` signature change

`ClaudeProcess.run()` currently takes 6 positional parameters. Rather than adding a 7th, refactor to an options object:

```typescript
// Before:
run(prompt, sessionId, systemPrompt, images, cwd, permissionMode)

// After:
interface ClaudeRunOptions {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  images?: ImageAttachment[];
  cwd?: string;
  permissionMode?: PermissionMode;
  mcpConfigPath?: string;  // NEW
}
run(opts: ClaudeRunOptions)
```

**Call sites that must be updated atomically:**
- `ClaudeAdapter.run()` (line 124) — currently destructures `AgentRunParams` and calls `this.inner.run()` with positional args
- `session-worker.ts` standalone entry point (line ~583) — directly instantiates and calls `ClaudeProcess.run()`
- All tests that call `ClaudeProcess.run()` directly

The `AgentRunParams` type in `agent-types.ts` gets two new optional fields: `mcpConfigPath?: string` and `previewUrl?: string`.

### Tool activity labels

Browser tool calls appear in the UI's activity stream. The `activityFromTool()` function in `StreamingIndicator.tsx` needs new cases. Add a generic `mcp__` prefix handler in the `default` branch that works for any MCP server, with specific labels for known Playwright tools:

```typescript
default: {
  // Generic MCP tool handling — works for any MCP server
  if (toolName.startsWith("mcp__")) {
    // Known Playwright browser tool labels
    const BROWSER_LABELS: Record<string, string> = {
      "mcp__playwright__browser_navigate": "Navigating to page",
      "mcp__playwright__browser_snapshot": "Reading page content",
      "mcp__playwright__browser_click": "Clicking element",
      "mcp__playwright__browser_type": "Typing text",
      "mcp__playwright__browser_take_screenshot": "Taking screenshot",
      "mcp__playwright__browser_scroll": "Scrolling page",
      "mcp__playwright__browser_hover": "Hovering element",
      "mcp__playwright__browser_select_option": "Selecting option",
    };
    const label = BROWSER_LABELS[toolName];
    if (label) {
      return { label, tool: toolName };
    }
    // Fallback for unknown MCP tools: "mcp__foo__bar_baz" → "Using bar baz..."
    const parts = toolName.split("__");
    const toolPart = parts.length >= 3 ? parts.slice(2).join(" ").replace(/_/g, " ") : toolName;
    return { label: `Using ${toolPart}...`, tool: toolName };
  }
  return { label: `Using ${toolName}...`, tool: toolName };
}
```

This approach future-proofs for additional MCP servers without requiring code changes for each one.

Additionally, add a `"browser"` variant to the `CanonicalTool` union in `tool-map.ts` and map the MCP tool names to it. This is safe — `CanonicalTool` is currently only consumed by `canonicalizeTool()` and `agentToolName()` in `tool-map.ts` itself (plus tests and the barrel export in `agents/index.ts`). No downstream code switches on canonical names for tool-specific behavior like diff rendering:

```typescript
export type CanonicalTool = /* existing */ | "browser";

const CLAUDE_TOOL_MAP: Record<string, CanonicalTool> = {
  // ...existing mappings...
  // MCP browser tools (prefixed by CLI)
  "mcp__playwright__browser_navigate": "browser",
  "mcp__playwright__browser_snapshot": "browser",
  "mcp__playwright__browser_click": "browser",
  "mcp__playwright__browser_type": "browser",
  "mcp__playwright__browser_take_screenshot": "browser",
  "mcp__playwright__browser_scroll": "browser",
  "mcp__playwright__browser_hover": "browser",
  "mcp__playwright__browser_select_option": "browser",
};
```

## Key files to modify

| File | Change |
|------|--------|
| `src/server/session/claude.ts` | Refactor `run()` to options object; add `--mcp-config` flag; clean up config in `onExit` |
| `src/server/session/session-worker.ts` | Generate MCP config file at `/agent/start` using `params.previewUrl`; also update standalone entry point |
| `src/server/session/agents/claude-adapter.ts` | Update `run()` to forward options object (not positional args) to `ClaudeProcess` |
| `src/server/shared/types/agent-types.ts` | Add `mcpConfigPath?: string` and `previewUrl?: string` to `AgentRunParams` |
| `src/server/session/agents/tool-map.ts` | Add `"browser"` to `CanonicalTool`; add MCP tool mappings to `CLAUDE_TOOL_MAP` |
| `src/client/components/StreamingIndicator.tsx` | Add generic `mcp__` prefix handler with Playwright labels to `activityFromTool()` |
| `src/server/orchestrator/agent-instructions.ts` | Add browser access section to system prompt template |
| `src/server/orchestrator/container-session-runner.ts` | Resolve preview URL from `previewWorkerUrl` + detected port; pass in `AgentRunParams` to `_startAgentViaProxy()` |
| `src/server/orchestrator/proxy-agent-process.ts` | Forward `previewUrl` through to container |
| `Dockerfile.session-worker.dev` | Install `@playwright/mcp` (pinned) + `npx playwright install-deps chromium` + `npx @playwright/mcp install-browser chrome-for-testing` |

## Considerations

### Container image size

Chromium adds ~400MB to the session container image. The Dockerfile needs both the browser and its system dependencies:

```dockerfile
RUN npm install -g @playwright/mcp \
    && npx playwright install-deps chromium \
    && npx @playwright/mcp install-browser chrome-for-testing
```

`playwright install-deps chromium` installs the required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgbm1`, `libx11-6`, etc.) via `apt-get`. We then fetch the actual browser binary via `@playwright/mcp install-browser chrome-for-testing` — recent `@playwright/mcp` versions resolve the `chromium` browser channel to a `chrome-for-testing` build, so the plain `playwright install chromium` download is no longer the binary the MCP server looks for. Put both commands in their own Docker layer for caching.

Recommendation: bake it into the image. The lazy browser launch already avoids runtime cost for sessions that don't use it. Paying 400MB of disk to avoid 30s of download latency on first use is worth it.

### Memory

Chromium uses ~100-200MB of RAM. Session containers have memory limits. May need to bump the limit when browser tools are active. Monitor in practice before over-engineering.

### Security

The browser runs inside the already-sandboxed session container. It can only reach:
- The preview container (over Docker bridge network)
- External URLs (same as the agent's WebFetch tool)

No additional attack surface beyond what the agent already has via Bash.

### Screenshot delivery

Screenshots from `browser_take_screenshot` are returned as base64 in the MCP tool result. The CLI includes them in the NDJSON event stream as image content blocks. The existing image rendering in the chat UI handles display — no new plumbing needed.

Note: a 1280x720 PNG screenshot is ~500KB-1MB base64. This flows through the PTY buffer, NDJSON parser, SSE stream, and WebSocket. Verify that no message size limits are hit in practice (e.g., `MAX_TURN_BUFFER` at 1000 events in `container-session-runner.ts`, WebSocket frame size limits).

### PTY noise from MCP server

The MCP server is a child process of the CLI, running inside the PTY. If it writes to stdout/stderr, output will be mixed into the PTY data stream. The `drainLines()` parser in `claude.ts` treats non-JSON lines as log output (`[claude] non-JSON line:...`), so it won't crash — but it may be noisy. Monitor and suppress if needed.

### Codex agent

**Update:** Codex now also gets browser access. The original claim here — "Codex
uses JSON-RPC and does not support MCP servers" — became obsolete once the Codex
adapter learned to register MCP servers via a `[mcp_servers.*]` block in
`~/.codex/config.toml` (docs/125, docs/155). For a while Codex registered the
ShipIt bridges (review, present, voice, ask, bug) and user servers but *not*
Playwright, so the shared system prompt advertised a browser the agent didn't
actually have.

The Playwright server definition now lives in
`src/server/session/agents/playwright-mcp.ts` and is consumed by both adapters:

- **Claude** writes it into the per-turn `--mcp-config` JSON.
- **Codex** writes a `[mcp_servers.playwright]` block into `config.toml`.

Codex runs with `approvalPolicy: "never"`, so the browser tools auto-approve
exactly like every other tool — no Claude-style `--allowedTools` allowlisting is
required on the Codex side.

### Alternatives considered

**DOM-only access (jsdom/fetch)** — No JS execution, can't click buttons, can't see rendered layout. Doesn't solve the core problem.

**Browser sidecar container** — Shared Chromium instance across sessions. More complex orchestration (lifecycle, routing, isolation). Not worth it unless memory becomes a real problem.

**Expose orchestrator's Playwright MCP** — Route browser commands through the orchestrator instead of running Chromium in-container. Adds latency, complexity, and a new proxy layer. The in-container approach is simpler.

**`PREVIEW_HOST` env var at container creation** — Rejected because the session container starts before the preview container, so the preview IP is unknown at session container creation time. Docker env vars can't be updated post-creation. Passing the preview URL at agent start time (via `AgentRunParams` in the `/agent/start` HTTP body) avoids this sequencing problem entirely — the orchestrator has the preview URL by then.
