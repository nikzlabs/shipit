# CLAUDE.md

ShipIt is a browser-based AI editor — describe what you want in chat, the agent writes the code, and you see results live. The agent runs as a CLI inside a session container; Claude Code CLI is the default backend, Codex CLI is also supported, and the architecture is agent-agnostic so additional backends can be added later. Authentication uses the user's existing subscription with the chosen provider — no per-call API keys required.

## Product principles

These are the design principles that govern what ShipIt is. They override convenience, override "what other tools do," and override "this is how the underlying platform works." When a feature proposal conflicts with one of these, the proposal is wrong.

### 1. ShipIt is the surface. The user does not leave it.

The whole point of ShipIt is that you build, review, ship, and debug software inside one chat-shaped IDE. Anything the user needs to do their job should be visible **inside** ShipIt. Sending the user to a different tab — to read a PR, look at CI logs, check a deploy, view a diff, browse commits — is a failure of the product, not a feature.

Concretely: PRs, CI status, deploy status, file diffs, commit history, conversation history, terminal output, preview, and merge conflicts all surface inline. They do not require a GitHub tab, a hosting provider tab, a CI tab, or a local terminal.

### 2. Inline beats link-out. Always.

When designing any feature, the question is "can this be rendered inside ShipIt?" — not "should we link to the upstream UI?" If the upstream system has the data, ShipIt fetches it and renders it. Links to GitHub, the cloud provider, etc. are **escape hatches** for edge cases, not the primary UX. They live in overflow menus, not on the happy path.

Examples of this principle in action:
- The PR lifecycle card renders status, checks, comments, and review state inline. The "View on GitHub" link exists but is secondary.
- Diffs render in a Monaco panel inside the app; we never bounce the user to GitHub's diff viewer.
- Deploy status is part of the PR card, not "click here to see your hosting dashboard."
- CI failures fetch the failing job's log and surface it so the agent (and the user) can act on it without leaving the chat.

### 3. External tabs are reserved for things ShipIt does not own.

The legitimate reasons to open a new browser tab are narrow:
- **OAuth and auth flows** — Anthropic, GitHub, etc. own their login screens.
- **Account / billing pages** — upstream provider billing, repo creation and settings pages on GitHub.
- **External documentation** the user explicitly clicks through to.

That's the list. "The PR was created so let's open it" is **not** on the list — the PR card already shows everything the user wants to know about the PR. Opening a tab to GitHub means the user is now reading and acting on that data outside ShipIt, which means the next thing they do (re-request review, leave a comment, push a fixup) also happens outside ShipIt. The cycle has to start somewhere; we keep it inside.

### 4. If we don't render it inline yet, that's a backlog item, not a license to link out.

When a piece of upstream data isn't yet surfaced inline, the answer is "build the inline view," not "punt to a GitHub tab." The link-out is a temporary acknowledgment that we haven't built it yet — it's not the design.

### 5. Chat is the input surface. The agent is the actor.

ShipIt's input is a conversation. The user describes intent; the agent runs the commands, edits the files, reads the logs, runs the tests. We deliberately do **not** give the user shell-shaped affordances — quick-action button rows, command palettes that execute shell, hotkey-bound task runners, "click to run npm test" buttons. Those belong to terminal-shaped IDEs. In ShipIt, they aren't a feature gap; they're a category mistake that nudges the product back toward the CLI wrapper it's trying to replace.

The existing primitives already cover the legitimate needs:

| Need | Primitive |
|---|---|
| Recurring user-driven task ("run the tests", "regenerate types") | Ask the agent in chat. |
| Long-running services (dev server, Prisma Studio, log tailer) | Declare in `docker-compose.yml` with `x-shipit-preview: auto`. |
| One-time setup on a new session (`npm install`, codegen) | `agent.install` in `shipit.yaml`. |
| Ad-hoc shell access for debugging or exploration | The existing terminal panel. |

If a proposal is "let the user click a button to run a shell command," it almost certainly maps onto one of those four. Build on the existing primitive instead of adding a fifth surface.

The user is not without agency: they navigate, review, instruct, accept, roll back, branch, merge. They just don't *operate* the box. Operating the box is what they hired the agent for.

### Corollary: "saves an LLM round-trip" is not a feature.

Spending a turn to run a routine command is the cost of chat-shaped UX, and that cost is intentional. It keeps the agent in the loop, keeps the chat history complete, and keeps the user's mental model consistent. Optimizing the round-trip away with a button erodes the product's identity for a marginal latency win.

