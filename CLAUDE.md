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

- **`npm run test:dev`** — **dev default.** Only tests affected by uncommitted changes + smoke tests (`-- --list` to dry-run). Use while iterating.
- `npm run test:smoke` — smoke tests only (core connectivity, HTTP bootstrap, git, one client component).
- `npm test` — full suite. Sparingly — CI runs it on every PR; run locally only if you suspect wide breakage. Single file: `npx vitest run <file>.test.ts`.
- **`npm run lint:dev`** — **dev default.** ESLint over files changed vs `origin/main` + uncommitted (`-- --list` to dry-run). The full lint loads all ~700 TS files (~50 s, ~2.85 GiB); CI runs it, so this is the inner loop.
- `npm run lint` — full ESLint on `src/` (cached; warm re-run near-instant). Sparingly — when you suspect a cross-file rule (e.g. `no-deprecated`) tripped elsewhere.
- `npm run typecheck` — `tsc --noEmit`, incremental (warm ~5 s). Whole-project by design, no per-file variant.
- `npm run build` — Vite client build. (`npm run dev` is the Vite/tsx dev server, but **don't start it in bash to preview** — ShipIt serves the preview via the `dev` Compose service in `docker-compose.yml`, which runs `npm run dev` itself; see [Dogfooding ShipIt in ShipIt](#dogfooding-shipit-in-shipit). A bash-started server is also reaped when the container goes idle.)

**Inside a session container, the full suite (`npm test`) and integration tests OOM the box.** When developing ShipIt *in* ShipIt, verify with `npm run typecheck`, `npm run lint:dev`, and affected co-located unit tests only; leave the heavy suites to CI.

## Debugging the UI

The Playwright MCP server is configured and launches its own browser. Use `browser_navigate` to open the ShipIt UI (e.g. `http://127.0.0.1:3000`), then `browser_snapshot` to read page state, `browser_click` to press buttons, `browser_fill_form` to type text, and `browser_take_screenshot` for visual checks.

## Dogfooding ShipIt in ShipIt

When the ShipIt repo is opened in production ShipIt, the outer orchestrator surfaces the `dev` Compose service as a **manual** preview service (heavy — `npm install` + `vite build` + a second orch — so it's started on demand, not every boot). It runs an *inner* orchestrator with `RUNTIME_MODE=local` serving the ShipIt UI on port 3000, rendered in the outer preview panel — a chat-driven dev loop on the ShipIt source. Local mode skips Docker (no inner containers/Compose; inner agents spawn in-process via `claude-adapter`/`codex-adapter`). Full design + degraded behaviors (no inner terminal/file-watcher/preview): `docs/118-shipit-ui-local`; seed sessions: `docs/131-dogfood-seed-sessions`. The `dev` service's creds (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `GITHUB_TOKEN`) are **user-supplied secrets** set once in the outer Settings → Secrets (prefer a long-lived `ANTHROPIC_API_KEY` over an OAuth token); see `docs/184-remove-platform-secret-forwarding`.

## Project structure

Directory map only — the per-file detail lives in the architecture skills below and in the files themselves. Entry point is `src/server/orchestrator/index.ts` (`buildApp()`).

```
src/
  server/
    session/         Code that runs inside a session container
      session-worker.ts   Fastify server inside each container
      terminal.ts · file-watcher.ts
      agents/        Agent process adapters (docs/155): claude/, codex/, tool-map.ts
    orchestrator/    Code that runs in the main process
      index.ts       buildApp() entry point; app-di.ts, app-lifecycle.ts
      api-routes*.ts validation.ts   HTTP routes (→ server-architecture skill)
      repo-git.ts · repo-store.ts · git-utils.ts · git-config.ts   (→ git-architecture)
      sessions.ts · session-runner.ts · session-container.ts · container-*.ts
      service-manager.ts · compose-generator.ts · preview-proxy.ts · docker-proxy.ts
      agents/        Per-agent orchestrator code (docs/155): claude/, codex/, auth, limits
      github-auth*.ts · credential-store.ts · secret-store.ts
      chat-history.ts · usage.ts · pr-status-poller.ts · features.ts · session-namer.ts
      agent-instructions.ts · templates*.ts · sse-client.ts · worker-http.ts
      ws-handlers/   WebSocket-only handlers (→ server-architecture skill)
      services/      Business-logic layer — pure fns over domain types
      integration_tests/   One file per feature area; test-helpers.ts has the stubs
    shipit-docs/     Platform docs for the in-container agent (copied to /shipit-docs/)
    shared/          Used by both layers
      types/         All type defs (ws-*-messages.ts, domain-types.ts, …); types.ts re-exports
      git.ts         GitManager — init, autoCommit, log, push, pull, diff, rollback
      file-tree.ts · agent-registry.ts · session-config.ts · database.ts · utils.ts
  client/          React 19 frontend (Vite + Tailwind CSS v4) — see client-architecture skill
    App.tsx · AppLayout.tsx · main.tsx
    components/ · hooks/ · stores/ (+ actions/) · themes/ · utils/
    design-tokens.ts   Icon sizes, spacing, design constants
android/           Standalone Android WebView wrapper (separate Gradle build).
                   Node tooling ignores it. See android/README.md, docs/116.
```

## Architecture

Three-layer system: browser (React SPA) → orchestrator (Fastify) → session workers (Docker containers). Architecture knowledge is packaged as skills in `.claude/skills/` for progressive disclosure — each skill surfaces by description and the agent loads it when the task matches. **Both backends read `.claude/skills/`** — Claude and Codex auto-disclose the same set (no `.codex/skills/` needed), so reference detail demoted into a skill reaches both; see `docs/209-cross-agent-skill-disclosure`. Always-on invariants belong in this file (`CLAUDE.md`, shared with Codex via the `AGENTS.md` symlink), not in a skill.

### Available skills

| Skill | Covers |
|-------|--------|
| `server-architecture` | buildApp(), HTTP routes, services, WS handlers, DI, state scopes |
| `client-architecture` | Zustand stores, hooks, components, data flow |
| `session-lifecycle` | Session types, creation paths, warm pool, activation, switching |
| `session-containers` | Docker containers, runners, idle cleanup, reconnection |
| `session-processes` | Claude CLI, preview manager, file watcher, terminal, agents |
| `git-architecture` | GitManager, RepoGit, bare cache, per-session clones, credentials, auto-commit |
| `deployment-architecture` | Auto-deploy on push, GitHub Deployments API, deploy status tracking |
| `add-endpoint` | How to add HTTP endpoints, WS messages, activity labels |
| `testing-and-quality` | Test patterns, integration tests, quality checklist |
| `docs-navigator` | Feature docs index — find the right `docs/NNN-*` for a task |

## Key patterns

These are non-obvious architectural patterns that aren't apparent from the file structure alone.

### Orchestrator ↔ container communication

Orchestrator ↔ session container is HTTP-only (never Docker exec): commands out via `worker-http.ts` (`ContainerSessionRunner` wraps them as the `SessionRunner` interface), events back over SSE (`sse-client.ts` → browser WS). `ProxyAgentProcess` implements `AgentProcess` but delegates to the container so local/remote agents look identical. Full detail — SSE reconnection/backpressure, multi-viewer broadcast, single-container+compose — in the **session-containers** and **session-processes** skills.

### WS handler context (three-level DI)

WS handlers compose three context layers and declare only what they need: `ConnectionCtx` (per-connection: `send()`, `getActiveDir()`, …), `RunnerCtx` (per-runner: `agentFactory()`, turn-state, terminal), `AppCtx` (app-wide singletons). `FullCtx` is all three. See the **server-architecture** skill.

### WebSocket lifecycle MUST NOT affect server behavior

The WebSocket connection is a *transport* between the browser and the orchestrator. It must not be allowed to drive server-side state, agent lifecycle, container lifecycle, or persistence. Disconnects, reconnects, browser crashes, and network blips are all expected and routine — none of them should change what the server is doing.

Concrete rules:

- **Per-connection state is captured at the top of long-running functions**, never inside async callbacks. `runAgentWithMessage` and `wireAgentListeners` capture `runner`, `capturedSessionId`, `capturedSessionDir` once at entry. Any code in `agent.on("done")`, `agent.on("event")`, `agent.on("error")`, `setTimeout`, `Promise.then`, or recursive calls reads ONLY those captured values, never `ctx.getX()` or `ctx.setX()`.

- **Resolve runners via the registry, not via `ctx.getRunner()`.** `ctx.getRunner()` returns the per-connection `attachedRunner`, which becomes `null` on WS close. Use `ctx.getRunnerRegistry().get(capturedSessionId) ?? ctx.getRunner()` so the resolution survives reconnects. The registry persists across the entire process lifetime.

- **Mutate runner state directly via `runner.X = …`.** The previous `ctx.setIsClaudeRunning`, `ctx.setTurnSummary`, `ctx.setAccumulatedText`, etc. setters have been deleted (see `docs/095-runner-ctx-simplification/plan.md`). The only way to mutate runner state now is to resolve a runner — via `resolveRunner(ctx)` from `ws-handlers/resolve-runner.ts`, which prefers the registry — and assign directly: `runner.running = false`, `runner.turnSummary = "…"`, `runner.emitMessage(...)`. Reading state works the same way: `runner.running`, not `ctx.getIsClaudeRunning()`.

- **Emit via `runner.emitMessage()`, not `ctx.send()`.** `runner.emitMessage` broadcasts to every attached viewer AND buffers into the turn-event log so reconnecting viewers see post-turn messages. `ctx.send` writes to a single socket and silently drops on closed sockets.

- **Never trigger `runner.dispose()` from a WebSocket lifecycle event.** Disposal happens via the periodic idle enforcer (which respects a 60s grace period after viewer detach and refuses to kill running agents) or from explicit user actions (archive, repo delete, full reset, shutdown). The latter pass `{ force: true }`.

- **Never trigger `agent.kill()`, `terminal.kill()`, `container.destroy()`, etc. from a WebSocket close handler.** The only thing `socket.on("close")` should do is call `detachFromRunner()` (which decrements the viewer count and removes per-connection listeners). Period.

The bug class is structurally impossible now the silent-no-op setters are gone — mutating runner state forces you to resolve a runner reference first, forcing you to think about lifetime. Executable contract: `integration_tests/ws-disconnect-resilience.test.ts`.

### Service layer pattern

Three-tier **Routes/WS handlers → Services → Managers**: services (`services/*.ts`) are pure async fns over domain types (not handler context), reusable by routes and WS handlers; app errors are `ServiceError(statusCode, message)` with HTTP semantics. See the **server-architecture** skill.

### WS message type system

Discriminated unions keyed on a `type` literal (`ws-client-messages.ts`, `ws-server-messages.ts`); the dispatch switch in `index.ts` narrows to the specific type before calling the handler.

### Post-turn flow

After a turn (`agent_result` in `agent-execution.ts`): `postTurnCommit()` auto-commits → `scheduleAutoPush()` debounces a 5s push (if GitHub auth) → PR lifecycle card emitted (if a remote exists). **Critical**: session context (sessionId, sessionDir) is captured at turn *start*, not at "done", so a mid-turn session switch can't corrupt commits.

### Message group boundaries

Agent events group into chat-history entries at tool-result boundaries: each `agent_tool_result` sets `needsNewMessageGroup` so the next `agent_assistant` starts a fresh group, keeping groups 1:1 with message bubbles on reload. Key file: `agent-listeners.ts`.

### Chat transcript content MUST be persisted, not just emitted

Anything that renders **inline in the chat transcript** — a message bubble or a card (`MessageList.tsx`) — must be written to **persisted chat history**, not merely emitted over WS. `runner.emitMessage()` is *transport only*: it broadcasts to attached viewers and buffers into the per-turn **turn-event log**, which a WS **reconnect** replays. It does **not** persist anything. A session **switch** and a full **page reload** rehydrate the transcript from persisted chat history (`ChatHistoryManager` → `GET /history`), so an emit-only card renders live, survives a reconnect, and then **vanishes** on switch/reload. This bug class has recurred (voice notes `docs/163`, bug-report cards `docs/164`).

The dividing line: **transient** signals (spinners, `preview_status`, queue counts, live activity) are emit-only and correctly disappear. **Transcript content** (any card the user expects to still be there tomorrow, and any terminal state like "filed"/"failed") must persist. If it has a place in the scrollback, it has a row in the DB.

The established pattern for a **side-channel card** (one arriving outside the agent-event stream — an HTTP relay or post-turn WS message, so `buildTurnMessages` won't capture it on its own): **emit via `emitChatCard` (`chat-card-persistence.ts`), never bare `emitMessage`.** That one primitive atomically emits the live message, records the card in-band (anchored by `afterGroupIndex` so it interleaves at its true position), and persists the in-progress turn (`persistTurnInProgress`) — it requires a persist context, so a card cannot ship emit-only or deferred-persist. Then: add a typed `PersistedMessage` field (+ column + `toRow`/`fromRow` + `database.ts` migration); rehydrate it in `loadSessionHistory` (live append + store upsert idempotent by id); register it in `CARD_MESSAGE_FIELDS` (`visual-elements.ts`) if it renders on an empty-text message; add the history round-trip + no-duplicate-on-replay tests and extend `EVERY_OPTIONAL_FIELD_MESSAGE`. Two guard tests (`chat-history.test.ts`, `visual-elements.test.ts`) make this self-enforcing — a forgotten step is a red build naming the field. Full recipe + rationale: `docs/188-persist-transcript-cards`, `docs/191-card-persist-on-emit`. Key files: `chat-card-persistence.ts`, `chat-history.ts`, `agent-listeners.ts`, `session-data.ts`, `visual-elements.ts`.

### Preview routing

Reverse proxy (`preview-proxy.ts`): subdomain routing `{sessionId}--{port}.localhost` is primary (avoids Vite path-prefix conflicts), path-based `/preview/:sessionId/:port/*` is the fallback, with HMR-URL patching so hot-reload survives the proxy. Full detail: `docs/009-preview-system`, `docs/175-preview-subdomain-only`.

### Disk cleanup

Principle: each surface prunes **where the leak happens**, sorted by *what clock the leak grows on* (SHI-196) — per-session teardown drops named volumes (`ServiceManager.stop({ removeVolumes: true })`, archive/fullReset only, never idle/restart); `deployment/vps/deploy.sh` owns build-time image/builder prunes; `startup-janitor.ts` (`runDiskJanitor`) runs **boot-only** for **crash-recovery** leftovers a failed teardown stranded (orphan compose volumes/networks, opt-in archived-workspace sweep, one-time nm-store migration, per-session credential/log dirs, merged-PR branches — none accumulate steadily); and `steady-state-reclaim.ts` (`runSteadyStateReclaim`) runs on the **periodic** disk-tier escalation pass (`escalateDiskTiers` — boot + per-activation + hourly, guarded by a single in-flight flag) for the sweeps that grow with the clock (unreferenced repo/dep caches, `repo-memory/`, obsolete overlay bases, stale pnpm stores). The hourly escalation timer is the single steady-state disk-reclaim entry point. Full detail: the `disk-janitor.ts` / `startup-janitor.ts` / `steady-state-reclaim.ts` docstrings, `docs/183-overlay-dep-store` (overlay store), `deployment/vps/deploy.sh`, and the **session-containers** skill (teardown path).

### Client communication & stores

Two browser channels: per-session **WebSocket** (`/ws/sessions/{id}`) and global **SSE** (`/api/events`: session list, repo/auth/PR status). Stores cross-reference via `useXStore.getState()` (not subscriptions, avoids cycles); resets centralized in `stores/actions/session-actions.ts`; hydration is HTTP bootstrap → WS `loadSessionHistory()` → live WS, guarded by `sessionId` against stale messages. See the **client-architecture** skill.

### Integration test patterns

`TestClient` buffers WS messages from connect (no send-before-listen races); `isTestMode` in `buildApp()` enables `POST /api/_test/sessions` (no Docker); fakes (`FakeClaudeProcess`, `StubGitHubAuthManager`) expose injection methods. See the **testing-and-quality** skill.

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

## Prompts

LLM prompts (agent system instructions, voice cleanup, session naming, etc.) are **content, not logic** — keep them separated:

- **Prompt *text* is data — it lives in `.md` files** co-located with the composing code (review as prose, diff cleanly, no backtick/`${}` escaping). Load via `loadPrompt(import.meta.url, "./x.md")` (`orchestrator/load-prompt.ts`) **at module top level** — once at init, never per-call (a missing file then throws at boot, not mid-turn). Not a bundler `?raw` import: prod runs TS via tsx, no bundler, so `fs.readFileSync(new URL(...))` is what works. Examples: `agents/<id>/system-prompt.md`, `voice/cleanup-prompt.md`, `orchestrator/prompts/*.md`.
- **Prompt *composition* is code.** Axis branching/fragment selection stay in TS — `agent-instructions.ts`: `renderInstructions(agentId, isOps)` fills `{{TOKEN}}` holes in `prompts/skeleton.md` via `fillPromptTokens` (which throws on an unfilled token — the "no literal `{{FOO}}` reaches the model" guard).
- **The prompt-cache contract is load-bearing.** Every `(agentId, isOps)` variant renders **once at module load** into `PRECOMPUTED_INSTRUCTIONS`; the per-turn path is a pure lookup of a frozen constant, keeping the CLI string byte-stable so the Anthropic prompt cache stays warm. Never move composition or the `.md` reads to a per-call path.

### Testing prompts

**Test composition and caching, never literal wording.** *Do* assert: fragment selection per `agentId`/`isOps`, variant distinctness, non-ops byte-identity, reference-equality of the precomputed constants (cache stability), call-site threading, and the cheap load guard (every variant non-empty, no leftover `{{TOKEN}}`); key presence/absence checks off a **structural anchor** (`##` header, a command token), not a sentence. *Don't* assert specific prose phrases (they churn on copy-edits and were removed from `agent-instructions.test.ts`) — a pure `prompts/*.md` edit should need **no** test changes. Provider/integration tests reference the **imported constant** (`toContain(CLEANUP_INSTRUCTIONS)`), not a pasted copy. See `voice/providers/*-cleanup.test.ts`, `integration_tests/system-prompt.test.ts`.

## Dependency policy

Two rules govern what goes into `package.json`. Both are enforced by `npm run check-deps` (`scripts/check-dependency-age.ts`); wire it into CI.

1. **Pin to exact versions.** Every entry in `dependencies` and `devDependencies` must be an exact semver like `"react": "19.2.4"` — never `^19.2.4`, `~19.2.4`, `latest`, a range, a tag, or a git/tarball URL. Floating ranges turn `npm install` into a moving target and let a fresh checkout silently pick up a version nobody on the team has run. Bumps are deliberate edits to `package.json`, not a side effect of someone re-running install.
2. **Minimum age of 7 days.** A version may only be added once it has been published to the npm registry for at least seven days. The window gives the community, scanners, and the registry's own abuse pipeline time to catch a compromised release before it lands in our build. If you genuinely need a same-day release (security fix in a transitive, for example), call it out in the PR description and get explicit sign-off — don't bypass the check silently.

When bumping a dependency, edit `package.json` to the new exact version, run `npm install` to refresh the lockfile, then run `npm run check-deps` before opening the PR.

## Releasing

ShipIt's own repo uses the **`release-branch`** mechanism (`shipit.yaml` `release:` block, docs/214): releases are **merge-triggered**. Cut one by opening a version-bump PR into `stable` and merging it — `.github/workflows/release.yml` then derives the tag `v<package.json version>` from the merged commit, gates on a green build, and **creates + pushes the tag and Release itself**. **Never hand-push a final `vX.Y.Z` tag** — CI owns that. rc's are the exception: cut via the tag path (push `vX.Y.Z-rc.N`), never by merging into `stable`. Use the **`shipit release`** command (`plan` to propose, `prepare` to open/update the PR, `--prerelease --confirm` for an rc), not a hand-rolled bump + `gh pr create`. The stable channel follows the latest **final** tag reachable from `origin/stable` (not the branch tip), failing closed if none exists. Full ritual: `RELEASING.md`; agent-facing copy: `src/server/shipit-docs/release.md` + `prompts/releases.md`.

## Docs structure

```
docs/
  NNN-feature-name/
    plan.md        — How the feature works, key files, patterns
    checklist.md   — Remaining work items or tracking notes
    mockup.html    — Optional UI prototype committed as reference (or mockup.svg / mocks/)
```

Docs are **reference material** — what a feature is, why, and how (including planned-but-unimplemented designs); work tracking lives in the issue tracker. Features are numbered by creation order; read a feature's `plan.md` first, check its `checklist.md` for remaining work, create `docs/NNN-new-feature/plan.md` for a new one. Frontmatter (`issue`/`title`/`description`) is optional. A 100%-complete `checklist.md` folds the doc into collapsed **Done**, else **Active**. `issue:` shape selects the tracker — **Linear = full URL without the title slug** (a bare `TRACKER-28` is rejected), **GitHub = `owner/repo#123`** or a full URL.

### Keep the tracker in sync when you touch a design doc

Whenever you create or materially update a `docs/NNN-*` design doc, sync its tracker item in the same turn. Use the tracker-neutral `shipit issue` command (see `src/server/shipit-docs/issues.md`) — not `gh issue`, `gh api`, or a Linear MCP.

- **Doc has an `issue:` pointer (Linear *or* GitHub).** Post a comment on that issue summarizing what changed in the doc and why: `shipit issue comment <pointer> --body-file - <<'EOF' … EOF`. The pointer's shape selects the tracker; pass it verbatim. This applies equally to GitHub-attached docs — comment, don't open a second tracker item.
- **Doc has no `issue:` pointer.** Create a Linear issue to track it, then cross-link — all in the same turn (docs/187). Run `shipit issue create --title "<doc title>" --body-file - <<'EOF' … EOF` (it defaults to Linear; the body should summarize the doc and link back to its path). **Always set appropriate labels when creating an issue** (`--label <name>`, repeatable) so it's categorized correctly — pick the label(s) that match the work's intent (e.g. `feature`, `bug`, `chore`, `documentation`). The command prints the new issue's identifier and URL on stdout, so read that URL and write it into the doc's `issue:` frontmatter (full URL, no title slug) in the same turn. Creation is do-then-surface — a provenance card with Undo (which cancels the issue) is posted automatically; you don't propose-and-wait. If Linear isn't connected, the command says so — surface that to the user rather than falling back to a GitHub issue.

This rule is ShipIt-specific and deliberately lives here, not in `src/server/shipit-docs/design-docs.md` (which ships to every repo edited inside ShipIt). A `checklist.md` can sit alongside any doc and drives the Active/Done grouping — mark all items `[x]` when the work is finished.

**Where does a fact live — `checklist.md`, `plan.md`, or the Linear issue? Never mirror; duplicated sources drift.** Decide with one mechanical test: **"Would this fact require a *commit* to change?"** Changes *because the code changed* → committed file (`checklist.md`/`plan.md`). Changes for *planning/coordination* (priority, status, ownership, scheduling, cross-issue relations, async discussion) → **Linear**. One-liner: does it belong to the diff, or to the conversation about the work?

| Surface | Holds | Must NOT hold |
|---|---|---|
| **`checklist.md`** | The branch's implementation to-do: granular build steps checked off in the *same PR*. Diffable, branch-scoped; drives the docs-list Active/Done grouping. | Priorities, the status of *other* work, cross-issue links. |
| **`plan.md` / committed docs** | What the feature *is*/*how it works* **as of this commit**: design, key files, **settled** rationale. Plus exactly **one** `issue:` self-pointer. | Live priority, sibling-issue status rosters, scheduling. |
| **The Linear issue** | The work unit + everything on a **non-code cadence**: priority, status (automated via `Closes`/`Refs`), cross-issue relations, ownership, scheduling, discussion, progress narration across PRs. | — (a tracker is a conversation medium; markdown is not). |

When you do work, you **comment on the issue** — you do not commit a status update. A committed doc MAY name sibling issue IDs inline as stable identifiers ("blocked on SHI-79") but MUST NOT record their **priority/status** (that drifts) — no sibling-status *tables*; let Linear hold live state and cross-issue relations. A design doc may carry the author's **analyzed ordering** as settled narrative ("sequenced first"); the live priority of record stays in Linear, and the two are deliberately not reconciled. Quick test: if a checklist item could be copied verbatim into the issue as a sub-task, it's in the wrong place.

When a doc describes UI whose layout is load-bearing (filters, tables, breakpoints), commit the prototype beside `plan.md` — `mockup.html`, `mockup.svg`, or a `mocks/` subdir — as a self-contained static artifact (inline CSS / SVG, no build step, diffable; `.png` is a supplement, not the source of truth). Link it from `plan.md` with a "Visual reference" note. (The `present` tool's tab is ephemeral; committed mocks are reviewable in PRs and survive sessions.)

`plan.md` may also carry an optional single-line `description:` field — the docs viewer renders it under the title (one sentence, no multi-line YAML scalars):

```yaml
---
issue: octocat/hello-world#42
description: Show a short doc description from frontmatter under the title in the docs panel.
---
```
