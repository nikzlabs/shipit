---
status: in-progress
priority: high
---

# ShipIt UI in local mode (dogfooding ShipIt inside ShipIt)

Run a working-enough ShipIt orchestrator *inside* a ShipIt session container, without the inner orchestrator trying to create Docker containers of its own. The goal is a development loop: open the ShipIt repo in production ShipIt, get an inner UI you can chat with, edit the codebase, and see the changes live.

This replaces the deleted `docs/089-shipit-in-shipit/` plan, which tried to make nested *real* Docker work by relaxing the Docker proxy. That solved a different problem (production-fidelity nesting). For pure dogfooding, never trying Docker is simpler, smaller, and more aligned with the goal.

## Goal & non-goals

**Goal.** Inside an outer ShipIt session whose workspace is the ShipIt repo, a Compose `dev` service runs the orchestrator with `RUNTIME_MODE=local`. Outer ShipIt's preview panel shows the inner UI. The inner UI lets the developer edit the ShipIt source via chat, run tests, see diffs, do git, manage PRs — i.e. all the things that don't require the inner orchestrator to spawn containers itself.

**Non-goals.**
- Running ShipIt on a developer laptop without Docker. Out of scope.
- Production-fidelity inner sessions. Inner sessions in local mode have no container isolation, no resource caps, no Compose stacks, no warm-pool containers, and (for v1) no preview.
- Testing the container-management code (`SessionContainerManager`, `compose-generator`, `docker-proxy*`, `container-lifecycle`) inside the inner orch. Those subsystems are simply not loaded — they remain covered by integration tests and the production binary.
- Multiple concurrent inner sessions. v1 supports one active inner session at a time. Multi-session is a v2 question (see Phase 2).

## The cut

A single env var, `RUNTIME_MODE`, selects between two implementations of two interfaces. Everything above the runner/agent boundary is unchanged.

```
RUNTIME_MODE=containerized   ← today, production
RUNTIME_MODE=local           ← new, dogfooding
```

| Interface | `containerized` (today) | `local` (new) |
|---|---|---|
| `SessionRunnerInterface` (`session-runner.ts`) | `ContainerSessionRunner` — HTTP + SSE to a session-worker container | `SessionRunner` — the existing in-process runner, **reused as-is** |
| Agent factory | `ProxyAgentProcess` over the worker, spawned by `ContainerSessionRunner.createAgent()` | `ClaudeAdapter` / `CodexAdapter` — real CLI subprocesses, spawned in-process by `deps.agentFactory` |
| `ServiceManager` | Compose stack via `docker compose` | **Not constructed.** Inner-session preview is deferred (Phase 2). |
| Workspace isolation | One container per session | Per-session hardlinked clone under `sessions/{id}/` (the same shape `repo-git.ts` uses in production — full `.git/` dir, not a worktree) |
| Docker proxy / `SessionContainerManager` / `compose-generator` / `container-lifecycle` | Loaded | **Not loaded** |

The seam is `app-lifecycle.ts:buildRunnerFactory()`, which today returns either `deps.runnerFactory` or a `ContainerSessionRunner` factory. We add a third branch: when `RUNTIME_MODE=local`, return a factory that constructs `SessionRunner` instances and lets `runner.createAgent` go through `deps.agentFactory`. `setupContainerManager()` is skipped entirely in local mode (no `containerManager`, no Docker proxy server).

## Entry point

The ShipIt repo gains a `docker-compose.yml` with a single `dev` service that the **outer** orchestrator runs as a Compose service for this session:

```yaml
services:
  dev:
    image: node:22
    command: sh -c "npm install && npm run dev"   # see "agent.install does not run for compose services"
    working_dir: /workspace
    init: true              # so orphaned agent subprocesses are reapable
    environment:
      RUNTIME_MODE: local
      PORT: 3000
      # Inner-orch state dirs must NOT collide with outer's. See
      # "Workspace path collision" hardening note below.
      WORKSPACE_DIR: /workspace
      SHIPIT_STATE_DIR: /workspace/.inner-shipit
    volumes:
      - .:/workspace        # required — without this, /workspace is empty
    ports:
      - "3000:3000"
    x-shipit-preview: manual  # heavy boot — user starts on demand
    x-shipit-secrets:       # see "Credential injection" hardening note
      - { name: ANTHROPIC_API_KEY,        source: platform:claude_oauth }
      - { name: ANTHROPIC_AUTH_TOKEN,     source: platform:claude_oauth }
      - { name: GITHUB_TOKEN,             source: platform:github_token }
```