### Corollary: how to evaluate proposals

Before writing the design, answer:
1. Does this require the user to open a tab outside ShipIt to be useful? If yes, redesign — or justify why this falls in the narrow set of legitimate exceptions in §3.
2. Does this assume the user has GitHub or another upstream tool open in another window? If yes, the data needs to come into ShipIt instead.
3. Is the link-out the primary affordance, or an escape hatch behind an overflow menu? If primary, redesign.
4. Does this give the user a shell-shaped affordance (button, palette, hotkey) to run a command the agent could run? If yes, the proposal is solving a problem ShipIt doesn't have — see §5.

## Runtime

ShipIt always runs inside Docker containers — there is no local/bare-metal mode. The orchestrator runs in a container and spawns session worker containers.

## Setup

```bash
npm install
```

**Important:** If any npm command fails with missing `node_modules` (e.g., `Cannot find package`), run `npm install` first.

## Commands

- **`npm run test:dev`** — **preferred for development.** Runs only tests affected by your uncommitted changes + a small set of smoke tests. Much faster than the full suite. Use this while iterating.
- `npm run test:dev -- --list` — dry run: shows which test files would run without executing them.
- `npm run test:smoke` — run only the smoke tests (core connectivity, HTTP bootstrap, git, one client component).
- `npm test` — run **all** tests (full suite). Use sparingly during development — the CI runs this automatically on every PR. Only run locally if you suspect wide-reaching breakage.
- `npx vitest run src/server/git-core.test.ts` — run a single test file.
- **`npm run lint:dev`** — **preferred for development.** ESLint over only files changed vs `origin/main` + uncommitted/staged. Same `test:dev` rationale: the full type-aware lint loads all 697 TS files (~50 s, ~2.85 GiB RSS), and most edits only touch a handful. CI still runs the full lint, so this is for the inner loop.
- `npm run lint:dev -- --list` — dry run: shows which files would be linted.
- `npm run lint` — full ESLint on `src/`. Cached (`node_modules/.cache/eslint/`), so a re-run after no edits is near-instant. Run sparingly during development — use when you suspect a cross-file rule (e.g. `no-deprecated`) has been tripped in files you didn't touch.
- `npm run typecheck` — TypeScript type checking (`tsc --noEmit`). Incremental via `node_modules/.cache/tsc/.tsbuildinfo`, so warm runs are ~5 s instead of ~17 s. No per-file variant: TS programs are whole-project by design.
- `npm run dev` — start dev server (tsx)
- `npm run build` — build client with Vite

## Debugging the UI

The Playwright MCP server is configured and launches its own browser. Use `browser_navigate` to open the ShipIt UI (e.g. `http://127.0.0.1:3000`), then `browser_snapshot` to read page state, `browser_click` to press buttons, `browser_fill_form` to type text, and `browser_take_screenshot` for visual checks.

## Dogfooding ShipIt in ShipIt

When the ShipIt repo is opened in production ShipIt, the outer orchestrator surfaces the `dev` Compose service from `docker-compose.yml` in the preview panel as a manual service — the user starts it on demand (it's heavy: `npm install` + `vite build` + a second orch process, so we don't pay that cost on every session boot). Once started, that service runs an *inner* orchestrator with `RUNTIME_MODE=local`, which serves the ShipIt UI on port 3000 inside the outer session container. The outer's preview panel renders the inner UI, giving you a chat-driven dev loop on the ShipIt source itself. Local mode skips Docker entirely (no per-inner-session containers, no inner Compose stacks); inner agent processes spawn in-process via `claude-adapter` / `codex-adapter`. See `docs/118-shipit-ui-local/plan.md` for the full design and the list of degraded behaviors (no inner terminal, no inner file watcher, no inner-session preview). `docs/131-dogfood-seed-sessions/plan.md` covers the seed script that provisions reproducible repo-backed inner sessions on dev-service boot, and the testing-account `GITHUB_TOKEN` secret (the inner orch's GitHub token is no longer forwarded from the outer user by default).

## Project structure

