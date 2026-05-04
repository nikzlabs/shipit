# Checklist — ShipIt UI in local mode

## Phase 0 — preconditions (could land as a separate refactor PR before 118 starts)

- [ ] Split `workspaceDir` (source) from `stateDir` (metadata) in `app-di.ts`. Trace every manager that opens a path under `workspaceDir` today and parameterize the metadata path: `SessionManager`, `ChatHistoryManager`, `UsageManager`, `RepoStore`, `FileReviewStore`, the dep cache, the SQLite database, scratchpad/buffer, anything else. Default `stateDir = workspaceDir` for back-compat. Local mode overrides via `SHIPIT_STATE_DIR` env var. Without this, the inner orch's state files collide with the ShipIt repo's source tree (see "Workspace path collision" in plan.md).
- [ ] `src/server/shared/fs-constants.ts` — add `sessions/` and `.inner-shipit/` to `WORKSPACE_SKIP_DIRS`. Verify no production flow relied on watching nested session dirs.
- [ ] Outer auto-commit `.gitignore` (whatever generates it in `src/server/shared/git.ts` or similar) — ensure `sessions/` and `.inner-shipit/` are excluded so embedded inner clones never get committed as gitlinks. Phase 1 action item, not "verify empirically."

## Phase 1 — get the inner UI working (no inner-session preview)

### Runtime mode plumbing
- [ ] `src/server/orchestrator/app-di.ts` — add `runtimeMode: "containerized" | "local"` to `AppDeps`. Default from `process.env.RUNTIME_MODE`, falling back to `"containerized"`. **Distinct from `isTestMode`** — see hardening note.
- [ ] `src/server/orchestrator/app-lifecycle.ts:setupContainerManager` — add a `runtimeMode === "local"` early-return in addition to the existing `isTestMode` gate. The throw at `app-lifecycle.ts:101` ("Docker is required") must be guarded behind both flags. No Docker proxy server, no `cleanupOrphanComposeResources`, no `resolveOwnContainerIp`.
- [ ] `src/server/orchestrator/app-lifecycle.ts:buildRunnerFactory` — add a `local`-mode branch that returns a factory constructing `SessionRunner` (the existing in-process runner, `session-runner.ts:356`) instead of `ContainerSessionRunner`.
- [ ] Default `agentFactory` in local mode: when `deps.agentFactory` is not provided and `runtimeMode === "local"`, construct adapters directly (`new ClaudeAdapter()`, `new CodexAdapter()`) keyed by `agentId`. Both seams matter: (a) `runner.createAgent` (only exists on `ContainerSessionRunner`) and (b) the process-level `agentFactory` fallback at `app-lifecycle.ts:445`.
- [ ] Confirm `enforceIdleContainerLimit` (`app-lifecycle.ts:319-368`) is a no-op when `containerManager === null`. The reviewer confirmed it early-returns; double-check.

