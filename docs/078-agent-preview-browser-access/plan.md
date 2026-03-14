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
| `browser_fill_form` | Fill a form field |

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

The browser navigates to the preview container's internal URL (e.g., `http://<preview-container>:5173`), not the external proxy URL. This avoids routing through the orchestrator and keeps traffic on the local Docker network.

### MCP configuration

The session worker generates an MCP config file at agent start time and passes it to the CLI:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@anthropic-ai/mcp-playwright@latest"],
      "env": {
        "PLAYWRIGHT_HEADLESS": "true"
      }
    }
  }
}
```

This is written to a temp file and passed via `--mcp-config <path>`. The config is generated per-agent-run so we can inject the correct preview URL into the system prompt dynamically.

### Preview URL injection

The agent needs to know where the preview is. We add to the system prompt:

```
## Browser access

You have browser tools available (browser_navigate, browser_snapshot, browser_click, etc.)
that let you interact with the live preview. The preview is running at:

  {previewUrl}

Use browser_snapshot to see what's on the page. Use browser_click and browser_type
to interact with UI elements. This is useful for verifying your changes work correctly.

Only use browser tools when you need to verify or debug UI behavior — don't use them
for every change. File edits with hot reload are usually sufficient.
```

The preview URL is resolved at agent start time from the preview container's address and detected port.

### Allowed tools

Browser tools are added to the auto-mode allowlist:

```typescript
const AUTO_TOOLS = "Write,Read,Edit,Bash,Glob,Grep,WebFetch,WebSearch,AskUserQuestion,mcp__playwright__*";
```

The `mcp__playwright__*` wildcard allows all tools from the Playwright MCP server. In plan mode and normal mode, browser tools are read-only (snapshot and screenshot only).

### Tool activity labels

Browser tool calls appear in the UI's activity stream. Add mappings to `tool-map.ts`:

```typescript
"mcp__playwright__browser_navigate"  → "Navigating to page"
"mcp__playwright__browser_snapshot"  → "Reading page content"
"mcp__playwright__browser_click"     → "Clicking element"
"mcp__playwright__browser_type"      → "Typing text"
"mcp__playwright__browser_take_screenshot" → "Taking screenshot"
```

## Key files to modify

| File | Change |
|------|--------|
| `src/server/session/claude.ts` | Add `--mcp-config` flag to CLI args |
| `src/server/session/session-worker.ts` | Generate MCP config file with preview URL at agent start |
| `src/server/session/agents/claude-adapter.ts` | Pass MCP config path through to ClaudeProcess |
| `src/server/session/agents/agent-process.ts` | Add `previewUrl` to `AgentRunParams` |
| `src/server/session/agents/tool-map.ts` | Add browser tool label mappings |
| `src/server/orchestrator/agent-instructions.ts` | Add browser access section to system prompt |
| `src/server/orchestrator/proxy-agent-process.ts` | Forward preview URL to container |
| `src/server/orchestrator/worker-http.ts` | Include preview URL in agent start request |
| `Dockerfile` (session image) | Install Chromium + Playwright deps |

## Considerations

### Container image size

Chromium adds ~400MB to the session container image. Mitigation options:

1. **Separate layer** — Chromium in its own Docker layer so it's cached and shared across image updates
2. **On-demand install** — `npx playwright install chromium` on first browser tool use instead of baking into the image. Slower first use (~30s) but smaller base image
3. **Accept it** — 400MB is meaningful but not prohibitive for a container that already has Node, Claude CLI, and dev tools

Recommendation: bake it into the image. The lazy browser launch already avoids runtime cost for sessions that don't use it. Paying 400MB of disk to avoid 30s of latency on first use is worth it.

### Memory

Chromium uses ~100-200MB of RAM. Session containers currently have memory limits. May need to bump the limit or make it conditional. Monitor in practice before over-engineering.

### Security

The browser runs inside the already-sandboxed session container. It can only reach:
- The preview container (over Docker bridge network)
- External URLs (same as the agent's WebFetch tool)

No additional attack surface beyond what the agent already has via Bash.

### Screenshot delivery

Screenshots from `browser_take_screenshot` are returned as base64 in the MCP tool result. The CLI includes them in the NDJSON event stream as image content blocks. The existing image rendering in the chat UI handles display — no new plumbing needed.

### Alternatives considered

**DOM-only access (jsdom/fetch)** — No JS execution, can't click buttons, can't see rendered layout. Doesn't solve the core problem.

**Browser sidecar container** — Shared Chromium instance across sessions. More complex orchestration (lifecycle, routing, isolation). Not worth it unless memory becomes a real problem.

**Expose orchestrator's Playwright MCP** — Route browser commands through the orchestrator instead of running Chromium in-container. Adds latency, complexity, and a new proxy layer. The in-container approach is simpler.