```
src/
  server/
    session/         Code that runs inside a session container
      terminal.ts    TerminalProcess — interactive PTY
      file-watcher.ts     FileWatcher — recursive fs.watch, debounced change events
      session-worker.ts   Fastify server that runs inside each container
      agents/        Agent process adapters (docs/155)
        agent-process.ts   Base agent interface
        agent-registry.ts  Registry of available agents
        tool-map.ts        Canonical tool-name mapping (merges per-agent slices)
        index.ts           Barrel export
        claude/      Claude-specific session-side code
          adapter.ts       ClaudeAdapter — implements AgentProcess
          process.ts       ClaudeProcess — spawns CLI, parses NDJSON, emits events
          tool-map.ts      Claude → canonical tool-name slice
        codex/       Codex-specific session-side code
          adapter.ts       CodexAdapter — implements AgentProcess
          tool-map.ts      Codex → canonical tool-name slice

    orchestrator/    Code that runs in the main process
      index.ts       Entry point — buildApp()
      app-di.ts      Dependency injection setup
      app-lifecycle.ts  Server startup/shutdown hooks
      api-routes.ts  Route registration dispatcher
      api-routes-*.ts  Domain-specific HTTP routes (bootstrap, files,
                       git, github, preview, secrets, session)
      validation.ts  Input validation, error formatting
      repo-git.ts    RepoGit — clone, fetch, worktree lifecycle, branch deletion
      repo-store.ts  RepoStore — persists repo metadata
      git-utils.ts   generateBranchPrefix(), parseGitHubRemote()
      git-config.ts  Global git config helpers
      sessions.ts    SessionManager — persists session metadata to JSON
      session-runner.ts   SessionRunner + SessionRunnerRegistry
      container-session-runner.ts  ContainerSessionRunner (proxy)
      session-container.ts  SessionContainerManager — Docker orchestration
      container-lifecycle.ts  Container start/stop/restart logic
      service-manager.ts  ServiceManager — Docker Compose lifecycle per session
      compose-generator.ts  Compose override generation, volume rewriting
      container-discovery.ts  Find running containers
      container-health.ts     Container health checks
      preview-proxy.ts     Reverse proxy for container previews
      docker-proxy.ts      Docker socket proxy for secure container access
      agents/        Per-agent orchestrator-side code (docs/155)
        index.ts           buildAgentRuntime() — assembles per-agent maps
        types.ts           LimitsProvider interface (and future runtime types)
        claude/      AuthManager (OAuth), ClaudeOAuthRefresher, ClaudeLimitsProvider,
                     prepareClaudeRunParams, CLAUDE_PARALLEL_SESSIONS_SECTION
        codex/       CodexAuthManager (device flow), CodexLimitsProvider,
                     prepareCodexRunParams, CODEX_PARALLEL_SESSIONS_SECTION
      agent-auth-manager.ts   Shared AgentAuthManager interface
      agent-run-params-prep.ts  PrepareRunParamsFn type + identity fallback
      limits-registry.ts   LimitsRegistry — broadcasts subscription pills
      github-auth.ts GitHubAuthManager — GitHub token + API
      github-auth-checks.ts, github-auth-prs.ts, github-auth-repos.ts
      credential-store.ts  CredentialStore — unified credentials
      secret-store.ts      SecretStore — user secrets
      features.ts    FeatureManager — scans docs/ for feature status
      session-namer.ts  AI-powered session naming
      chat-history.ts  ChatHistoryManager — per-session message persistence
      usage.ts       UsageManager — per-session cost tracking
      pr-status-poller.ts  Polls GitHub for PR/CI status updates
      proxy-agent-process.ts  Proxies agent commands to session containers
      agent-instructions.ts   Generates system prompts for agents
      templates.ts   Project scaffolding templates
      templates-backend.ts, templates-frontend.ts, templates-fullstack.ts
      markdown.ts    findMarkdownFiles() — docs discovery
      sse-client.ts  SSE client for container event streams
      worker-http.ts HTTP client for session worker endpoints
      terminal-buffer.ts  Server-side terminal output buffering
      ws-handlers/   WebSocket-only message handlers (streaming, per-connection state)
        types.ts     HandlerContext interface shared by all handlers
        send-message.ts    send_message, answer_question, home_send_with_repo
        agent-execution.ts   Agent process lifecycle management
        agent-listeners.ts   Agent event stream listeners
        post-turn.ts         Post-turn actions (auto-commit, auto-push)
        rollback-handlers.ts Git rollback via WS
        terminal-handlers.ts, misc-handlers.ts
      services/      Business logic layer — pure functions consumed by routes and WS handlers
        session.ts, git.ts, github.ts, github-ci-fix.ts,
        settings.ts, templates.ts, files.ts, misc.ts, repos.ts,
        replay.ts, types.ts, index.ts
      integration_tests/  Integration tests — one file per feature area
        test-helpers.ts   Shared stubs (TestClient, FakeClaudeProcess, etc.)

    shipit-docs/     Platform docs for the agent inside containers (copied to /shipit-docs/)

    shared/          Code used by both session and orchestrator
      types/         All type definitions
        index.ts, ws-client-messages.ts, ws-server-messages.ts, domain-types.ts,
        claude-types.ts, agent-types.ts, attachment-types.ts, deployment-types.ts,
        github-types.ts, terminal-types.ts, usage-types.ts
      types.ts       Barrel re-export of types/
      git.ts         GitManager — init, autoCommit, log, push, pull, diff, rollback
      file-tree.ts   scanFileTree() — workspace directory listing
      agent-registry.ts  Shared agent registry (used by both layers)
      session-config.ts  Session configuration parsing
      database.ts    Database abstraction
      utils.ts       Shared utility functions
      strip-ansi.ts  ANSI escape code stripping
      fs-constants.ts  Filesystem path constants

  client/          React 19 frontend (Vite + Tailwind CSS v4)
    App.tsx        Root component — routing, provider setup
    AppLayout.tsx  Main layout — panels, sidebar, WebSocket dispatch
    main.tsx       Vite entry point
    components/    UI components (MessageList, FileTree, PreviewFrame, etc.)
    hooks/         Custom hooks (useWebSocket, useSearch, useResizablePanel, etc.)
    stores/        Zustand state stores
      session-store.ts, ui-store.ts, git-store.ts, pr-store.ts,
      preview-store.ts, file-store.ts, terminal-store.ts,
      settings-store.ts, repo-store.ts
      actions/     Store action creators (session-actions.ts)
    themes/        Theme CSS files (dark.css, light.css)
    utils/         Client utilities (dates, local-storage, repo-label, session-data)
    design-tokens.ts  Icon sizes, spacing, and design constants
    index.css      Tailwind imports + custom animations
    test-setup.ts  Imports @testing-library/jest-dom/vitest

android/         Standalone Android WebView wrapper (separate Gradle build).
                 Built manually via the "Android build" GitHub Actions workflow.
                 Node tooling ignores this directory. See android/README.md
                 and docs/116-android-webview-app/.
```