This must be paired with a top-level `compose: docker-compose.yml` field in the ShipIt repo's `shipit.yaml` — without it, `resolveShipitConfig` returns `compose: undefined` and `setupServiceManager` (`app-lifecycle.ts:576`) skips Compose entirely, so the dev service never starts.

The outer orchestrator picks this up via the standard `x-shipit-preview` flow in `service-manager.ts` and `preview-proxy.ts` — no platform changes needed. The service is marked `manual` rather than `auto` because the inner orch's boot is heavy (npm install + vite build + a second orch process); paying that cost on every session is wasteful when most sessions don't dogfood the inner UI. Users start it on demand from the preview panel. The inner orchestrator boots, reads `RUNTIME_MODE`, and configures itself for local mode at startup. There is no auto-detect, no `shipit.yaml` field, no `dev:nested` script — only the env var, set explicitly in the compose file that's checked into the repo.

If `RUNTIME_MODE` is unset (production deploys, regular dev runs outside a session), behavior is unchanged.

## Subsystems in local mode

### Loaded and unchanged
React client, Fastify routes, services layer, WS handlers, SSE event stream, DI, validation, sessions persistence, chat history, usage tracking, `GitManager`, `RepoGit`, `RepoStore`, GitHub auth and PR/CI polling, agent registry, `SessionRunner`, `SessionRunnerRegistry`, `ClaudeAdapter` / `CodexAdapter`, post-turn flow (auto-commit, auto-push, PR card), one-shot file-tree scans (`scanFileTree`).

### Loaded but skipped at boot in local mode
- `setupContainerManager()` returns `{ containerManager: null, dockerProxyServer: null }`.
- `cleanupOrphanComposeResources()` skipped (no Compose for inner sessions).
- `enforceIdleContainerLimit()` becomes a no-op (no containers to enforce against).
- `resolveOwnContainerIp()` not called.

### Not loaded in local mode
- `SessionContainerManager`, `container-lifecycle`, `container-health`, `container-discovery`
- `docker-proxy*` (no proxy server, no sanitize, no auth, no helpers)
- `compose-generator`, `ServiceManager` (for *inner sessions*; the **outer** orch's `ServiceManager` is what runs the dev compose service that hosts the inner orch)
- Warm-session pool

### Degraded or unsupported behaviors in local mode

These were sold as "unchanged" in earlier drafts but actually require container-backed runners. Acknowledging them honestly:

- **Inner UI's terminal panel does not work.** `ws-handlers/terminal-handlers.ts` requires `runner instanceof ContainerSessionRunner`; the in-process `SessionRunner` has terminal *state fields* but no `TerminalProcess` is ever spawned for it. The PTY logic lives in `src/server/session/terminal.ts` and is invoked from `session-worker.ts` (which doesn't run in local mode). Two viable resolutions: (a) accept the loss in v1, render a "terminal unavailable in local mode" message in the inner UI, and rely on the *outer* terminal panel for shell access; (b) add a small change to `SessionRunner` to spawn `TerminalProcess` directly and drop the `instanceof` gate. **v1 picks (a).** If terminal access in the inner UI matters during dogfooding, (b) is small enough to be Phase 1.5.
- **Inner UI's file watcher does not deliver live updates.** Same shape: the watcher in `src/server/session/file-watcher.ts` runs inside the worker, and `SessionRunner` has no in-process file-watcher path. One-shot `scanFileTree` calls still work, so the file tree renders correctly on initial load and on explicit refresh — it just doesn't auto-update on file changes. **v1 accepts the loss**; a manual refresh button in the inner UI covers the dogfooding loop. Same Phase 1.5 escape hatch as the terminal.
- **Inner UI's preview status panel.** `SessionRunner.buildPreviewStatus()` is a hardcoded stub returning port 5173 (`session-runner.ts:488`). This is only relevant if Phase 2 ships; for v1 the preview panel is hidden anyway.
- **No isolation between inner sessions.** Inner sessions share the inner orch's process and filesystem. If one breaks `node_modules`, others see it.
- **`agent.install` from inner-session repos does not run.** `runInstall` is `instanceof ContainerSessionRunner`-gated. For v1 dogfooding (only the ShipIt repo) this is fine; an inner session opening a *different* repo will not have its install honored. Inner UI surfaces "install skipped (local mode)" rather than pretending.
- **No resource caps on inner sessions.** A runaway agent can exhaust the dev compose service's resources.
- **No reconnect-after-disposal flow** for inner sessions. The `ContainerSessionRunner`-specific reconnect logic doesn't apply.

