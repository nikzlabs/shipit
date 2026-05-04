# Checklist — ShipIt UI in local mode

## Phase 1 — get the inner UI working (no inner-session preview)

### Runtime mode plumbing
- [ ] `src/server/orchestrator/app-di.ts` — add `runtimeMode: "containerized" | "local"` to `AppDeps`. Default from `process.env.RUNTIME_MODE`, falling back to `"containerized"`.
- [ ] `src/server/orchestrator/app-lifecycle.ts` — `setupContainerManager()` early-returns `{ containerManager: null, dockerProxyServer: null }` when `runtimeMode === "local"`. No Docker proxy server, no `cleanupOrphanComposeResources`, no `resolveOwnContainerIp`.
- [ ] `src/server/orchestrator/app-lifecycle.ts` — `buildRunnerFactory()` adds a `local`-mode branch that returns a factory constructing `SessionRunner` (the existing in-process runner) instead of `ContainerSessionRunner`.
- [ ] Default `agentFactory` in local mode: when `deps.agentFactory` is not provided and `runtimeMode === "local"`, construct adapters directly (`new ClaudeAdapter()`, `new CodexAdapter()`) keyed by `agentId`.
- [ ] Confirm `enforceIdleContainerLimit` / idle-cleanup paths are no-ops when `containerManager === null`. Add a guard or early return if needed.

### ShipIt repo entry point
- [ ] Add `docker-compose.yml` at the repo root with a `dev` service: `image: node:22`, `command: npm run dev`, `working_dir: /workspace`, `environment.RUNTIME_MODE: local`, `environment.PORT: 3000`, `ports: ["3000:3000"]`, `x-shipit-preview: auto`.
- [ ] Confirm `agent.install: npm install` in the existing `shipit.yaml` runs before the `dev` service starts (otherwise `npm run dev` fails with missing deps).
- [ ] Verify the dev service's container has access to the credential dirs needed by the inner orch (Claude OAuth credentials, GitHub token). Mount or inject as needed.

### UI surfacing
- [ ] Add a "running in local mode" banner to the inner orch's UI when the app boots in `local` mode. Bootstrap response should include `runtimeMode` so the client renders the banner.
- [ ] Hide or disable the preview panel in the inner UI when `runtimeMode === "local"` (Phase 2 will re-enable).
- [ ] Hide container-specific affordances in the inner UI: idle-container indicators, container-recovery dialogs, anything that would obviously confuse in local mode.

### Sanity / behavior verification
- [ ] Inner-session creation produces a worktree under `/workspace/sessions/{id}/` and a `SessionRunner` registered in the registry.
- [ ] Sending a message to an inner session spawns a real Claude CLI subprocess (via `ClaudeAdapter`) with cwd at the worktree.
- [ ] Auto-commit, auto-push, PR card, GitHub status all work for inner sessions.
- [ ] Terminal in the inner UI works (local PTY in the dev compose service container).
- [ ] File watcher reports changes from the inner session worktree.
- [ ] Switching between inner sessions works without leaking agent processes.
- [ ] Disposing an inner session cleans up the worktree and kills the agent subprocess.

### Tests
- [ ] Unit test: `buildRunnerFactory` returns a `SessionRunner` factory under `RUNTIME_MODE=local`, a `ContainerSessionRunner` factory under `containerized`.
- [ ] Integration test: boot the orchestrator with `runtimeMode: "local"`, create a session, run a turn end-to-end with a `FakeClaudeProcess`-flavored adapter. (Most of this is the test-helpers wiring already; the new bit is asserting we used the local path.)
- [ ] Manual smoke: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the agent responds and edits a file. Document the smoke test in `docs/118-shipit-ui-local/plan.md` or this checklist with date.

### Quality gates
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` green.
- [ ] No regressions in `RUNTIME_MODE=containerized` mode (production path unchanged when env var is absent).

### Docs
- [ ] `CLAUDE.md` — add a short "Dogfooding ShipIt in ShipIt" section pointing to this doc.
- [ ] `plan.md` status → `done` once the smoke test passes.

## Phase 2 — inner-session preview (deferred design)

Goal: let the user preview an app they're building inside an inner session, despite the inner orch not having Docker.

### Design decisions
- [ ] Confirm Phase 2 shape: `LocalServiceManager` (subprocess preview) vs reuse outer Compose. Plan currently leans **subprocess preview** as the simpler v1 of Phase 2.
- [ ] Decide port allocation strategy (ephemeral per inner session, or fixed range from a pool).
- [ ] Decide how `LocalServiceManager` extracts the dev command — read `shipit.yaml`, parse `docker-compose.yml`, or require an explicit `dev` script in `package.json`.
- [ ] Decide whether multiple concurrent inner-session previews are supported, or only the active session's preview runs.

### Implementation
- [ ] Implement `LocalServiceManager` exposing the same surface `ServiceManager` exposes (start, stop, status, logs).
- [ ] Wire `LocalServiceManager` into the local-mode runner factory; construct it per inner session.
- [ ] Extend `preview-proxy.ts` with a `{ kind: "local", port }` target shape; existing container target shape unchanged.
- [ ] Verify HMR script injection works against a local target (it should — only the upstream URL changes).
- [ ] Re-enable the preview panel in the inner UI when `runtimeMode === "local"` and a preview is available.
- [ ] Surface preview errors in the inner UI (subprocess crashed, port in use, command not found).

### Tests
- [ ] Unit test for `LocalServiceManager` lifecycle (start, stop, restart on config change).
- [ ] Integration test: inner session in local mode with a tiny static-file dev server, assert `preview-proxy` returns 200 for the inner-session subdomain.

### Out-of-scope for Phase 2
- Resource limits on the subprocess.
- Per-service health checks beyond "process is alive."
- Multi-container Compose stacks for inner sessions (would require Phase 2-b, reusing outer Compose).