## Architecture

Three-layer system: browser (React SPA) → orchestrator (Fastify) → session workers (Docker containers). Architecture knowledge is packaged as skills in `.claude/skills/` for progressive disclosure — each skill auto-loads when the task context matches.

### Available skills

| Skill | Covers |
|-------|--------|
| `server-architecture` | buildApp(), HTTP routes, services, WS handlers, DI, state scopes |
| `client-architecture` | Zustand stores, hooks, components, data flow |
| `session-lifecycle` | Session types, creation paths, warm pool, activation, switching |
| `session-containers` | Docker containers, runners, idle cleanup, reconnection |
| `session-processes` | Claude CLI, preview manager, file watcher, terminal, agents |
| `git-architecture` | GitManager, RepoGit, worktrees, credentials, auto-commit |
| `deployment-architecture` | Auto-deploy on push, GitHub Deployments API, deploy status tracking |
| `add-endpoint` | How to add HTTP endpoints, WS messages, activity labels |
| `testing-and-quality` | Test patterns, integration tests, quality checklist |
| `docs-navigator` | Feature docs index — find the right `docs/NNN-*` for a task |

## Key patterns

These are non-obvious architectural patterns that aren't apparent from the file structure alone.

### Orchestrator ↔ container communication

Session containers run a Fastify server (`session-worker.ts`) that exposes HTTP endpoints for agent control, terminal, file operations, and secrets. The orchestrator talks to containers exclusively over HTTP — never Docker exec.

- **Commands flow via HTTP**: `worker-http.ts` sends requests to the container's worker URL (e.g., `POST /agent/start`, `POST /terminal/resize`). `ContainerSessionRunner` wraps these calls and exposes them as the `SessionRunner` interface.
- **Events flow back via SSE**: Containers stream real-time events (agent output, terminal data, file changes) over `GET /events`. The orchestrator's `sse-client.ts` connects to this endpoint and relays events to the browser's WebSocket.
- **Proxy agent pattern**: `ProxyAgentProcess` implements the `AgentProcess` interface but delegates everything to the container over HTTP+SSE. This lets orchestrator code treat local and remote agents identically.
- **Single container + compose**: Each session gets one agent container. Dev servers and other services run in Docker Compose stacks managed by `ServiceManager`.
- **SSE reconnection**: Exponential backoff (1s, 2s, 4s… capped at 10s). On reconnect, terminal output is replayed with a reset sequence (`\x1bc`) to avoid corrupted xterm.js rendering. Terminal retries are limited to 3 attempts.
- **Backpressure**: If an SSE client can't keep up with terminal output, the PTY is paused until `drain` fires. This prevents unbounded memory growth.
- **Multi-viewer**: Multiple browser tabs can attach to the same runner. The runner broadcasts to all via `emitMessage()`. Resources (SSE, preview) start on first viewer attach and persist after detach for fast re-attach.