The dogfooding loop survives all of these because the **outer** session container is intact: outer terminal works, outer file watcher works, outer preview panel renders the inner UI. The inner UI is a thinner version of itself — fine for editing-via-chat, less complete than production.

### Unsupported in v1 (Phase 2)
- **Inner-session preview.** No way to preview an app the user is building inside an inner session. The preview panel in the inner UI shows "preview not available in local mode" or is hidden. Design lives in Phase 2 below.

## Phase 2 — inner-session preview (deferred)

Sketch only; not part of v1. Captured here so the design isn't lost and the checklist has somewhere to track it.

The constraint: the inner orch can't create containers, so Compose-based preview is off the table. Two viable shapes:

**(P2-a) Subprocess preview.** A `LocalServiceManager` reads the inner-session repo's `shipit.yaml` (or `docker-compose.yml`), extracts the dev command, and `spawn()`s it as a child of the inner orch with `cwd` set to the worktree and `PORT` set to an ephemeral allocation. `preview-proxy.ts` learns a new target shape: `{ kind: "local", port: number }` in addition to the existing `{ kind: "container", ip, port }`. The proxy already speaks HTTP and WS — only target resolution changes.

**(P2-b) Reuse outer Compose.** The inner orch shells out to the outer orchestrator's Compose stack via the Compose API (or an outer-ShipIt API endpoint we add) to run a sibling preview service. More faithful to production behavior, but introduces a new outer↔inner control-plane API.

(P2-a) is the smaller delta and the one we'd ship first. Picking it here means Phase 2 is mostly: implement `LocalServiceManager`, extend `preview-proxy.ts` to take a local-port target, and wire `RUNTIME_MODE=local` to construct `LocalServiceManager` instead of skipping `ServiceManager`.

Open question for Phase 2: HMR. The existing preview-proxy injects a script that rewrites dev-server WS URLs to the page origin. That logic should work unchanged for a local target — but worth verifying.

## Key files