### ShipIt repo entry point
- [ ] Add `docker-compose.yml` at the repo root with the `dev` service shown in the plan's "Entry point" section. Must include: `image: node:22`, `command: npm run dev`, `working_dir: /workspace`, `init: true`, `volumes: [".:/workspace"]` (without this the container starts with empty `/workspace`), `environment.RUNTIME_MODE: local`, `environment.PORT: 3000`, `environment.SHIPIT_STATE_DIR: /workspace/.inner-shipit`, `ports: ["3000:3000"]`, `x-shipit-preview: auto`, and `x-shipit-secrets` for `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `GITHUB_TOKEN`.
- [ ] Add `compose: docker-compose.yml` to the existing `shipit.yaml` at the repo root. **Without this, `setupServiceManager` skips Compose entirely (`app-lifecycle.ts:576`) and the dev service never starts.**
- [ ] Confirm `agent.install: npm install` in the existing `shipit.yaml` runs before the `dev` service starts (otherwise `npm run dev` fails with missing deps).
- [ ] Verify the `compose-generator.ts` volume-rewriting flow handles `.:/workspace` correctly when the Compose file is being run inside an outer session (the rewrite at `compose-generator.ts:377-424` must produce a volume mount that points at the outer session's workspace volume subpath).

### Credential injection — use `platform-credentials.ts`
- [ ] Verify `AuthManager` (`auth.ts`) can boot from env-injected Claude OAuth credentials. The dev compose service receives them as env vars via `x-shipit-secrets`, not via the `/credentials/` mount that session-worker containers get. If `AuthManager` only reads from disk today, add an env-var-first init path.
- [ ] Same check for `GitHubAuthManager` (`github-auth.ts`) reading `GITHUB_TOKEN` from env.
- [ ] Confirm the existing `x-shipit-secrets` plumbing (`platform-credentials.ts` + `compose-generator.ts`) actually injects the secrets into the resolved compose service's `environment` block. (The docstring says yes; verify with one end-to-end test.)

### UI surfacing
- [ ] Bootstrap response includes `runtimeMode`. Client store reads it.
- [ ] "Running in local mode" banner in the inner UI when `runtimeMode === "local"`. Brief, dismissible, enumerates what's disabled.
- [ ] Hide or disable the preview panel in the inner UI when `runtimeMode === "local"` (Phase 2 will re-enable).
- [ ] Hide container-specific affordances in the inner UI: idle-container indicators, container-recovery dialogs, anything that would obviously confuse in local mode.
- [ ] Inner sessions: skip / suppress the `agent.install` step in the UI (or surface "install skipped — local mode") since `runInstall` is `instanceof ContainerSessionRunner`-gated and never runs.

### Hardening (see "Hardening notes" in plan.md)
- [ ] Add a comment block at the top of `app-lifecycle.ts` and in `app-di.ts` spelling out the difference between `isTestMode` and `runtimeMode === "local"`. Do not add code that checks both as a single condition unless both are genuinely required.
- [ ] Verify `ClaudeAdapter.kill()` terminates the underlying `node-pty` PTY (`claude.ts:163-172` — already does, confirm). Same check for `CodexAdapter`.
- [ ] Verify `SessionRunner.dispose()` calls `agent.kill()` and awaits exit (`session-runner.ts:551` — already does, confirm).
- [ ] Subprocess-reaping smoke test: create 5 inner sessions, run a turn in each, dispose each, then run `ps -ef` inside the dev compose service container and confirm no leftover `claude` processes. Repeat after `SIGTERM`-ing the inner orch (`init: true` in compose should reap; verify).
- [ ] Verify outer `git status` does not stage inner-session clones as gitlinks. If it does, the Phase 0 `.gitignore` change is failing — fix at root.
- [ ] Verify the outer file watcher does not flood the outer UI on inner-agent edits (the Phase 0 `WORKSPACE_SKIP_DIRS` change handles this — confirm by editing files inside an inner session and watching outer's WS traffic).
- [ ] Verify inner-orch state files land in `/workspace/.inner-shipit/`, not at the ShipIt repo root. (If they end up at the root, the Phase 0 state-dir split is incomplete.)

### Sanity / behavior verification
- [ ] Inner-session creation produces a hardlinked clone under `/workspace/sessions/{id}/` and a `SessionRunner` registered in the registry.
- [ ] Sending a message to an inner session spawns a real Claude CLI subprocess (via `ClaudeAdapter`) with cwd at the inner clone.
- [ ] Auto-commit, auto-push, PR card, GitHub status all work for inner sessions.
- [ ] Terminal in the inner UI works (local PTY in the dev compose service container).
- [ ] File watcher reports changes from the inner session clone.
- [ ] Switching between inner sessions works without leaking agent processes.
- [ ] Disposing an inner session cleans up the clone and kills the agent subprocess.
- [ ] Inner orch's WS endpoint (`/ws/sessions/:id`) survives the outer preview-proxy's WS upgrade path. The HMR script injection at `preview-proxy.ts` should not interfere with non-HMR WS connections — verify by opening the inner UI through the outer's preview subdomain and confirming the WS connects.
- [ ] Preview proxy `getContainerIpForPort(3000)` resolves to the dev compose service's IP on the session network. (The `ports: ["3000:3000"]` line is stripped by `compose-generator.ts:464`; the proxy uses internal IP discovery.)

### Tests
- [ ] Unit test: `buildRunnerFactory` returns a `SessionRunner` factory under `runtimeMode: "local"`, a `ContainerSessionRunner` factory under `"containerized"`.
- [ ] Integration test: boot the orchestrator with `runtimeMode: "local"`, create a session, run a turn end-to-end. Assert the local path was used (e.g. by checking `containerManager` is null).
- [ ] Manual smoke: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the agent responds and edits a file. Document date and result here.

### Quality gates
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` green.
- [ ] No regressions in `runtimeMode: "containerized"` mode (production path unchanged when env var is absent).

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