### WS handler context (three-level DI)

WS handlers receive a composed context object with three layers. Handlers declare exactly which layers they need:

- **`ConnectionCtx`** — per-WebSocket-connection: `send()`, `broadcastLog()`, `getActiveDir()`, `activateSession()`
- **`RunnerCtx`** — per-session-runner: `agentFactory()`, `getAgent()`, turn state accumulators, message queue, terminal
- **`AppCtx`** — app-wide singletons: all managers, factories, config

Handlers that need everything use `FullCtx = ConnectionCtx & RunnerCtx & AppCtx`. Simpler handlers declare only what they need (e.g., terminal handlers need `ConnectionCtx & RunnerCtx` only).

### WebSocket lifecycle MUST NOT affect server behavior

The WebSocket connection is a *transport* between the browser and the orchestrator. It must not be allowed to drive server-side state, agent lifecycle, container lifecycle, or persistence. Disconnects, reconnects, browser crashes, and network blips are all expected and routine — none of them should change what the server is doing.

Concrete rules:

- **Per-connection state is captured at the top of long-running functions**, never inside async callbacks. `runAgentWithMessage` and `wireAgentListeners` capture `runner`, `capturedSessionId`, `capturedSessionDir` once at entry. Any code in `agent.on("done")`, `agent.on("event")`, `agent.on("error")`, `setTimeout`, `Promise.then`, or recursive calls reads ONLY those captured values, never `ctx.getX()` or `ctx.setX()`.

- **Resolve runners via the registry, not via `ctx.getRunner()`.** `ctx.getRunner()` returns the per-connection `attachedRunner`, which becomes `null` on WS close. Use `ctx.getRunnerRegistry().get(capturedSessionId) ?? ctx.getRunner()` so the resolution survives reconnects. The registry persists across the entire process lifetime.

- **Mutate runner state directly via `runner.X = …`.** The previous `ctx.setIsClaudeRunning`, `ctx.setTurnSummary`, `ctx.setAccumulatedText`, etc. setters have been deleted (see `docs/095-runner-ctx-simplification/plan.md`). The only way to mutate runner state now is to resolve a runner — via `resolveRunner(ctx)` from `ws-handlers/resolve-runner.ts`, which prefers the registry — and assign directly: `runner.running = false`, `runner.turnSummary = "…"`, `runner.emitMessage(...)`. Reading state works the same way: `runner.running`, not `ctx.getIsClaudeRunning()`.

- **Emit via `runner.emitMessage()`, not `ctx.send()`.** `runner.emitMessage` broadcasts to every attached viewer AND buffers into the turn-event log so reconnecting viewers see post-turn messages. `ctx.send` writes to a single socket and silently drops on closed sockets.

- **Never trigger `runner.dispose()` from a WebSocket lifecycle event.** Disposal happens via the periodic idle enforcer (which respects a 60s grace period after viewer detach and refuses to kill running agents) or from explicit user actions (archive, repo delete, full reset, shutdown). The latter pass `{ force: true }`.

- **Never trigger `agent.kill()`, `terminal.kill()`, `container.destroy()`, etc. from a WebSocket close handler.** The only thing `socket.on("close")` should do is call `detachFromRunner()` (which decrements the viewer count and removes per-connection listeners). Period.

The bug class is now structurally impossible because the silent-no-op setters are gone — there is no `ctx.setIsClaudeRunning(...)` to call. If a future contributor needs to mutate runner state, the type system forces them to obtain a runner reference first, which forces them to think about lifetime. Integration coverage lives in `src/server/orchestrator/integration_tests/ws-disconnect-resilience.test.ts` — those tests should be considered the executable contract for this section.

### Service layer pattern

Three-tier: **Routes/WS handlers → Services → Managers**

- Services (`services/*.ts`) are pure async functions that compose manager calls and return typed results.
- Services take domain types (not handler context), making them testable and reusable by both HTTP routes and WS handlers.
- Application errors use `ServiceError(statusCode, message)` with HTTP semantics. Routes catch these and respond with the given status code.