| File | Change |
|---|---|
| `src/server/orchestrator/app-lifecycle.ts` | (a) `setupContainerManager` adds a `runtimeMode === "local"` early-return *in addition to* the existing `isTestMode` gate (the two flags differ — see hardening note). The throw at `app-lifecycle.ts:101` ("Docker is required") must be guarded behind both. (b) `buildRunnerFactory` adds a `local`-mode branch returning a `SessionRunner` factory. (c) The `agent.install` call at `app-lifecycle.ts:570` is `ContainerSessionRunner`-gated and inert in local mode — fine, but document it. |
| `src/server/orchestrator/app-di.ts` | Add `runtimeMode: "containerized" \| "local"` to `AppDeps` (default from `process.env.RUNTIME_MODE` ?? `"containerized"`). Set the default `agentFactory` to construct `ClaudeAdapter`/`CodexAdapter` when `runtimeMode === "local"` and no factory is injected (today, `agentFactory` defaults to `undefined` because in production agents always live inside a container). Both seams matter: `runner.createAgent` (only exists on `ContainerSessionRunner`) **and** the process-level `agentFactory` fallback. |
| `src/server/orchestrator/session-runner.ts` | None expected — the existing `SessionRunner` already implements `SessionRunnerInterface`. Verify `dispose()` actually kills agent subprocesses (it calls `agent.kill()` per `session-runner.ts:551`; `ClaudeAdapter` → `ClaudeProcess.kill()` does kill the PTY per `claude.ts:163-172`). |
| `src/server/orchestrator/platform-credentials.ts` | None expected — already supports `x-shipit-secrets` with `platform:claude_oauth` and `platform:github_token` sources. (Docstring already names ShipIt-in-ShipIt as the flagship use case.) |
| `src/server/orchestrator/auth.ts`, `github-auth.ts` | Verify both can boot from env-injected credentials (the dev compose service receives them via Compose `env_file:` references generated from `x-shipit-secrets`, which become `process.env.*` for the inner orch). If they can't, add an env-var-first init path. |
| `src/server/shared/fs-constants.ts` | Add `sessions/`, `.inner-shipit/`, and `.shipit/` to `WORKSPACE_SKIP_DIRS`. |
| ShipIt repo's checked-in `.gitignore` | Add `sessions/`, `.inner-shipit/`, and `.shipit/`. There is no auto-`.gitignore` mechanism in `git.autoCommit` — these must be checked-in entries. |
| `src/server/orchestrator/app-di.ts` (state-path split) | Add `stateDir` to `AppDeps`, defaulting to `workspaceDir` (no production migration needed). Route three paths through `stateDir`: the SQLite database (`app-di.ts:159`), `repo-cache/` (`app-lifecycle.ts:901`), `dep-cache/` (`app-lifecycle.ts:914`). `sessionsRoot` stays at `${workspaceDir}/sessions`. |
| `src/server/orchestrator/services/*` or wherever `compose_not_configured` is emitted | Suppress this event when `runtimeMode === "local"` — either at emission site or in the inner UI's handler. |
| `src/server/session/agents/claude-adapter.ts`, `codex-adapter.ts` | None expected. Adapters already work in-process. |
| `docker-compose.yml` (new, in ShipIt repo root) | The `dev` service shown in "Entry point" — including `volumes: [".:/workspace"]`, `init: true`, `x-shipit-secrets`, and `SHIPIT_STATE_DIR`. |
| `shipit.yaml` (existing, in ShipIt repo root) | Add top-level `compose: docker-compose.yml`. Without this, `setupServiceManager` skips compose and the dev service never starts. |
| `src/server/shipit-docs/*.md` | None — the agent inside the *inner* sessions doesn't need to know about local mode. |
| `CLAUDE.md` | Add a one-paragraph "Dogfooding ShipIt in ShipIt" section pointing here. |

## Tests

- **Unit**: a small test for `buildRunnerFactory` confirming that `RUNTIME_MODE=local` returns a factory that produces `SessionRunner` instances, not `ContainerSessionRunner`.
- **Integration**: most of the existing integration suite already runs in this exact configuration — `SessionRunner` + injected `agentFactory` is how `test-helpers.ts` builds tests. Local mode is essentially "production runs the test wiring." Adding one new test that boots the app with `RUNTIME_MODE=local` and verifies a session can be created and a turn run end-to-end gives us coverage.
- **Manual smoke**: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the inner agent responds and edits a file. Done when this works without errors.

## Hardening notes

Specific failure modes and constraints the implementer must address before declaring v1 done. These are the spots where the design is most likely to bite if treated casually.

### `isTestMode` ≠ `runtimeMode === "local"`

Both flags route around container construction, but they mean different things and must not be conflated.

| | `isTestMode` | `runtimeMode === "local"` |
|---|---|---|
| Skips Docker / containers | Yes | Yes |
| Uses real agent CLI subprocesses | No (test fakes) | **Yes** |
| Uses real git operations | Sometimes (test temp dirs) | **Yes** |
| Uses real GitHub auth and API | No (stubs) | **Yes** |
| Persists state to disk | No (in-memory) | **Yes** |
| Long-running processes expected | No (test process exits) | **Yes** |

Practical rule: `isTestMode` means "this is a test harness; many real subsystems are mocked." `runtimeMode === "local"` means "this is production behavior minus the container layer." A new contributor will reach for whichever flag is nearest; we need a comment at the top of `app-lifecycle.ts` and in `app-di.ts` spelling out the distinction, and we should not add new code that checks `isTestMode || runtimeMode === "local"` as a single condition unless we genuinely mean both.

