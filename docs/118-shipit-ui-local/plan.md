---
status: planned
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
    command: npm run dev
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
    x-shipit-preview: auto
    x-shipit-secrets:       # see "Credential injection" hardening note
      - { name: ANTHROPIC_API_KEY,        source: platform:claude_oauth }
      - { name: ANTHROPIC_AUTH_TOKEN,     source: platform:claude_oauth }
      - { name: GITHUB_TOKEN,             source: platform:github_token }
```

This must be paired with a top-level `compose: docker-compose.yml` field in the ShipIt repo's `shipit.yaml` — without it, `resolveShipitConfig` returns `compose: undefined` and `setupServiceManager` (`app-lifecycle.ts:576`) skips Compose entirely, so the dev service never starts.

The outer orchestrator picks this up via the standard `x-shipit-preview: auto` flow in `service-manager.ts` and `preview-proxy.ts` — no platform changes needed. The inner orchestrator boots, reads `RUNTIME_MODE`, and configures itself for local mode at startup. There is no auto-detect, no `shipit.yaml` field, no `dev:nested` script — only the env var, set explicitly in the compose file that's checked into the repo.

If `RUNTIME_MODE` is unset (production deploys, regular dev runs outside a session), behavior is unchanged.

## Subsystems in local mode

### Loaded and unchanged
React client, Fastify routes, services layer, WS handlers, SSE event stream, DI, validation, sessions persistence, chat history, usage tracking, file watcher, terminal (local PTY), `GitManager`, `RepoGit`, `RepoStore`, GitHub auth and PR/CI polling, agent registry, `SessionRunner`, `SessionRunnerRegistry`, `ClaudeAdapter` / `CodexAdapter`, post-turn flow (auto-commit, auto-push, PR card).

### Loaded but skipped at boot in local mode
- `setupContainerManager()` returns `{ containerManager: null, dockerProxyServer: null }`.
- `cleanupOrphanComposeResources()` skipped (no Compose).
- `enforceIdleContainerLimit()` becomes a no-op (no containers to enforce against).
- `resolveOwnContainerIp()` not called.

### Not loaded in local mode
- `SessionContainerManager`, `container-lifecycle`, `container-health`, `container-discovery`
- `docker-proxy*` (no proxy server, no sanitize, no auth, no helpers)
- `compose-generator`, `ServiceManager`
- Warm-session pool (or repurposed as warm-worktree pool — out of scope for v1)

### Degraded behaviors in local mode
- **No isolation between inner sessions.** Inner sessions share the inner orch's process and filesystem. If one breaks `node_modules`, others see it.
- **`agent.install` is the inner orch's container's responsibility** (run by the outer orch when starting the dev compose service). Inner-session creation does not run `agent.install` again — there's no fresh container to install into.
- **No resource caps on inner sessions.** A runaway agent inside an inner session can exhaust the dev compose service's resources.
- **No reconnect-after-disposal flow** for inner sessions. The ContainerSessionRunner-specific reconnect logic doesn't apply — `SessionRunner` doesn't dispose on idle in the same way (verified in `session-runner.ts`'s in-process runner used by integration tests).
- **`scanFileTree`, watcher, terminal, and git** all run in the inner orch's container, against the worktree directory. Path semantics are the same as containerized mode — `/workspace/sessions/{id}/...` — because the inner orch's `/workspace` is the outer session's `/workspace`.

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
| `src/server/orchestrator/auth.ts`, `github-auth.ts` | Verify both can boot from env-injected credentials (the dev compose service receives them as env vars, not via `/credentials/` mount). If they can't, add an env-var-first init path. |
| `src/server/shared/fs-constants.ts` | Add `sessions/` and `.inner-shipit/` to `WORKSPACE_SKIP_DIRS`. |
| `src/server/shared/git.ts` (or wherever auto-`.gitignore` is managed) | Ensure outer's auto-commit `.gitignore` excludes `sessions/` and `.inner-shipit/`. |
| `src/server/orchestrator/app-di.ts` (state-path split) | Split `workspaceDir` (source) from `stateDir` (metadata: `.shipit.db`, `.vibe-sessions.json`, repo cache, dep cache, chat history, usage, scratchpad, file-review store). Default `stateDir = workspaceDir` for back-compat; in local mode the dev service overrides it to `/workspace/.inner-shipit/`. This is a precondition for 118 — could land as a separate refactor PR. |
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

### Credential injection — use existing `platform-credentials.ts`

A previous draft of this plan proposed a new `x-shipit-orchestrator: true` marker. **This was wrong** — the codebase already has the primitive we need.

`src/server/orchestrator/platform-credentials.ts` exposes a `PlatformCredentialProvider` system whose docstring states: *"The flagship use case is ShipIt-in-ShipIt: the inner orchestrator service needs the outer session's Claude OAuth + GitHub tokens."* The mechanism is the `x-shipit-secrets` field on a Compose service, with sources like `platform:claude_oauth` and `platform:github_token`. The outer orchestrator resolves these and injects them into the service's environment via the existing compose-generation pipeline. Per-secret naming, controlled scope, no special trust marker — strictly better than what we were going to build.

The dev service's `x-shipit-secrets` block (shown in the entry-point compose snippet above) is the entire integration:

- **Auth path inside the inner orch.** `AuthManager` and `GitHubAuthManager` need to read these env vars at startup. In production, credentials live on disk under `/credentials/`; in local mode, credentials arrive as env vars. Either both managers already handle env-var-first auth (verify), or local mode needs a small init that materializes the env vars into the credential store the managers already read.
- **No credential volume mount.** The `/credentials/` volume from `container-lifecycle.ts:buildMounts()` is not extended to compose services and we should not extend it. Env-var injection via `platform-credentials.ts` is the supported path; reuse it.
- **Trust model.** Same as production: services that declare `x-shipit-secrets` get the secrets they ask for. The user owns their `docker-compose.yml`; if they declare these secrets, they've consented to the service receiving them.

### Workspace path collision (substantive gap)

Inside the dev compose service, the inner orch's `WORKSPACE_DIR` defaults to `/workspace` (`app-di.ts:138`). The outer agent's view of `/workspace` is the same directory (because the dev service volume-mounts it from the outer session). This means the inner orch's `.shipit.db`, `.vibe-sessions.json`, `repo-cache/`, and `dep-cache/` will land *in the same directory* as the outer agent's source files — and the outer ShipIt repo already uses some of those names for its own state.

**Fix.** The inner orch's per-session state must live in a directory that's not part of the ShipIt repo's source tree. Two options:

1. **Separate state dir env var.** Introduce a `SHIPIT_STATE_DIR` (default to `WORKSPACE_DIR`, override it in the dev service compose to `/workspace/.inner-shipit/`). All managers that today open files under `WORKSPACE_DIR` (sessions persistence, chat history, usage, dep cache, repo cache, file-review store, scratchpad) read from `SHIPIT_STATE_DIR` instead. The inner orch's *workspace* (where source files live and inner sessions get cloned) is still `/workspace`, but its *metadata* is at `/workspace/.inner-shipit/`.

2. **Sibling workspace volume.** Mount a second volume (e.g. `inner-shipit-state`) at `/inner-shipit/` and treat that as both the state dir and the parent of inner-session clones. This keeps state cleanly separated but means inner sessions don't share the outer agent's view of the source — i.e. you can't open the same files in the outer and inner UIs at once, which contradicts the dogfooding goal.

Option 1 is the right shape. The compose snippet above already includes `SHIPIT_STATE_DIR=/workspace/.inner-shipit`. Implementation cost: trace every manager that opens a path under `workspaceDir` in `app-di.ts` and split them into "workspace path" (source) vs "state path" (metadata). Specifically: `SessionManager`, `ChatHistoryManager`, `UsageManager`, `RepoStore`, `FileReviewStore`, the dep cache, the database, and any scratchpad/buffer. This split is good hygiene independent of local mode and could land as a refactor before 118 even starts.

Add `.inner-shipit/` to outer's `.gitignore` alongside `sessions/`.

### `agent.install` does not run for inner sessions

`ContainerSessionRunner.runInstall()` is invoked via an `instanceof ContainerSessionRunner` check at `app-lifecycle.ts:570`. In local mode the runner is a `SessionRunner`, so `agent.install` from any inner-session repo's `shipit.yaml` is **silently skipped on inner-session creation**. The outer orch already runs `agent.install` once when starting the dev compose service (because the dev service is itself a Compose service running in the outer's environment) — that takes care of the ShipIt repo's own install.

This means: in local mode, an inner session opening a *different* repo (not ShipIt itself) won't have its `agent.install` honored. For the v1 dogfooding loop this is fine — you only ever open ShipIt-in-ShipIt — but it should be documented and the inner UI should not pretend the install ran. Inner sessions should either skip the install step in their UI or display "install skipped (local mode)".

## Risks and tradeoffs

- **Mode skew.** Two runtime modes mean two code paths. The tradeoff is small because the seam is narrow (one factory, one DI knob) and the local path is the test path — so it's exercised on every test run.
- **Inner-session features that "work" in production but silently no-op in local mode.** We need clear UI surfacing — a banner in the inner orch saying "running in local mode; container features disabled" — so the developer doesn't think they're testing functionality they aren't. v1 includes this banner.
- **Confusion about what's running where.** The developer is editing files in the *outer session container*'s view of `/workspace`, the inner orch is in the dev compose service's view of the same directory, and inner sessions are worktrees underneath. The mental model is no worse than production (outer orch / session container / worktree) but the visualization in the UI should not pretend an inner session has its own container.