### WS message type system

Messages use discriminated unions with a `type` literal field (`ws-client-messages.ts`, `ws-server-messages.ts`). The dispatch switch in `index.ts` narrows each message to its specific type before passing to the handler — handlers receive the narrowed type, not the union.

### Post-turn flow

After the agent finishes a turn (`agent_result` event in `agent-execution.ts`):
1. `postTurnCommit()` auto-commits changes
2. `scheduleAutoPush()` debounces a push (5s) if GitHub auth is configured
3. PR lifecycle card is emitted if a remote exists

**Critical**: Session context (sessionId, sessionDir) is captured at turn *start*, not at the "done" event. This prevents session switches mid-turn from corrupting commits.

### Message group boundaries

Agent events are grouped into chat history entries based on tool-result boundaries. Each `agent_tool_result` sets a `needsNewMessageGroup` flag so the next `agent_assistant` event starts a fresh group. This preserves the visual message structure when reloading — groups map 1:1 to message bubbles in the UI. Key file: `agent-listeners.ts`.

### Chat transcript content MUST be persisted, not just emitted

Anything that renders **inline in the chat transcript** — a message bubble or a card (`MessageList.tsx`) — must be written to **persisted chat history**, not merely emitted over WS. `runner.emitMessage()` is *transport only*: it broadcasts to attached viewers and buffers into the per-turn **turn-event log**, which a WS **reconnect** replays. It does **not** persist anything. A session **switch** and a full **page reload** rehydrate the transcript from persisted chat history (`ChatHistoryManager` → `GET /history`), so an emit-only card renders live, survives a reconnect, and then **vanishes** on switch/reload. This bug class has recurred (voice notes `docs/163`, bug-report cards `docs/164`).

The dividing line: **transient** signals (spinners, `preview_status`, queue counts, live activity) are emit-only and correctly disappear. **Transcript content** (any card the user expects to still be there tomorrow, and any terminal state like "filed"/"failed") must persist. If it has a place in the scrollback, it has a row in the DB.