### Subprocess reaping

In `containerized` mode, when a session container is destroyed, the kernel reaps every Claude CLI subprocess inside it — the container is the reaper of last resort. In `local` mode, there is no such reaper: the inner orch's process is the parent of every agent subprocess, and if `SessionRunner.dispose()` or `ClaudeAdapter.kill()` is incomplete, orphans accumulate inside the dev compose service container until it is recreated.

Required verifications:

- `ClaudeAdapter.kill()` actually terminates the underlying `node-pty` PTY (not just detaches event listeners).
- `SessionRunner.dispose()` calls `agent.kill()` on the active agent (if any) and waits for exit before returning.
- A `SIGTERM` to the inner orch process kills its agent children (or at least leaves them reapable by `init` — which means the dev compose service container needs `init: true` in compose, or a tini wrapper).

Required smoke test in the checklist: create 5 inner sessions, run a turn in each, dispose each, then `ps -ef` inside the dev compose service container and confirm no leftover `claude` processes. Repeat after restarting the inner orch.

### File-watcher scoping and the gitlink pollution risk

In production, the agent's file watcher and the orchestrator's filesystem view live in the same container and watch the same `/workspace`. In local mode, the *outer* agent (which is editing the ShipIt source) and the *inner* orch (running the dev compose service) both have a view of the same `/workspace`, because the dev compose service mounts the outer session's workspace volume. Any inner session creates a **clone** under `/workspace/sessions/{inner-id}/`, which is *inside* the outer agent's watch scope.

Three consequences, all of which need explicit Phase 1 mitigation:

1. **Outer file watcher floods on inner-agent edits.** `WORKSPACE_SKIP_DIRS` in `src/server/shared/fs-constants.ts` does not include `sessions/`, so a busy inner-agent editing turn fires hundreds of fs events per second to the outer UI. This is not "noise we can tolerate" — at scale it's a UX bug. **Fix:** add `sessions/` to `WORKSPACE_SKIP_DIRS`, or scope the outer file watcher to exclude `sessions/` directly. (Verify this doesn't break any production flow that relies on watching nested session dirs.)

