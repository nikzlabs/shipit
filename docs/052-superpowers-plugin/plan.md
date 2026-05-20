---
status: planned
priority: low
description: Integrate the Superpowers Claude Code plugin to give agents structured development workflows (TDD, brainstorming, code review) inside ShipIt sessions.
---

# 052 — Superpowers Plugin Integration

## Problem

ShipIt users currently get "raw" Claude — capable, but without the structured development workflows that make agentic coding reliable at scale. The [Superpowers](https://github.com/obra/superpowers) plugin for Claude Code provides composable skills (TDD, systematic debugging, brainstorming, code review, implementation planning) that transform Claude from a code generator into a disciplined development partner. Users of the standalone Claude Code CLI can install Superpowers via the plugin marketplace, but ShipIt has no mechanism to discover, install, or activate Claude Code plugins — leaving ShipIt users without access to the most popular productivity extension in the ecosystem.

## Goals

1. **First-class Superpowers support** — ShipIt sessions can activate the Superpowers plugin so Claude follows its structured development workflows (brainstorm → plan → TDD → review).
2. **General plugin architecture** — the integration is built on a general-purpose plugin system so other Claude Code plugins work too, not just Superpowers.
3. **Per-session plugin control** — users can enable/disable plugins per session. A data-science session might want different plugins than a web-app session.
4. **Transparent skill activation** — when Superpowers skills fire (brainstorming, TDD, debugging), the UI surfaces this so users understand what Claude is doing and why.
5. **Zero-config default** — Superpowers is pre-installed and enabled by default for new sessions. Users who don't want it can disable it.

## Non-goals

- Building our own skills framework. We adopt the Claude Code plugin protocol as-is.
- Plugin authoring UI. Users author plugins externally; ShipIt consumes them.
- MCP server hosting within ShipIt (plugins that bundle MCP servers are Phase 2).
- LSP server integration (Phase 2 — requires language server binaries in the container).
- Plugin marketplace browsing UI (Phase 2 — start with pre-bundled + manual install).

---

## Background: Claude Code plugin protocol

Claude Code plugins are directories with a standard layout:

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Manifest (name, version, description)
├── skills/                  # Auto-invoked context providers
│   └── my-skill/
│       └── SKILL.md         # Markdown instructions + frontmatter
├── commands/                # User-invoked slash commands (legacy)
├── agents/                  # Subagent definitions (Markdown)
├── hooks/
│   └── hooks.json           # Event handlers (PreToolUse, PostToolUse, etc.)
├── .mcp.json                # Bundled MCP servers (optional)
└── .lsp.json                # Bundled LSP servers (optional)
```

**Skills** are the core mechanism. Each `SKILL.md` contains markdown instructions that get injected into Claude's system prompt. Frontmatter controls invocation:

```markdown
---
description: Test-driven development workflow
disable-model-invocation: false   # Claude can auto-invoke
user-invocable: true              # User can /invoke manually
---

# TDD Skill

When implementing a feature, follow the RED-GREEN-REFACTOR cycle...
```

Claude Code's runtime automatically loads matching skills based on conversation context. Skills aren't "called" like tools — they're injected as behavioral instructions that shape how Claude approaches tasks.

**Hooks** are event handlers that run shell commands or LLM prompts at specific lifecycle points (PreToolUse, PostToolUse, Stop, SessionStart, etc.). Superpowers uses hooks to enforce discipline — e.g., blocking code writes that don't follow TDD.

**Superpowers specifically** provides these skills:
- **brainstorming** — Socratic requirements refinement before coding
- **write-plan / execute-plan** — structured implementation planning with batched execution
- **test-driven-development** — RED-GREEN-REFACTOR enforcement
- **systematic-debugging** — four-phase root cause methodology
- **requesting-code-review** — inter-task review against the plan
- **self-authoring skills** — Claude can create new skills as it works

---

## Architecture overview

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  Browser UI  │◄─ws──►│  Fastify server   │──────►│  AgentProcess    │
│              │       │                   │       │  (Claude CLI)    │
│ Plugin       │       │ PluginManager     │       └────────┬─────────┘
│ settings UI  │       │   ↓ loads         │                │
│              │       │ PluginRegistry    │    Skills injected via
│ Skill        │       │   ↓ resolves      │    --system-prompt and
│ activity     │       │ Skills, Hooks,    │    --allowedTools flags
│ indicators   │       │ Agents, Commands  │                │
└─────────────┘       └──────────────────┘    Hooks run as shell
                                               commands in session dir
```

The key insight: ShipIt already spawns the Claude CLI as a child process (via `ClaudeAdapter`). The Claude CLI **natively supports** the plugin protocol — it loads `plugin.json`, discovers skills, injects them into the system prompt, and runs hooks. ShipIt's job is to:

1. **Manage plugin files** on disk (install, update, enable/disable)
2. **Pass plugin configuration** to the Claude CLI at spawn time
3. **Surface plugin activity** in the UI (which skills activated, hook outcomes)
4. **Provide per-session control** over which plugins are active

---

## Design

### 1. Plugin storage and discovery

Plugins live in a shared directory outside session workspaces:

```
/workspace/plugins/
├── superpowers/           # Pre-bundled
│   ├── .claude-plugin/
│   │   └── plugin.json
│   ├── skills/
│   │   ├── brainstorming/SKILL.md
│   │   ├── test-driven-development/SKILL.md
│   │   └── ...
│   └── hooks/hooks.json
├── superpowers-lab/       # Optional add-on
│   └── ...
└── custom-plugin/         # User-installed
    └── ...
```

A new `PluginManager` class handles:

```typescript
// src/server/plugin-manager.ts

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: { name: string; email?: string; url?: string };
  keywords?: string[];
}

export interface PluginInfo {
  id: string;               // directory name
  manifest: PluginManifest;
  path: string;             // absolute path on disk
  skills: SkillInfo[];
  agents: AgentInfo[];
  hooks: HookConfig | null;
  hasMcp: boolean;
  hasLsp: boolean;
}

export interface SkillInfo {
  name: string;             // directory name under skills/
  description: string;      // from SKILL.md frontmatter
  userInvocable: boolean;
  modelInvocable: boolean;
}

export class PluginManager {
  constructor(private pluginsDir: string) {}

  /** Scan pluginsDir and parse all plugin manifests + components */
  async discoverPlugins(): Promise<PluginInfo[]> { ... }

  /** Get a single plugin by ID */
  async getPlugin(id: string): Promise<PluginInfo | null> { ... }

  /** Install a plugin from a Git URL (clone into pluginsDir) */
  async installPlugin(repoUrl: string): Promise<PluginInfo> { ... }

  /** Update a plugin (git pull) */
  async updatePlugin(id: string): Promise<PluginInfo> { ... }

  /** Remove a plugin from disk */
  async removePlugin(id: string): Promise<void> { ... }
}
```

### 2. Per-session plugin configuration

Session metadata gains a `plugins` field:

```typescript
// Addition to SessionMetadata in src/server/types/domain-types.ts

interface SessionMetadata {
  // ... existing fields ...
  plugins?: SessionPluginConfig;
}

interface SessionPluginConfig {
  /** Plugin IDs enabled for this session. null = use defaults. */
  enabled: string[] | null;
  /** Per-plugin overrides (e.g., disable specific skills). */
  overrides?: Record<string, PluginOverride>;
}

interface PluginOverride {
  disabledSkills?: string[];   // skill names to suppress
  disabledHooks?: string[];    // hook event names to suppress
}
```

When `enabled` is `null`, the system uses the global default (Superpowers enabled). Users can explicitly set an empty array `[]` to disable all plugins for a session.

### 3. CLI integration — passing plugins to Claude

The `ClaudeAdapter` already constructs CLI arguments in its `run()` method. Plugin integration adds the `--plugin-dir` flag:

```typescript
// In src/server/agents/claude-adapter.ts, within buildArgs()

// For each enabled plugin, add --plugin-dir
for (const pluginPath of resolvedPluginPaths) {
  args.push("--plugin-dir", pluginPath);
}
```

The Claude CLI's `--plugin-dir` flag loads a plugin for the duration of the session. This is the cleanest integration point — no filesystem symlinks, no modifying Claude's global config. Each ShipIt session passes exactly the plugins it needs.

**Multiple plugins** are supported by passing `--plugin-dir` multiple times:

```
claude -p "..." --plugin-dir /workspace/plugins/superpowers \
                --plugin-dir /workspace/plugins/custom-plugin \
                --output-format stream-json --verbose
```

### 4. Surfacing skill activity in the UI

When Superpowers skills activate, Claude's behavior changes visibly (it asks brainstorming questions, writes tests before code, etc.), but the UI should also indicate *which skill is driving the behavior*.

**Detection approach**: Skills inject instructions that Claude follows, but there's no explicit "skill activated" event in the NDJSON stream. Instead, we detect skill activation through two signals:

1. **Slash command invocation** — when the user types `/superpowers:brainstorm` or Claude auto-invokes a skill, it appears in the assistant's tool use as a recognizable pattern. The `activityFromTool()` function in `StreamingIndicator.tsx` can map these.

2. **System prompt markers** — Superpowers skills include distinctive preambles ("## Brainstorming Phase", "## TDD: RED step") in Claude's output. A lightweight regex matcher in the message renderer can detect these and display a skill badge.

```typescript
// Addition to src/client/components/StreamingIndicator.tsx

// Detect superpowers skill invocations in tool activity
case "superpowers:brainstorm":
  return { label: "Brainstorming", icon: "lightbulb" };
case "superpowers:execute-plan":
  return { label: "Executing plan", icon: "list-checks" };
case "superpowers:write-plan":
  return { label: "Writing plan", icon: "pencil" };
```

**Skill badge component**: A small `<SkillBadge>` component renders inline in the message list when a skill is detected, showing the skill name and a brief description.

### 5. Plugin settings UI

A new "Plugins" section in the session settings panel:

```
┌─────────────────────────────────────────────┐
│ Plugins                                      │
├─────────────────────────────────────────────┤
│ ✓  Superpowers            v2.1.0    Update  │
│    TDD, brainstorming, code review           │
│    Skills: 6 enabled / 0 disabled            │
│                                              │
│ ✓  superpowers-lab        v1.3.0    Update  │
│    Experimental: tmux, interactive CLI        │
│    Skills: 3 enabled / 0 disabled            │
│                                              │
│ [+ Install plugin]                           │
└─────────────────────────────────────────────┘
```

Each plugin row shows:
- Toggle to enable/disable for this session
- Name, version, short description
- Skill count with expand-to-see-details
- Update button (triggers `PluginManager.updatePlugin()`)

Clicking a plugin expands its skill list with per-skill toggles for advanced users.

### 6. HTTP endpoints

Plugin management uses HTTP (stateless reads and mutations — no streaming or per-connection state needed):

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/plugins` | List all installed plugins with metadata |
| GET | `/api/plugins/:id` | Get single plugin details (skills, hooks, etc.) |
| POST | `/api/plugins/install` | Install plugin from Git URL |
| POST | `/api/plugins/:id/update` | Update plugin (git pull + re-scan) |
| DELETE | `/api/plugins/:id` | Uninstall plugin |
| PATCH | `/api/sessions/:id/plugins` | Update session's plugin configuration |

### 7. Service layer

```typescript
// src/server/services/plugins.ts

import type { PluginManager, PluginInfo } from "../plugin-manager.js";
import type { SessionManager } from "../sessions.js";

export async function listPlugins(
  pluginManager: PluginManager
): Promise<PluginInfo[]> {
  return pluginManager.discoverPlugins();
}

export async function installPlugin(
  pluginManager: PluginManager,
  repoUrl: string
): Promise<PluginInfo> {
  // Validate URL, clone, parse manifest
  return pluginManager.installPlugin(repoUrl);
}

export async function updateSessionPlugins(
  sessionManager: SessionManager,
  sessionId: string,
  config: SessionPluginConfig
): Promise<void> {
  // Update session metadata with new plugin config
  const session = await sessionManager.getSession(sessionId);
  if (!session) throw new ServiceError("Session not found", 404);
  await sessionManager.updateSession(sessionId, { plugins: config });
}

/** Resolve the final list of plugin directories for a session */
export function resolvePluginPaths(
  pluginManager: PluginManager,
  sessionPlugins: SessionPluginConfig | undefined,
  allPlugins: PluginInfo[]
): string[] {
  if (!sessionPlugins || sessionPlugins.enabled === null) {
    // Default: return all plugins marked as default-enabled
    return allPlugins.map(p => p.path);
  }
  return sessionPlugins.enabled
    .map(id => allPlugins.find(p => p.id === id))
    .filter(Boolean)
    .map(p => p!.path);
}
```

### 8. Dependency injection

`PluginManager` is added to `AppDeps` so tests can inject a stub:

```typescript
// Addition to AppDeps in src/server/index.ts

interface AppDeps {
  // ... existing deps ...
  pluginManager: PluginManager;
}
```

Test stubs return hardcoded plugin info without touching the filesystem.

---

## Integration with existing systems

### ClaudeAdapter changes

The `ClaudeAdapter.run()` method currently builds CLI args from `AgentRunParams`. It gains an optional `pluginDirs` parameter:

```typescript
export interface AgentRunParams {
  // ... existing fields ...
  pluginDirs?: string[];   // absolute paths to plugin directories
}
```

The `send-message` WebSocket handler resolves plugin paths from the session config before calling `runner.run()`.

### System prompt interaction

Superpowers skills inject instructions via the plugin protocol's system prompt mechanism, which is separate from ShipIt's own `--system-prompt` flag. Both compose — the Claude CLI merges the explicit system prompt with plugin-injected skill content. No conflict.

### Permission modes

Superpowers hooks may attempt to run shell commands (e.g., formatting, linting). These run in the session's workspace directory with the same permissions as the Claude CLI process. In `auto` permission mode, these execute without user intervention. In `normal` mode, the CLI's built-in permission system handles approval.

### Agent compatibility

The plugin system is designed around the Claude CLI. Other agent backends (Codex, Gemini) don't support the Claude Code plugin protocol. When a non-Claude agent is selected:
- Plugin UI is disabled with a tooltip: "Plugins are only supported with the Claude agent"
- `resolvePluginPaths()` returns `[]` for non-Claude agents
- No `--plugin-dir` flags are passed

---

## Superpowers pre-bundling

Superpowers is bundled with ShipIt rather than requiring user installation:

1. **Build step**: The ShipIt Docker image includes a `git clone` of `obra/superpowers` at a pinned version into `/workspace/plugins/superpowers/`.
2. **Version pinning**: A specific release tag is pinned in the Dockerfile. Updates are deliberate, tested, and shipped with ShipIt releases.
3. **Default enabled**: New sessions have `plugins: { enabled: null }` (use defaults), which includes Superpowers.
4. **User override**: Users can disable Superpowers per-session or globally via settings.

---

## Implementation phases

### Phase 1: Core plugin infrastructure + Superpowers

- `PluginManager` class (discover, read manifests)
- `resolvePluginPaths()` service function
- `--plugin-dir` flag support in `ClaudeAdapter`
- Per-session `plugins` field in `SessionMetadata`
- Pre-bundle Superpowers in Docker image
- HTTP endpoints: `GET /api/plugins`, `PATCH /api/sessions/:id/plugins`
- Basic plugin toggle UI in session settings

### Phase 2: Full plugin management

- `POST /api/plugins/install` (git clone)
- `POST /api/plugins/:id/update` (git pull)
- `DELETE /api/plugins/:id`
- Plugin install UI with URL input
- Per-skill toggle UI
- Skill activity indicators in chat

### Phase 3: Advanced integration

- MCP server support for plugins that bundle MCP servers
- Hook outcome display (blocked/allowed) in chat
- Plugin marketplace browsing UI
- LSP server integration (requires container toolchain setup)

---

## Key files

| File | Purpose |
|------|---------|
| `src/server/plugin-manager.ts` | **New** — Plugin discovery, manifest parsing, install/update/remove |
| `src/server/services/plugins.ts` | **New** — Plugin service functions (list, install, resolve paths) |
| `src/server/api-routes.ts` | Add plugin HTTP endpoints |
| `src/server/agents/claude-adapter.ts` | Add `--plugin-dir` flag support |
| `src/server/types/domain-types.ts` | Add `SessionPluginConfig`, `PluginOverride` types |
| `src/server/types/index.ts` | Re-export new types |
| `src/server/index.ts` | Wire `PluginManager` into `AppDeps` |
| `src/client/components/PluginSettings.tsx` | **New** — Plugin toggle UI |
| `src/client/components/SkillBadge.tsx` | **New** — Skill activity indicator |
| `src/client/components/StreamingIndicator.tsx` | Add skill activity labels |
| `Dockerfile` | Add Superpowers git clone step |

---

## Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Superpowers skills conflict with ShipIt's system prompt | Claude gets contradictory instructions | Test skill + system prompt combinations; ShipIt's system prompt should complement, not duplicate, Superpowers' workflow instructions |
| Plugin hooks run arbitrary shell commands | Security risk in shared environments | Hooks run sandboxed in the session workspace; review bundled plugin hooks at pin time; user-installed plugins require explicit trust |
| Superpowers updates break ShipIt | Session failures after update | Pin to specific release tags; test before bumping; users can disable per-session |
| Skill injection bloats the system prompt | Increased token usage, slower responses | Monitor token counts; allow per-skill disabling; consider skill selection heuristics |
| Claude CLI `--plugin-dir` flag changes | Integration breaks on CLI update | Pin Claude CLI version; integration tests that verify flag behavior |
| Non-Claude agents can't use plugins | Feature disparity between agents | Clearly communicate in UI; disable plugin controls for non-Claude agents |

## Open questions

1. **Skill selection granularity** — should ShipIt let users pick individual skills within Superpowers, or just toggle the whole plugin? Per-skill control is more flexible but adds UI complexity.
2. **Hook visibility** — when a Superpowers hook blocks an action (e.g., rejecting a code write that skipped TDD), should ShipIt show this in the chat stream? The Claude CLI may not surface hook outcomes in its NDJSON output.
3. **Plugin isolation** — should each session get its own copy of plugin files (for safety), or share a single read-only copy (for efficiency)? Read-only sharing is simpler but means plugins can't maintain per-session state.
4. **Default opt-in** — is enabling Superpowers by default the right UX? Users unfamiliar with it may be confused by Claude's changed behavior (asking brainstorming questions instead of immediately coding). An onboarding tooltip or first-run explainer may be needed.