The established pattern for a **side-channel card** (one that arrives outside the agent-event stream — an HTTP relay or a post-turn WS message, so `buildTurnMessages` doesn't capture it on its own):

1. **Emit it via `emitChatCard` (`chat-card-persistence.ts`), never bare `emitMessage`.** That single primitive both emits the live WS message AND records the card in-band with the turn — anchored by `afterGroupIndex` so `buildTurnMessages` interleaves it at its true transcript position instead of an out-of-band `append` floating it above the whole turn. It is the one supported way to add a transcript card, so a card can't ship emit-only.
2. **Add a typed field on `PersistedMessage`** (e.g. `voiceNote`, `bugReport`) plus the column + `toRow`/`fromRow` (and a `database.ts` migration). Lifecycle transitions patch that record in place (e.g. `updateBugReportCard`) — the proposing-turn row is finalized by then, so a direct update is safe.
3. **Rehydrate on the client** in `loadSessionHistory` (seed any store the card reads from), and make the **live append + any store upsert idempotent by id** so the reconnect buffer replay and the reload history replay never double-render or clobber a terminal state.
4. **Add a history round-trip test** (persist → `load()` → assert) and a no-duplicate-on-replay test. The serialization round-trip contract in `chat-history.test.ts` must include any new `PersistedMessage` field.

If you find yourself reaching for `emitMessage` to put a card in the chat, reach for `emitChatCard` instead and wire steps 2–4. Key files: `chat-card-persistence.ts` (`emitChatCard`), `chat-history.ts`, `agent-listeners.ts` (`buildTurnMessages`), `session-data.ts` (`loadSessionHistory`).

### Preview routing

Browser previews reach containers through a reverse proxy (`preview-proxy.ts`):
- **Subdomain routing** (primary): `{sessionId}--{port}.localhost` → container. Avoids path prefix conflicts with frameworks like Vite.
- **Path-based routing** (fallback): `/preview/:sessionId/:port/*` for debugging.
- **HMR patching**: Injects a script that rewrites dev-server WebSocket URLs to use page origin, so hot-reload works through the proxy.
- **Config-driven restarts**: File changes to `shipit.yaml` trigger immediate preview restart. Lockfile changes (`package-lock.json`, `yarn.lock`) are debounced with a 30s cooldown to avoid npm-install feedback loops.

### Disk cleanup

Three orthogonal surfaces, split so each prune runs where the leak actually happens:

- **Per-session teardown drops named volumes** when the session goes away for good. `ServiceManager.stop({ removeVolumes: true })` appends `--volumes` to `docker compose down`, dropping user-declared named volumes (e.g. `node_modules` caches) along with the containers. The flag is signaled by setting `removeVolumesOnDispose = true` on the container runner before disposal — `archiveSession` and `fullReset` do this. Idle eviction, restartAgent recovery, and reconciles keep the default `false` so the user can resume without losing build state.
- **`deployment/vps/deploy.sh` owns build-time prunes.** After each `docker compose build` it runs `docker image prune -af --filter "until=168h"` and `docker builder prune -f --filter "until=72h"`. BuildKit cache only grows because of builds, so this is where the prune is causal — duplicating it on a timer would just do redundant work. `--no-cache` is no longer the default (it was eating ~80 GB on prod); set `FORCE_REBUILD=1` for a clean rebuild. The agent CLIs (Claude/Codex/Playwright-MCP) install from a committed lockfile (`docker/agent-cli/package-lock.json`) via `npm ci`, so their versions are deterministic and change only when that lockfile changes — bumped by the Renovate GitHub App with a cooldown, gated on the CLI contract test (see `docs/141-cli-version-strategy/plan.md`). The old `NPM_GLOBALS_REBUILD=$(date +%s)` per-deploy cache-bust is gone.
- **`disk-janitor.ts` runs once at orchestrator startup** (no periodic timer — see the module docstring for why). It covers leaks the deploy-time prune can't see: orphan ShipIt-managed compose volumes (matched by the `shipit-managed=true` label the override stamps onto every user-declared volume — sessions can be archived between deploys, leaking volumes that `deploy.sh` never touches), unreferenced `repo-cache/<hash>` / `dep-cache/<hash>` directories, and — opt-in via `DISK_JANITOR_ARCHIVED_WORKSPACE_DAYS=<n>` — a safety-net sweep for archived workspaces that outlived archive's normal cleanup (interrupted shutdown, legacy data). The sweep only drops the on-disk git checkout + `node_modules`; chat history, usage, and session metadata are always preserved, and unarchive re-clones from the bare cache. Sessions without a `remoteUrl` are skipped defensively. BuildKit/image prune deliberately lives in `deploy.sh`, not here.

### Client dual-channel communication

The browser uses two parallel channels:
- **Per-session WebSocket** (`/ws/sessions/{id}`) — streaming agent output, diffs, preview status. Managed by `useWebSocket` with exponential backoff reconnection (2s → 30s cap).
- **Global SSE** (`/api/events` via `useServerEvents`) — session list, repo status, auth events, PR status. Always active.

### Client store patterns

- **Cross-store access**: Stores reference each other via `useXStore.getState()` inside actions, not subscriptions. This avoids circular dependencies.
- **Coordinated resets**: `stores/actions/session-actions.ts` is the single source of truth for resetting stores during session switches.
- **Hydration order**: HTTP bootstrap loads once on mount → per-session WS triggers `loadSessionHistory()` on connect → WS messages stream real-time updates. Guards prevent race conditions (e.g., WS data arriving before HTTP response).
- **Stale message guard**: `useMessageHandler` checks `data.sessionId !== currentSessionId` to discard messages from previous sessions after a switch.

### Integration test patterns

- **`TestClient`** buffers WS messages from connection time, preventing races where the server sends before the test listens. Tests call `receive()` which returns buffered or waits for new messages.
- **Container mocking**: `isTestMode` flag in `buildApp()` enables `POST /api/_test/sessions` to create sessions without Docker.
- **Fakes with test controls**: `FakeClaudeProcess`, `StubGitHubAuthManager`, etc. have injection methods (`setPrData()`, `setCheckStatus()`) for test scenarios.

## Workflow

- **Read before coding** — before changing a feature, read its `docs/NNN-feature/plan.md` and the source files listed under "Key files". Trace the data flow for similar features to understand existing patterns.
- **Identify all touchpoints** — plan which files need changes (server, client, types, tests) before writing code.
- **Co-locate tests** — place tests next to source files (`foo.ts` → `foo.test.ts`). Follow patterns from neighboring test files.
- **Lint and typecheck before finishing** — run `npm run lint:dev` and `npm run typecheck` after code changes and fix any errors before considering work complete. `lint:dev` is the dev-loop default; CI runs the full `npm run lint` so the source of truth is unchanged.
- **Update docs when done** — update the relevant `plan.md` with new subsystems, patterns, or key files you added. Mark completed checklist items with `[x]`.
- **Update shipit-docs when changing agent-facing behavior** — when changing platform behavior visible to the agent inside session containers (preview config, shipit.yaml schema, container environment, GitHub integration), update the corresponding file in `src/server/shipit-docs/`. These docs are baked into the session worker image at `/shipit-docs/` and are the agent's primary reference for the platform.

## Code conventions

- **ESM throughout** — `"type": "module"` in package.json. Use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`).
- **Type imports** — use `import type { X } from "./path.js"` for type-only imports.
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`).
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE.
- **React** — functional components only, hooks for all state/effects. React 19 JSX transform (no `import React` needed).
- **Icons** — use `@phosphor-icons/react` for all icons. Never hardcode `<svg>` elements. Use the `ICON_SIZE` constants from `src/client/design-tokens.ts` (XS=12, SM=16, MD=20, LG=32, XL=48) for icon sizes. See the `design-language` skill for full icon and styling guidance.
- **Styling** — Tailwind CSS v4 utility classes. Dark-mode-only color scheme (gray-950 backgrounds).
- **Strict TypeScript** — `strict: true` in tsconfig. Target ES2022, module ESNext with bundler resolution.

