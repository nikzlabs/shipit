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
| Workspace isolation | One container per session | Git worktree under `sessions/{id}/`, all in the inner orch's process |
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
    environment:
      RUNTIME_MODE: local
      PORT: 3000
    ports:
      - "3000:3000"
    x-shipit-preview: auto
```

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
| `src/server/orchestrator/app-lifecycle.ts` | `setupContainerManager` early-returns in local mode. `buildRunnerFactory` adds a `local`-mode branch returning a `SessionRunner` factory. Sets `agentFactory` to a real-CLI factory (default to `ClaudeAdapter`) when none injected. |
| `src/server/orchestrator/app-di.ts` | Add `runtimeMode: "containerized" \| "local"` to `AppDeps` (default from `process.env.RUNTIME_MODE` ?? `"containerized"`). |
| `src/server/orchestrator/session-runner.ts` | None expected — the existing `SessionRunner` already implements `SessionRunnerInterface`. Verify behaviors (idle, dispose, terminal, file watcher) match what the local-mode flow needs. |
| `src/server/session/agents/claude-adapter.ts`, `codex-adapter.ts` | None expected. Adapters already work in-process. |
| `docker-compose.yml` (new, in ShipIt repo root) | Single `dev` service with `RUNTIME_MODE: local` and `x-shipit-preview: auto`. |
| `src/server/shipit-docs/*.md` | None — the agent inside the *inner* sessions doesn't need to know about local mode. (The user editing ShipIt does, but that's via this plan, not the in-container docs.) |
| `CLAUDE.md` | Add a one-paragraph "Dogfooding ShipIt in ShipIt" section pointing here. |

## Tests

- **Unit**: a small test for `buildRunnerFactory` confirming that `RUNTIME_MODE=local` returns a factory that produces `SessionRunner` instances, not `ContainerSessionRunner`.
- **Integration**: most of the existing integration suite already runs in this exact configuration — `SessionRunner` + injected `agentFactory` is how `test-helpers.ts` builds tests. Local mode is essentially "production runs the test wiring." Adding one new test that boots the app with `RUNTIME_MODE=local` and verifies a session can be created and a turn run end-to-end gives us coverage.
- **Manual smoke**: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the inner agent responds and edits a file. Done when this works without errors.

## Risks and tradeoffs

- **Mode skew.** Two runtime modes mean two code paths. The tradeoff is small because the seam is narrow (one factory, one DI knob) and the local path is the test path — so it's exercised on every test run.
- **Inner-session features that "work" in production but silently no-op in local mode.** We need clear UI surfacing — a banner in the inner orch saying "running in local mode; container features disabled" — so the developer doesn't think they're testing functionality they aren't. v1 includes this banner.
- **Confusion about what's running where.** The developer is editing files in the *outer session container*'s view of `/workspace`, the inner orch is in the dev compose service's view of the same directory, and inner sessions are worktrees underneath. The mental model is no worse than production (outer orch / session container / worktree) but the visualization in the UI should not pretend an inner session has its own container.
