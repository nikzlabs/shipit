---
status: planned
---

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

The Playwright MCP server provides these tools (standard `@anthropic-ai/mcp-playwright` surface):

| Tool | Purpose |
|------|---------|
| `browser_navigate` | Go to a URL |
| `browser_snapshot` | Get an accessibility-tree snapshot of the page (text, buttons, links, form fields) |
| `browser_click` | Click an element by accessibility reference |
| `browser_type` | Type text into an input field |
| `browser_take_screenshot` | Capture a PNG screenshot of the viewport |
| `browser_scroll` | Scroll the page up/down |
| `browser_hover` | Hover over an element |
| `browser_select_option` | Select a dropdown option |

> **Note**: Verify the exact tool surface against the installed `@anthropic-ai/mcp-playwright` version before implementation. The list above is based on the current published package.

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

The session container doesn't know the preview container's address today. Here's the full data flow to get it there:

1. **Orchestrator knows the preview URL.** `ContainerSessionRunner` holds `previewWorkerUrl` (set via `setPreviewWorkerUrl()` when the preview container starts). The preview container's dev server address is derived from this (same host, different port).

2. **Pass `PREVIEW_HOST` as a container env var.** At session container creation time (`SessionContainerManager`), set `PREVIEW_HOST=<preview-container-ip>` in the container's environment, alongside existing env vars like `WORKSPACE_DIR`. This is simpler than threading it through `AgentRunParams` — it's always available and doesn't require changes to the agent type system.

3. **Session worker reads `PREVIEW_HOST`.** When generating the MCP config and system prompt at `/agent/start` time, `session-worker.ts` reads `process.env.PREVIEW_HOST` to construct the preview URL. If the preview port is dynamic, the orchestrator can also pass `PREVIEW_PORT` as an env var (updated on preview restart via a worker HTTP call).

4. **Stale URL handling.** If the preview restarts and the port changes mid-turn, the URL in the system prompt goes stale. This is acceptable for v1 — the agent can re-navigate if it gets a connection error. Future improvement: the MCP server could resolve the port dynamically by querying the preview worker's `/preview/status` endpoint.

### MCP configuration

The session worker generates an MCP config file at agent start time and passes it to the CLI. The `@anthropic-ai/mcp-playwright` package is **pre-installed in the Docker image** with a pinned version (not fetched via `npx` at runtime):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "mcp-playwright",
      "env": {
        "PLAYWRIGHT_HEADLESS": "true"
      }
    }
  }
}
```

The config file is written to `/tmp/mcp-config-<sessionId>.json` (deterministic path, overwritten per turn rather than accumulated). Cleanup happens in the `onExit` handler.

### Preview URL injection

The agent needs to know where the preview is. We add to the system prompt in `agent-instructions.ts`:

```
## Browser access

You have browser tools available (browser_navigate, browser_snapshot, browser_click, etc.)
that let you interact with the live preview. The preview is running at:

  {previewUrl}

Use browser_snapshot to see what's on the page. Use browser_click and browser_type
to interact with UI elements. This is useful for verifying your changes work correctly.

Only use browser tools when you need to verify or debug UI behavior — don't use them
for every change. File edits with hot reload are usually sufficient.

If the preview is not running or you get a connection error, the dev server may not
have started yet. Wait a moment and try again, or check with the user.
```

The `{previewUrl}` placeholder is resolved at agent start time in `session-worker.ts` using `PREVIEW_HOST` and the detected preview port.

### Allowed tools

Browser tools are added to the auto-mode allowlist. The Claude CLI supports `mcp__<server>__*` wildcard patterns in `--allowedTools` to allow all tools from a named MCP server:

```typescript
const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__*";
```

> **Action item**: Verify wildcard support in `--allowedTools` before implementation. If the CLI requires exact names, enumerate each tool explicitly.

For plan and normal modes, only read-only browser tools are allowed:

```typescript
const PLAN_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot";
const NORMAL_TOOLS = "Read,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__browser_snapshot,mcp__playwright__browser_take_screenshot";
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

`ClaudeAdapter.run()` extracts `mcpConfigPath` from the MCP config file generated by the session worker and passes it through. The `AgentRunParams` type in `agent-types.ts` gets a new optional `mcpConfigPath` field.

### Tool activity labels

Browser tool calls appear in the UI's activity stream. The `activityFromTool()` function in `StreamingIndicator.tsx` needs new cases. Rather than adding individual cases for every MCP tool, add a generic `mcp__` prefix handler in the `default` branch:

```typescript
default: {
  // Generic MCP tool label: "mcp__playwright__browser_navigate" → "Navigating browser"
  if (toolName.startsWith("mcp__playwright__browser_")) {
    const action = toolName.replace("mcp__playwright__browser_", "");
    const labels: Record<string, string> = {
      navigate: "Navigating to page",
      snapshot: "Reading page content",
      click: "Clicking element",
      type: "Typing text",
      take_screenshot: "Taking screenshot",
      scroll: "Scrolling page",
      hover: "Hovering element",
      select_option: "Selecting option",
    };
    return { label: labels[action] ?? `Browser: ${action}`, tool: toolName };
  }
  return { label: `Using ${toolName}...`, tool: toolName };
}
```

Additionally, add a `"browser"` variant to the `CanonicalTool` union in `tool-map.ts` and map the MCP tool names to it, so code that uses `canonicalizeTool()` can identify browser tools:

```typescript
export type CanonicalTool = /* existing */ | "browser";

const CLAUDE_TOOL_MAP: Record<string, CanonicalTool> = {
  // ...existing mappings...
  // MCP browser tools (prefixed by CLI)
  "mcp__playwright__browser_navigate": "browser",
  "mcp__playwright__browser_snapshot": "browser",
  "mcp__playwright__browser_click": "browser",
  // etc.
};
```

## Key files to modify

| File | Change |
|------|--------|
| `src/server/session/claude.ts` | Refactor `run()` to options object; add `--mcp-config` flag |
| `src/server/session/session-worker.ts` | Generate MCP config file at `/agent/start`; read `PREVIEW_HOST` env var |
| `src/server/session/agents/claude-adapter.ts` | Forward `mcpConfigPath` from `AgentRunParams` to `ClaudeProcess` |
| `src/server/shared/types/agent-types.ts` | Add `mcpConfigPath?: string` to `AgentRunParams` |
| `src/server/session/agents/tool-map.ts` | Add `"browser"` to `CanonicalTool`; add MCP tool mappings to `CLAUDE_TOOL_MAP` |
| `src/client/components/StreamingIndicator.tsx` | Add browser tool labels to `activityFromTool()` |
| `src/server/orchestrator/agent-instructions.ts` | Add browser access section to system prompt |
| `src/server/orchestrator/session-container.ts` | Pass `PREVIEW_HOST` env var at container creation |
| `src/server/orchestrator/container-session-runner.ts` | Resolve preview host/port for env var injection |
| `Dockerfile.session-worker.dev` | Install `@anthropic-ai/mcp-playwright` (pinned) + `npx playwright install --with-deps chromium` |

## Considerations

### Container image size

Chromium adds ~400MB to the session container image. The Dockerfile needs both the browser and its system dependencies:

```dockerfile
RUN npm install -g @anthropic-ai/mcp-playwright@<pinned-version> \
    && npx playwright install --with-deps chromium
```

The `--with-deps` flag installs required system libraries (`libnss3`, `libatk-bridge2.0-0`, `libgbm1`, `libx11-6`, etc.) via `apt-get`. Put this in its own Docker layer for caching.

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

Note: a 1280x720 PNG screenshot is ~500KB-1MB base64. This flows through the PTY buffer, NDJSON parser, SSE stream, and WebSocket. Verify that no message size limits are hit in practice (e.g., `MAX_TURN_BUFFER` event count in `container-session-runner.ts`, WebSocket frame size).

### PTY noise from MCP server

The MCP server is a child process of the CLI, running inside the PTY. If it writes to stdout/stderr, output will be mixed into the PTY data stream. The `drainLines()` parser in `claude.ts` treats non-JSON lines as log output (`[claude] non-JSON line:...`), so it won't crash — but it may be noisy. Monitor and suppress if needed.

### Codex agent

This design only covers the Claude CLI. The Codex agent uses JSON-RPC and does not support MCP servers. Browser tools will not be available when using Codex. This is a known limitation — Codex is a secondary agent with limited tool support already.

### Alternatives considered

**DOM-only access (jsdom/fetch)** — No JS execution, can't click buttons, can't see rendered layout. Doesn't solve the core problem.

**Browser sidecar container** — Shared Chromium instance across sessions. More complex orchestration (lifecycle, routing, isolation). Not worth it unless memory becomes a real problem.

**Expose orchestrator's Playwright MCP** — Route browser commands through the orchestrator instead of running Chromium in-container. Adds latency, complexity, and a new proxy layer. The in-container approach is simpler.

**Thread preview URL through `AgentRunParams`** — More explicit but requires touching the agent type system, every call site that constructs params, and the `/agent/start` HTTP body schema. An env var set at container creation is simpler and always available.
