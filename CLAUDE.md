# CLAUDE.md

ShipIt is a browser-based AI editor — describe what you want in chat, the agent writes the code, and you see results live. The agent runs as a CLI inside a session container; Claude Code CLI is the default backend, Codex CLI is also supported, and the architecture is agent-agnostic so additional backends can be added later. Authentication normally uses the user's existing subscription with the chosen provider; a metered API key exists only as a fallback ranked *below* connected accounts.

## Product principles

These govern what ShipIt is. They override convenience, "what other tools do," and "this is how the underlying platform works." A proposal that conflicts with one is wrong. Design docs cite them by number — **§1–§5 are stable identifiers; compress the prose, never renumber.**

### 1. ShipIt is the surface. The user does not leave it.

You build, review, ship, and debug inside one chat-shaped IDE. PRs, CI status, deploy status, diffs, commit history, conversation history, terminal output, preview, and merge conflicts all surface inline — no GitHub tab, hosting dashboard, CI tab, or local terminal required. Sending the user elsewhere is a failure of the product, not a feature.

### 2. Inline beats link-out. Always.

If the upstream system has the data, ShipIt fetches and renders it. Links to GitHub or the cloud provider are **escape hatches** in overflow menus, never the happy path — "View on GitHub" sits beside the PR card, and we never bounce anyone to GitHub's diff viewer. The reason is compounding: once the user is reading a PR on github.com, the next comment, re-request, and fixup happen there too. The cycle has to start somewhere; we keep it inside.

### 3. External tabs are reserved for things ShipIt does not own.

The whole list: **OAuth / auth flows** (Anthropic, GitHub own their login screens), **account and billing pages** (provider billing, GitHub repo creation and settings), and **external documentation** the user explicitly clicks through to. "The PR was created so let's open it" is not on it.

### 4. If we don't render it inline yet, that's a backlog item, not a license to link out.

The link-out acknowledges we haven't built the inline view. It isn't the design.

### 5. Chat is the input surface. The agent is the actor.

The user describes intent; the agent runs the commands, edits the files, reads the logs, runs the tests. We deliberately do **not** give the user shell-shaped affordances — quick-action button rows, command palettes that execute shell, hotkey-bound task runners, "click to run npm test" buttons. Those belong to terminal-shaped IDEs; here they're a category mistake that nudges the product back toward the CLI wrapper it's trying to replace. The legitimate needs already have primitives:

| Need | Primitive |
|---|---|
| Recurring user-driven task ("run the tests", "regenerate types") | Ask the agent in chat. |
| Long-running services (dev server, Prisma Studio, log tailer) | Declare in `docker-compose.yml` with `x-shipit-preview: auto`. |
| One-time setup on a new session (`npm install`, codegen) | `agent.install` in `shipit.yaml`. |
| Ad-hoc shell access for debugging or exploration | The existing terminal panel. |

**Corollary: "saves an LLM round-trip" is not a feature.** Spending a turn on a routine command is the intended cost of chat-shaped UX — it keeps the agent in the loop and the chat history complete. The user still navigates, reviews, instructs, accepts, rolls back, branches, merges; they just don't *operate* the box. That's what they hired the agent for.

### Corollary: how to evaluate proposals

1. Does it need a tab outside ShipIt, or assume GitHub is open elsewhere? Redesign, unless it's a §3 exception.
2. Is the link-out the primary affordance rather than an overflow escape hatch? Redesign.
3. Does it give the user a shell-shaped affordance for a command the agent could run? It solves a problem ShipIt doesn't have — §5.

## Runtime