## Dependency policy

Two rules govern what goes into `package.json`. Both are enforced by `npm run check-deps` (`scripts/check-dependency-age.ts`); wire it into CI.

1. **Pin to exact versions.** Every entry in `dependencies` and `devDependencies` must be an exact semver like `"react": "19.2.4"` — never `^19.2.4`, `~19.2.4`, `latest`, a range, a tag, or a git/tarball URL. Floating ranges turn `npm install` into a moving target and let a fresh checkout silently pick up a version nobody on the team has run. Bumps are deliberate edits to `package.json`, not a side effect of someone re-running install.
2. **Minimum age of 7 days.** A version may only be added once it has been published to the npm registry for at least seven days. The window gives the community, scanners, and the registry's own abuse pipeline time to catch a compromised release before it lands in our build. If you genuinely need a same-day release (security fix in a transitive, for example), call it out in the PR description and get explicit sign-off — don't bypass the check silently.

When bumping a dependency, edit `package.json` to the new exact version, run `npm install` to refresh the lockfile, then run `npm run check-deps` before opening the PR.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work items or tracking notes
```

Feature docs describe individual features and may include planned-but-not-implemented designs. Docs are **reference material** — what a feature is, why, and how. Priority and work-status live in the issue tracker (Linear / GitHub Issues), **not** in the doc; see `docs/168-tracker-backed-priorities/`.

Features are numbered by creation order. When implementing or modifying a feature, read its `plan.md` first. When a feature has remaining work, check its `checklist.md`. When adding a new feature, create `docs/NNN-new-feature/plan.md`.

**There is no `status:` or `priority:` frontmatter (removed in docs/168).** The markdown scanner (`src/server/orchestrator/markdown.ts`) no longer reads them — a leftover `status:`/`priority:` line is silently ignored. The docs list groups structurally: a doc is **tracked** if it is a feature-directory `plan.md`/`checklist.md`, carries an `issue:` pointer, or has a `checklist.md` sibling; within Tracked, docs whose `checklist.md` is 100% complete fold into a collapsed **Done** group, everything else stays **Active**.

The recognized frontmatter fields are `issue`, `title`, and `description` — all optional. A `plan.md` with no frontmatter still appears in the list.

`issue:` points at the work item that tracks the doc; the tracker is inferred from the pointer's shape. **Linear must be a full URL** (`https://linear.app/<workspace>/issue/SHI-28/...`) — a bare `SHI-28` is not accepted. **GitHub** is `owner/repo#123` or a full issue URL. ShipIt renders a jump-to-issue chip from the pointer. A doc with no `issue:` is pure reference.

```yaml
---
issue: https://linear.app/shipit-ai/issue/SHI-28/decouple-priorities-from-documents
---
```

A `checklist.md` can exist alongside any doc — it tracks remaining work items and drives the Active/Done grouping. When the work is finished, mark all checklist items complete (`[x]`).

`plan.md` may also include an optional `description` field — a single-line summary of what the feature is about. The docs viewer renders it under the title (wrapping to at most two lines) so a doc's purpose is legible without opening it. Keep it to one sentence; it's parsed as a single line, so no multi-line YAML block scalars. Example:

```yaml
---
issue: octocat/hello-world#42
description: Show a short doc description from frontmatter under the title in the docs panel.
---
```