2. **Gitlink pollution.** ShipIt does **not** use git worktrees. `repo-git.ts:9` is explicit: each session gets its own complete `.git/` directory via hardlinked local clones. Each inner-session clone therefore has a real `.git/` directory inside the outer's worktree. Git's "embedded repository" detection means `outer git add -A` (or any auto-commit's `git add`) treats `sessions/{inner-id}/workspace` as a **gitlink** (mode 160000) — it gets committed to the outer's branch as a submodule pointer, polluting the outer's history with whatever HEAD the inner clones happen to be on. **Fix:** add `sessions/` to a `.gitignore` that ShipIt manages on the outer repo (or to whatever generated-ignore mechanism `GitManager` uses), and verify that auto-commit on the outer session never picks up inner clones. This is Phase 1, not "verify empirically."

3. **No recursive watch loop.** Outer's watcher only reports; it doesn't write. Inner's writes don't trigger outer's writes. So there's no feedback cycle, just noise (mitigated by #1).

### Credential injection — `x-shipit-secrets` plus secrets-dir handling

A previous draft of this plan proposed a new `x-shipit-orchestrator: true` marker. **This was wrong** — `platform-credentials.ts` already supports this exact use case (its docstring names ShipIt-in-ShipIt as the flagship). However, the *mechanism* is more subtle than "env vars in compose":

`secret-resolver.ts` resolves `x-shipit-secrets` by writing per-service `.env` files (e.g. `.shipit/.env.dev`) and emitting `env_file:` references in the generated compose override. By default, those files land **inside the workspace volume**, at `${workspaceDir}/.shipit/.env.<service>`. There is also a hardened path that writes to a separate isolated directory, gated on the `SHIPIT_SECRETS_INTERNAL_DIR` env var on the outer orchestrator (`secret-resolver.ts:writeIsolatedSecretFiles`, called from `index.ts:196`).

For ShipIt-in-ShipIt this matters because `${workspaceDir}` for the dev compose service is `/workspace`, which is *the ShipIt repo's source tree*. Without mitigation:
- `/workspace/.shipit/.env.dev` contains the user's Claude OAuth + GitHub tokens.
- The outer agent can `ls` and `cat` it.
- `git add -A` in the outer ShipIt repo would pick it up.
- Outer's file watcher fires on every secret refresh.

**Required Phase 1 actions.**

1. **Add `.shipit/` to the ShipIt repo's checked-in `.gitignore`.** This is the only mechanism that actually works (see "Outer auto-commit gitignore mechanism" below). Without this, secrets land in commits.
2. **Add `.shipit/` to `WORKSPACE_SKIP_DIRS` in `fs-constants.ts`** so the outer file watcher doesn't fire on secret writes/refreshes.
3. **Strongly recommended: ensure the outer orchestrator runs with `SHIPIT_SECRETS_INTERNAL_DIR` set.** This routes the secret env files to an isolated directory outside the workspace volume entirely. For dogfooding, the production binary (the *outer* one) should set this in its own deployment config. If we don't control the outer's env, document the limitation: secrets land in the workspace volume but are gitignored and watcher-skipped.
4. **Auth path inside the inner orch.** `AuthManager` and `GitHubAuthManager` must read credentials from env vars (the inner orch's `process.env.ANTHROPIC_API_KEY`, `process.env.GITHUB_TOKEN`, etc. — populated by Compose's `env_file:`). Verify this works today; if not, add an env-var-first init.
- **Trust model.** Same as production: services that declare `x-shipit-secrets` get the secrets they ask for. The user owns their `docker-compose.yml`; if they declare these secrets, they've consented to the service receiving them.

### Outer auto-commit gitignore mechanism (or lack thereof)

A previous draft assumed there was an "auto-`.gitignore` mechanism" in `src/server/shared/git.ts` that the implementer could extend. **There isn't one.** `git.autoCommit` runs `git add -A` with no exclusion logic; the only thing that excludes paths is whatever `.gitignore` is checked into the repo.

The fix is therefore mechanical and lives entirely in the ShipIt repo, not in the orchestrator code: add to the ShipIt repo's `.gitignore`:

```
sessions/
.inner-shipit/
.shipit/
```

This protects the outer ShipIt repo specifically. Users who later want to use ShipIt-in-ShipIt with their own repos must add the same lines to their own `.gitignore` — or the platform must auto-inject these patterns somewhere upstream (e.g. by making the inner orch refuse to start if the entries are missing). For v1 we just bake them into the ShipIt repo and document the requirement for other repos.

### Workspace path collision (substantive but narrower than first thought)

Inside the dev compose service, the inner orch's `WORKSPACE_DIR` defaults to `/workspace` (`app-di.ts:138`). The outer agent's view of `/workspace` is the same directory (because the dev service volume-mounts it from the outer session). This means the inner orch's metadata files would land *in the same directory* as the outer agent's source files.

A previous draft listed many managers needing changes. After tracing the actual disk paths in `app-di.ts` and `app-lifecycle.ts`, the real list is **three**:

1. **The SQLite database.** `app-di.ts:159` opens `${workspaceDir}/.shipit.db`. Almost all "managers" that an earlier draft listed (chat history, usage, secrets, file review, scratchpad) actually live inside this single database, so moving the DB moves them all.
2. **`repo-cache/`** — `app-lifecycle.ts:901`.
3. **`dep-cache/`** — `app-lifecycle.ts:914`.

What does **not** move:

- **`sessionsRoot`** (`${workspaceDir}/sessions`). Inner-session clones must live under the user's view of the workspace — that's how the user sees and edits inner-session files via the outer agent. Moving this would defeat the dogfooding goal. Keep it where it is.
- **`GitHubAuthManager`'s `cwd`** at `app-di.ts:208` — that's used for `configureGitCredentials`, which writes git config in the *workspace* directory, which is correct.

**Fix.** Add a `stateDir` parameter to `AppDeps`, defaulting to `workspaceDir` for back-compat (existing production installs are unchanged because no migration is needed when the default matches today's behavior). In local mode, the dev compose service sets `SHIPIT_STATE_DIR=/workspace/.inner-shipit/` and the inner orch routes the database, `repo-cache/`, and `dep-cache/` to that path. Implementation is a three-path edit, not a wide manager refactor.

Add `.inner-shipit/` to outer's `.gitignore` alongside `sessions/` and `.shipit/`.

### `compose_not_configured` event flood and similar inner-UI noise

When `setupServiceManager` runs without a `compose:` field configured (which is the case for *every* inner session since they don't have inner Compose stacks), it emits `compose_not_configured` events. In `test-helpers.ts:51` these are filtered out for tests. In production-local they are not, and the inner UI will receive them on every inner-session creation.

**Fix.** The inner UI's WS message handler should suppress `compose_not_configured` (and any other "you didn't configure compose" noise) when `runtimeMode === "local"`. Alternatively, the inner orch's `setupServiceManager` could short-circuit before emitting these events when `runtimeMode === "local"`. The latter is cleaner because it stops the noise at the source.

### `agent.install` does not run for compose services

`ContainerSessionRunner.runInstall()` is invoked via an `instanceof ContainerSessionRunner` check at `app-lifecycle.ts:570`. This applies to *session containers* — the agent containers that the outer orch creates per session. **It does not apply to Compose services**, which start via Docker Compose with whatever `command:` they declare.

This means: the dev compose service that runs the inner orch does **not** get its dependencies installed by `agent.install` from `shipit.yaml`. If `command: npm run dev` runs against an empty `node_modules/`, it crashes.

**Fix.** Bake the install into the compose service's `command`:

```yaml
command: sh -c "npm install && npm run dev"
```

This is what the entry-point compose snippet now shows. A previous draft assumed `agent.install` would handle it; that was wrong. (For inner sessions opened in the inner orch, `agent.install` from those sessions' repos is also skipped — see "Degraded or unsupported behaviors.")

### Real `ClaudeAdapter` is not test-exercised

A previous draft claimed local mode is "exercised on every test run" because integration tests use `SessionRunner` + injected `agentFactory`. That's true for the *runner*, but the integration tests inject `FakeClaudeProcess`, not `ClaudeAdapter`. The real adapter's PTY lifecycle, NDJSON parsing, CLI error paths, and OS-process supervision are **not** exercised by `npm test`.

This raises the bar on the manual smoke test: the first time we run the dogfooding loop end-to-end is also the first time `ClaudeAdapter` runs in production-shape (long-lived, real stdin/stdout, real subprocess reaping) outside of an agent container. Expect bugs here. The smoke-test checklist item is therefore important enough to repeat: do it deliberately, watch for orphan processes, watch for stuck PTYs.

### `agent.install` does not run for inner sessions

`ContainerSessionRunner.runInstall()` is invoked via an `instanceof ContainerSessionRunner` check at `app-lifecycle.ts:570`. In local mode the runner is a `SessionRunner`, so `agent.install` from any inner-session repo's `shipit.yaml` is **silently skipped on inner-session creation**. The outer orch already runs `agent.install` once when starting the dev compose service (because the dev service is itself a Compose service running in the outer's environment) — that takes care of the ShipIt repo's own install.

This means: in local mode, an inner session opening a *different* repo (not ShipIt itself) won't have its `agent.install` honored. For the v1 dogfooding loop this is fine — you only ever open ShipIt-in-ShipIt — but it should be documented and the inner UI should not pretend the install ran. Inner sessions should either skip the install step in their UI or display "install skipped (local mode)".

## Risks and tradeoffs

- **Mode skew.** Two runtime modes mean two code paths. The tradeoff is small because the seam is narrow (one factory, one DI knob) and the local path is the test path — so it's exercised on every test run.
- **Inner-session features that "work" in production but silently no-op in local mode.** We need clear UI surfacing — a banner in the inner orch saying "running in local mode; container features disabled" — so the developer doesn't think they're testing functionality they aren't. v1 includes this banner.
- **Confusion about what's running where.** The developer is editing files in the *outer session container*'s view of `/workspace`, the inner orch is in the dev compose service's view of the same directory, and inner sessions are worktrees underneath. The mental model is no worse than production (outer orch / session container / worktree) but the visualization in the UI should not pretend an inner session has its own container.