ShipIt runs inside Docker containers: the orchestrator runs in a container and spawns session worker containers. The one exception is the dogfood inner instance (`RUNTIME_MODE=local`), which skips Docker entirely — see [Dogfooding ShipIt in ShipIt](#dogfooding-shipit-in-shipit).

## Setup

```bash
npm install
```

**Important:** If any npm command fails with missing `node_modules` (e.g., `Cannot find package`), run `npm install` first.

## Commands

- **`npm run test:dev`** — **dev default.** Only tests affected by uncommitted, staged, and untracked (newly created) changes + smoke tests (`-- --list` to dry-run). Use while iterating.
- `npm run test:smoke` — smoke tests only (core connectivity, HTTP bootstrap, git, one client component).
- `npm test` — full suite. Sparingly — CI runs it on every PR; run locally only if you suspect wide breakage. Single file: `npx vitest run <file>.test.ts`.
- **`npm run lint:dev`** — **dev default.** ESLint over files changed vs `origin/main` + uncommitted + untracked (newly created) (`-- --list` to dry-run). The full lint loads all ~700 TS files (~50 s, ~2.85 GiB); CI runs it, so this is the inner loop.
- `npm run lint` — full ESLint on `src/` (cached; warm re-run near-instant). Sparingly — when you suspect a cross-file rule (e.g. `no-deprecated`) tripped elsewhere.
- `npm run typecheck` — `tsc --noEmit`, incremental (warm ~5 s). Whole-project by design, no per-file variant.
- `npm run build` — Vite client build. (`npm run dev` is the Vite/tsx dev server, but **don't start it in bash to preview** — ShipIt serves the preview via the `dev` Compose service in `docker-compose.yml`, which runs `npm run dev` itself; see [Dogfooding ShipIt in ShipIt](#dogfooding-shipit-in-shipit). A bash-started server is also reaped when the container goes idle.)

Session containers are sized from host capacity (docs/229), so `npm test` and the integration tests **can** run in-box. Still prefer the fast loop (typecheck, `lint:dev`, affected co-located tests); reach for the full suite on suspected wide breakage. A genuine OOM means the host is undersized — raise `DEFAULT_SESSION_MEMORY_MB` rather than concluding the suite can't run locally.

**Always kill child processes via `killChild()` (`shared/kill-child.ts`), never `child.kill()`** — on a spawn that never exec'd, `child.kill()` signals an arbitrary unrelated pid (full mechanism: that file's docstring). Diagnose before naming an OOM: a suite dying part-way at exit **143** is that friendly fire, not memory; a real OOM is exit **137** and is recorded at `/sys/fs/cgroup/memory.events` → `oom_kill`.

## Debugging the UI

The Playwright MCP server is configured and launches its own browser. Use `browser_navigate` to open the ShipIt UI (e.g. `http://127.0.0.1:3000`), then `browser_snapshot` to read page state, `browser_click` to press buttons, `browser_fill_form` to type text, and `browser_take_screenshot` for visual checks.

## Dogfooding ShipIt in ShipIt

The repo runs inside itself via the manual `dev` Compose service (`shipit service start dev`), an inner orchestrator on `RUNTIME_MODE=local`. **Load the `dogfooding-shipit` skill** for local-mode limitations, which credentials to set (almost none), seeding, and driving the inner instance over HTTP.

## Project structure

Entry point is `src/server/orchestrator/index.ts` (`buildApp()`). `src/server/orchestrator/` is the main process, `src/server/session/` runs inside session containers, `src/server/shared/` is used by both, and `src/client/` is the React 19 + Tailwind v4 frontend. `android-snapshot-test/` and `android-overlay-test/` are separate Gradle builds that Node tooling ignores (docs/213). Per-area file maps live in the architecture skills; `ls` beats a directory tree that silently rots.

## Architecture

Three-layer system: browser (React SPA) → orchestrator (Fastify) → session workers (Docker containers).

Architecture reference lives in `.claude/skills/`, disclosed progressively. **Both backends read them** — Claude and Codex auto-disclose the same set with descriptions (no `.codex/skills/` needed, and no catalog duplicated here), so detail demoted into a skill reaches both; see `docs/209-cross-agent-skill-disclosure`. **Always-on invariants belong in this file** (shared with Codex via the `AGENTS.md` symlink), not in a skill — and a skill can lag it, so where they disagree the invariant below wins and the skill needs fixing.

## Key patterns

These are non-obvious architectural patterns that aren't apparent from the file structure alone.

### Orchestrator ↔ container communication

**HTTP-only, never Docker exec**: commands out via `worker-http.ts`, events back over SSE. `ProxyAgentProcess` delegates to the container so local and remote agents look identical. Detail: **session-containers**, **session-processes**.

### WebSocket lifecycle MUST NOT affect server behavior

The WebSocket connection is a *transport* between the browser and the orchestrator. It must not be allowed to drive server-side state, agent lifecycle, container lifecycle, or persistence. Disconnects, reconnects, browser crashes, and network blips are all expected and routine — none of them should change what the server is doing.

- **Capture per-connection state at the top of long-running functions**, never inside async callbacks. `runAgentWithMessage` and `wireAgentListeners` capture `runner`, `capturedSessionId`, `capturedSessionDir` once at entry; anything in `agent.on(...)`, `setTimeout`, `Promise.then`, or a recursive call reads ONLY those.

- **Resolve runners through `resolveRunner(ctx)` / the registry, never `ctx.getRunner()`** — that returns the per-connection `attachedRunner`, which becomes `null` on close, while the registry lives for the whole process. Then read and mutate the resolved runner directly (`runner.running = false`); the old `ctx.setIsClaudeRunning`-style setters were deleted precisely because they became silent no-ops after disconnect (`docs/095`).

- **Emit via `runner.emitMessage()`, not `ctx.send()`.** It broadcasts to every attached viewer AND buffers into the turn-event log, so reconnecting viewers see post-turn messages; `ctx.send` writes to one socket and silently drops on a closed one.

- **A close handler only calls `detachFromRunner()`.** Never `runner.dispose()`, `agent.kill()`, `terminal.kill()`, or `container.destroy()` from any WS lifecycle event. Disposal belongs to the periodic idle enforcer (60s grace after detach; refuses to kill running agents) and explicit user actions (archive, repo delete, full reset, shutdown), which pass `{ force: true }`.

Executable contract: `integration_tests/ws-disconnect-resilience.test.ts`.

### Service layer & type system

Three-tier **Routes/WS handlers → Services → Managers**: `services/*.ts` are pure async fns over domain types (not handler context), reusable by both; errors are `ServiceError(statusCode, message)`. WS messages are discriminated unions keyed on a `type` literal, narrowed by the dispatch switch. WS handlers compose `ConnectionCtx` / `RunnerCtx` / `AppCtx` and declare only what they need. Detail: **server-architecture**.

### Post-turn flow

After a turn (`agent_result` in `agent-execution.ts`): `postTurnCommit()` auto-commits → `scheduleAutoPush()` debounces a 5s push (if GitHub auth) → PR lifecycle card emitted (if a remote exists). **Critical**: session context (sessionId, sessionDir) is captured at turn *start*, not at "done", so a mid-turn session switch can't corrupt commits.

Four invariants govern the rest. Each looks reorderable and is not; each is pinned by a guard test.

**1. The queue never drains before the finished turn's work is committed** (planning#264). A queued turn may begin by discarding working-tree state (`git reset --hard`, a branch reset), and edits that never entered git have no reflog entry and no recovery — so `tryDrain` (`turn-executor.ts`) awaits the LOCAL commit first. Only the local half: the NETWORK half (PR card, merged-session re-arm, release flow) stays *after* the drain, so back-to-back messages never wait on a GitHub round-trip. The guarantee lives inside `tryDrain` rather than at the call sites because the non-streaming path drains at `agent_result` and commits later in `done`. Also load-bearing: `session_agent_finished` fires *after* the drain (no finished→started flicker) but *before* the network flows; the runner "idle" event (`signalIdleIfIdle`, which drives CI-fix / conflict remediation) fires last of all, so remediation never runs against a pre-commit tree.

**2. Every terminal path runs the commit — including the ones where the agent process dies.** `runCommitAndPr` is reachable from four places in `turn-executor.ts`, not two: the clean end, the streaming **abnormal exit** (`done` with no `agent_result` — crash, OOM, SIGTERM), the adapter-level **`error`** path (where a *dispatched* crash lands), and the **failed auth heal**. The latter three once ended at `tryDrain()` alone — which commits only when something is *queued*, so a dead agent with an empty queue committed nothing at all and its edits sat in the working tree. `runCommitAndPr` is memoized precisely so all four can call it unconditionally without duplicating a GitHub round-trip. Adding a terminal path? Call it. Guards: `turn-crash-commit.test.ts`, `turn-drain-commit-ordering.test.ts`.

**3. Reachable is not enough — the commit must be UNSKIPPABLE, so every step preceding it runs through `postTurnStep`** (planning#279). The commit is sequenced *last*, behind steps that touch SQLite, the credentials tree and viewer transports, inside un-awaited `async` listeners. A throw there used to abandon the rest as an unhandled rejection, and *nothing ran again*: the transcript was already persisted, `running` cleared, every viewer told the turn finished — and a resident streaming process never fires `done`, so no reconciler picked it up. Edits sat uncommitted with no error anywhere until a later turn's `git add -A` swept them up under the *wrong* summary (PR #1890 shipped one commit short this way). `postTurnStep` logs and continues; it reorders nothing. Guard: `turn-commit-not-skippable.test.ts`.

**4. A branch whose work shipped under a different SHA returns to base via `shipit branch reset-to-base --force --reason "<why>"` — never a rebase** (planning#279). After a squash merge, `computeResetEligible`'s `HEAD === mergedHeadSha` clause is *terminal*, so without the override the session can never open another PR. Rebase is not the alternative it appears to be: the base holds one commit with the branch's **final** state while the branch's **first** commit adds the same paths in their **initial** state, so `git rebase origin/<base>` hits add/add conflicts instead of dropping already-shipped patches. `--force` bypasses that one clause and nothing else — the clean-tree and coherence checks stay, and the required `reason` plus the `forced` transcript card are the record that replaces the gate. `git reset --hard` stays blocked by `block-branch-ops`. Guard: `reset-to-base-force.test.ts`.

### Message group boundaries

Agent events group into chat-history entries at tool-result boundaries: each `agent_tool_result` sets `needsNewMessageGroup` so the next `agent_assistant` starts a fresh group, keeping groups 1:1 with message bubbles on reload. Key file: `agent-listeners.ts`.

### Chat transcript content MUST be persisted, not just emitted

Anything that renders **inline in the chat transcript** — a message bubble or a card (`MessageList.tsx`) — must be written to **persisted chat history**, not merely emitted over WS. `runner.emitMessage()` is *transport only*: it broadcasts to attached viewers and buffers into the per-turn **turn-event log**, which a WS **reconnect** replays. It persists nothing. A session **switch** or a full **page reload** rehydrates from persisted chat history (`ChatHistoryManager` → `GET /history`), so an emit-only card renders live, survives a reconnect, and then **vanishes**. This bug class has recurred (voice notes `docs/163`, bug-report cards `docs/164`).

The dividing line: **transient** signals (spinners, `preview_status`, queue counts, live activity) are emit-only and correctly disappear. **Transcript content** (any card the user expects to still be there tomorrow, and any terminal state like "filed"/"failed") must persist. If it has a place in the scrollback, it has a row in the DB.

For a **side-channel card** (one arriving outside the agent-event stream, so `buildTurnMessages` won't capture it): **emit via `emitChatCard` (`chat-card-persistence.ts`), never bare `emitMessage`.** It atomically emits, records the card in-band (anchored by `afterGroupIndex` so it interleaves at its true position), and persists — and it decides, on `runner.running`, whether the card rides the in-progress turn or is appended as an already-final row. That branch is exactly why you must never hand-roll `recordChatCard` + `persistTurnInProgress` at a call site that can run post-turn (a backgrounded `shipit agent run`, a user-filed bug report): reviving a finished turn as `in_progress=1` gets the whole set deleted by the next turn's `replaceInProgress`, which silently destroyed an 18-minute cross-agent review (docs/236).

Adding a card then means: a typed `PersistedMessage` field (+ column, `toRow`/`fromRow`, `database.ts` migration); rehydration in `loadSessionHistory`; registration in `CARD_MESSAGE_FIELDS` (`visual-elements.ts`) if it renders on an empty-text message; history round-trip + no-duplicate-on-replay tests; and extending `EVERY_OPTIONAL_FIELD_MESSAGE`. Two guard tests (`chat-history.test.ts`, `visual-elements.test.ts`) make this self-enforcing — a forgotten step is a red build naming the field. Full recipe: `docs/188-persist-transcript-cards`, `docs/191-card-persist-on-emit`.

**Every transcript message carries its owning `sessionId`, and the client drops the foreign ones.** The browser holds exactly ONE transcript in memory (the active session's `messages` array), while the per-session WS is keyed off the *route* (`urlSessionId`) and handlers write through the *store* (`useSessionStore.sessionId`) — those agree in the steady state but not across every switch/fork/claim transition, so an unscoped card lands in whichever session happens to be active. So: put `sessionId` on the WS type (a card without one cannot be filtered), and add the type to `TRANSCRIPT_SCOPED_MESSAGES` in `client/hooks/message-handlers/index.ts` — `dispatchMessage` drops it on a mismatch. Dropping is safe because the card is persisted in its owner's history (switching there rehydrates it). Messages that legitimately describe *other* sessions (`session_status`, `pr_lifecycle_update`, `reset_eligible`, `usage_update`, `session_forked`) stay out of that set.

### Preview routing

Reverse proxy (`preview-proxy.ts`): subdomain routing `{sessionId}--{port}.<host>` is the **only** mode — the path-based `/preview/:sessionId/:port/*` route was deleted in docs/175 (absolute asset paths 404 without HTML rewriting), and `preview.url`'s `/preview/…` string survives solely as the container-mode *sentinel* the client tests with `startsWith`. The proxy matches `{uuid}--{port}.anything` (`preview-proxy.ts:44`), so it is domain-agnostic; HMR URLs are patched to the iframe's own origin so hot-reload survives the proxy. **Consequence:** previews need a host that can carry a wildcard subdomain, so the client refuses to build a URL for a **non-loopback** IP literal (`usePreviewHealthPoller.ts:43`) and renders an explanatory empty state instead — `127.x`/`::1` are exempt, normalized to `localhost` one line earlier. Full detail: `docs/009-preview-system`, `docs/175-preview-subdomain-only`; local/Tailscale access: `docs/254-local-bind-and-tailnet-access`.

### Disk cleanup

Each surface prunes **where the leak happens**, sorted by *what clock the leak grows on* (planning#198): per-session teardown drops named volumes (archive/fullReset only, never idle/restart); `deploy.sh` owns build-time image prunes; `startup-janitor.ts` runs **boot-only** for crash-recovery leftovers; `steady-state-reclaim.ts` runs on the disk-tier escalation pass (`escalateDiskTiers`) for what grows with the clock. That pass fires from **three** triggers — startup, **per session activation (the primary one)**, and an hourly activity-independent backstop — all guarded by a single in-flight flag, and it is the single steady-state entry point. Detail: those files' docstrings, `docs/183-overlay-dep-store`, **session-containers**.

### Client communication & stores

Two browser channels: per-session **WebSocket** (`/ws/sessions/{id}`) and global **SSE** (`/api/events`). Stores cross-reference via `useXStore.getState()` (not subscriptions — avoids cycles); resets are centralized in `stores/actions/session-actions.ts`; hydration is HTTP bootstrap → WS `loadSessionHistory()` → live WS, guarded by `sessionId` against stale messages. Detail: **client-architecture**.

### Integration test patterns

`TestClient` buffers WS messages from connect (no send-before-listen races); `isTestMode` in `buildApp()` enables `POST /api/_test/sessions` (no Docker); fakes expose injection methods. Detail: **testing-and-quality**.

## Workflow

- **Read before coding** — before changing a feature, read its `docs/NNN-feature/requirements.md` (if present) and `plan.md`, plus the source files listed under "Key files". Trace the data flow for similar features to understand existing patterns. A new feature starts at `requirements.md`, not at `plan.md` — see [Every new feature is under requirements discipline](#every-new-feature-is-under-requirements-discipline).
- **Verify an inherited guarantee at the source; a doc describing one is a claim, not a contract.** When your design leans on a neighbouring mechanism ("the retry supervisor covers restart", "that lease prevents concurrent entry"), read the code that would have to hold for it. This repo has repeatedly shipped plans asserting guarantees the code did not provide — docs/196 claimed a failed delivery retried "on the next poll" when the only retry was at bootstrap; planning#257's write-up ruled out a re-narrowing that planning#261 then did by accident days later. Both read as settled fact. State such dependencies as "verified at `file.ts:fn`", not as inheritance.
- **Requirements are usually stated at the UX level — don't promote your mechanism into one.** "Ship several PRs in a row without shepherding each merge" is the whole requirement; it implies nothing about unattended turns or a new subsystem. Build the smallest mechanism that produces the stated experience, and keep what was actually asked for separate from what you inferred (docs/239's "Requirement provenance" section is the pattern). A feature that starts needing platform primitives to support it is evidence the shape is wrong, not a work estimate.
- **Adversarial review hardens a design; it does not simplify it.** A reviewer asked "what's wrong with this" will answer that question and never "this shouldn't exist" — so rounds of review reliably add mechanism and never remove it. Between rounds, ask the opposite explicitly: for each element, *would anyone notice if it were removed?* Run at least one review with that brief before implementing anything sizeable; on docs/239 it cut roughly a third of the design after five ordinary rounds had only grown it.
- **Identify all touchpoints** — plan which files need changes (server, client, types, tests) before writing code.
- **Co-locate tests** — place tests next to source files (`foo.ts` → `foo.test.ts`). Follow patterns from neighboring test files.
- **Lint and typecheck before finishing** — run `npm run lint:dev` and `npm run typecheck` after code changes and fix any errors before considering work complete. `lint:dev` is the dev-loop default; CI runs the full `npm run lint` so the source of truth is unchanged.
- **Get the other backend's review of substantive work** — Claude-authored work reviewed by Codex and vice versa, via `shipit agent run --agent <other> --prompt-file -`; a same-model reviewer shares your blind spots. Use that, **not an in-process `Task`/`AgentTool` subagent** — the Claude CLI's built-in "don't call the AgentTool unless asked" is baked into its binary and can't be turned off here, but a brokered out-of-process run isn't what it means. You judge when work warrants it — a PR, a substantive change, any result you're about to call done — and findings are advisory. Two things the prompt must carry: **review only, do not edit** (it shares this workspace and its writes get auto-committed under your session), and `git diff main...HEAD` **plus** `git diff` / `git status --short`, since this turn's work isn't committed yet. Don't block on it — a real review outlives a foreground command, so launch it detached and collect with `shipit agent result <RUN-ID> --wait`. If the other backend isn't signed in, skip and say so.
- **Update docs when done** — update the relevant `plan.md` with new subsystems, patterns, or key files you added. Mark completed checklist items with `[x]`.
- **Update shipit-docs when changing agent-facing behavior** — when changing platform behavior visible to the agent inside session containers (preview config, shipit.yaml schema, container environment, GitHub integration), update the corresponding file in `src/server/shipit-docs/`. These docs are baked into the session worker image at `/shipit-docs/` and are the agent's primary reference for the platform.

## Code conventions

- **ESM throughout** — `"type": "module"` in package.json. Use `.js` extensions in relative imports (e.g., `import { foo } from "./bar.js"`).
- **Type imports** — use `import type { X } from "./path.js"` for type-only imports.
- **Node built-ins** — use `node:` prefix (e.g., `import fs from "node:fs"`).
- **Naming** — classes: PascalCase, functions: camelCase, events/WS message types: snake_case, constants: UPPER_SNAKE_CASE.
- **React** — functional components only, hooks for all state/effects. React 19 JSX transform (no `import React` needed).
- **Icons** — use `@phosphor-icons/react` for all icons. Never hardcode `<svg>` elements. Use the `ICON_SIZE` constants from `src/client/design-tokens.ts` (XS=12, SM=16, MD=20, LG=32, XL=48) for icon sizes. See the `design-language` skill for full icon and styling guidance.
- **Styling** — Tailwind CSS v4 utilities over the **semantic color tokens**; concrete values live in per-theme CSS under `src/client/themes/`. Never hardcode a palette value — ShipIt is multi-theme, not dark-mode-only. See the `design-language` skill.
- **Strict TypeScript** — `strict: true` in tsconfig. Target ES2022, module ESNext with bundler resolution.

## Prompts

LLM prompts (agent system instructions, voice cleanup, session naming) are **content, not logic**: prompt *text* lives in `.md` files loaded at module top level; *composition* stays in TypeScript. **The prompt-cache contract is load-bearing** — every variant renders once at module load into a frozen constant, so the per-turn path is a pure lookup and the CLI string stays byte-stable. Never move composition or the `.md` reads onto a per-call path. **Load the `prompt-architecture` skill** before editing prompts or their tests.

## Dependency policy

Two rules, both enforced by `npm run check-deps` (`scripts/check-dependency-age.ts`):

1. **Pin to exact versions** — `"react": "19.2.4"`, never `^`/`~`/`latest`/a range/a tag/a git URL. Floating ranges let a fresh checkout silently pick up a version nobody has run; bumps are deliberate edits, not a side effect of re-running install.
2. **Minimum age of 7 days** since npm publication — the window lets scanners and the registry's abuse pipeline catch a compromised release before it reaches our build. If you genuinely need a same-day release (a security fix in a transitive), call it out in the PR and get explicit sign-off; don't bypass silently.

To bump: edit `package.json` to the exact version, `npm install` to refresh the lockfile, then `npm run check-deps` before opening the PR.

A third rule is enforced separately by `npm run check-audit` (`scripts/check-audit.ts`):

3. **No advisory at `high` or above** may affect the dependency tree unless it is
   allowlisted in `.audit-allowlist.json` with a reason and an expiry date. The
   allowlist — not a lowered threshold — is the escape hatch for an advisory
   with no fix available yet; an expired entry fails the build on purpose, as
   the reminder to revisit it.

**Transitive vulnerabilities are fixed in the `overrides` block, and nothing
updates that block for you.** Dependabot manages `dependencies` /
`devDependencies` only, and an override is absolute, so `npm audit fix` and
`npm update` cannot move a pin either. A pin left alone becomes the vulnerable
version it was added to escape, and then blocks every automatic fix — that is
exactly how the block silently went stale for roughly three months before
`check-audit` existed. When `check-audit` names a transitive package, raise its
pin (or add one) in `overrides`, then run `npm install`.

## Releasing

ShipIt's own repo uses the **`release-branch`** mechanism (`shipit.yaml` `release:` block, docs/214): releases are **merge-triggered**. Cut one by opening a version-bump PR into `stable` and merging it — `.github/workflows/release.yml` then derives the tag `v<package.json version>` from the merged commit, gates on a green build, and **creates + pushes the tag and Release itself**. **Never hand-push a final `vX.Y.Z` tag** — CI owns that. rc's are the exception: cut via the tag path (push `vX.Y.Z-rc.N`), never by merging into `stable`. Use the **`shipit release`** command (`plan` to propose, `prepare` to open/update the PR, `--prerelease --confirm` for an rc), not a hand-rolled bump + `gh pr create`. The stable channel follows the latest **final** tag reachable from `origin/stable` (not the branch tip), failing closed if none exists. Full ritual: `RELEASING.md`; agent-facing copy: `src/server/shipit-docs/release.md` + `prompts/releases.md`.

## Docs structure

Feature docs live in `docs/NNN-feature-name/` (`requirements.md`, `plan.md`, `checklist.md`). Docs are **reference material** — what a feature is, why, and how, including planned-but-unimplemented designs; work tracking lives in the issue tracker. Read a feature's `plan.md` before changing it, and its `checklist.md` for remaining work. **Load the `docs-navigator` skill** for the folder layout, frontmatter schema, `issue:` pointer syntax, and prototype conventions.

The scan surfaces **every** `.md` file in the workspace, not just `docs/` — so treat any markdown you write as user-visible.

### Every new feature is under requirements discipline

Requirements discipline (docs/241, `/shipit-docs/spec-discipline.md`) is opt-in per feature *for projects built inside ShipIt*. **In this repo it is mandatory for every new feature**: if the work warrants a `docs/NNN-*` folder, that folder gets a `requirements.md`, written **before** `plan.md`. Existing features without one are not retroactively required to have it — but the moment you materially rework one, write its requirements first.

That means, in order:

1. **`requirements.md` first, from what the human actually said.** Numbered, plain-language, observable statements of what the feature must do — never how. Anything you had to supply yourself is not a requirement: it goes under `## Open questions`.
2. **Ask, don't assume.** Batch the open questions into one structured question with concrete options and a recommendation. Do not write implementation code while any bullet remains under `## Open questions`; requirements and design work may continue.
3. **Record the answer where it happened.** A human answer adds/edits the numbered requirement *and* leaves a dated receipt under `## Resolved questions`, with the open-question bullet removed in the same change — receipt, removal, and requirement change all in one diff. An agent inference never clears an open question.
4. **Then design.** `plan.md` implements `requirements.md` and cites requirements as `(req 3)`; it opens with a link to the requirements doc. Later human input lands in `requirements.md` first — editing `plan.md` from human input while the requirements stay unchanged makes the design a second, hidden source of requirements.
5. **Independent check before you call it done.** The other backend (`shipit agent run --agent <other>`, per [Get a different model's review](#workflow)) compares the branch diff against every numbered requirement. Your own final pass doesn't count, and neither does a subagent under your own model.

Nothing enforces this mechanically — the pull-request diff is the enforcement, so a skipped question or a self-promoted requirement is visible to review (mechanical enforcement is planning#275). `docs/241-spec-discipline/` is the worked example: read its `requirements.md` alongside its `plan.md` for the shape.

Not every change is a feature. Bug fixes, refactors, and chores that don't get a docs folder don't get a requirements doc either — the rule attaches to the folder, not to the commit.

### Keep the tracker in sync when you touch a design doc

Creating or materially updating a `docs/NNN-*` doc syncs its tracker item **in the same turn**, via the tracker-neutral `shipit issue` command — never `gh issue`, `gh api`, or a tracker's own MCP.

- **Doc has an `issue:` pointer**: comment on it — `shipit issue comment <pointer> --body-file -`. The pointer identifies its own tracker; pass it verbatim. Comment; don't open a second item.
- **Doc has no pointer**: create one and cross-link, same turn (docs/187) — `shipit issue create --tracker planning --label <name> --title "<doc title>" --body-file -`. **`--tracker` is required** so a forgotten flag can't file into this public repo's own issues (docs/248), and **always set a label** matching intent. Write the printed identifier back into the doc's `issue:` frontmatter as `planning#NNN`. Creation is do-then-surface — a provenance card with Undo is posted automatically, so don't propose-and-wait. If the tracker isn't connected, surface that rather than filing elsewhere.

**Where does a fact live — `checklist.md`, `plan.md`, or the tracker issue? Never mirror; duplicated sources drift.** One mechanical test: **"Would this fact require a *commit* to change?"** Changed *because the code changed* → committed file. Changed for *planning/coordination* (priority, status, ownership, scheduling, cross-issue relations, discussion) → **the tracker**. Does it belong to the diff, or to the conversation about the work?

| Surface | Holds | Must NOT hold |
|---|---|---|
| **`requirements.md`** | What the feature must do, in the human's words: numbered observable statements, plus `## Open questions` and dated `## Resolved questions` receipts. Human-owned. | How it's built (files, mechanisms, APIs), agent assumptions the human never approved, status. |
| **`checklist.md`** | The branch's implementation to-do: granular build steps checked off in the *same PR*. Diffable, branch-scoped; drives the docs-list Active/Done grouping. | Priorities, the status of *other* work, cross-issue links. |
| **`plan.md` / committed docs** | What the feature *is*/*how it works* **as of this commit**: design, key files, **settled** rationale. Plus exactly **one** `issue:` self-pointer. | Live priority, sibling-issue status rosters, scheduling. |
| **The tracker issue** | The work unit + everything on a **non-code cadence**: priority, status (automated via `Closes`/`Refs`), cross-issue relations, ownership, scheduling, discussion, progress narration across PRs. | — (a tracker is a conversation medium; markdown is not). |

When you do work you **comment on the issue**; you do not commit a status update. A committed doc MAY name sibling issue IDs inline as stable identifiers ("blocked on planning#81") but MUST NOT record their **priority/status** — no sibling-status *tables*. A design doc may carry the author's **analyzed ordering** as settled narrative ("sequenced first"); live priority stays in the tracker, and the two are deliberately not reconciled. Quick test: if a checklist item could be copied verbatim into the issue as a sub-task, it's in the wrong place.
