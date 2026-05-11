# Checklist — ShipIt UI in local mode

## Phase 0 — preconditions (could land as a separate refactor PR before 118 starts)

- [ ] Add a `stateDir` parameter to `AppDeps` in `app-di.ts`. Default `stateDir = workspaceDir` so existing production installs need no migration. Route three paths through `stateDir`: the SQLite database (`app-di.ts:159`, `${workspaceDir}/.shipit.db`), `repo-cache/` (`app-lifecycle.ts:901`), and `dep-cache/` (`app-lifecycle.ts:914`). `sessionsRoot` (`${workspaceDir}/sessions`) does **not** move — inner-session clones must live in the user's view of the workspace.
- [ ] `src/server/shared/fs-constants.ts` — add `sessions/`, `.inner-shipit/`, and `.shipit/` to `WORKSPACE_SKIP_DIRS`. Verify no production flow relied on watching these.
- [ ] ShipIt repo's checked-in `.gitignore` — add `sessions/`, `.inner-shipit/`, and `.shipit/`. There is no auto-`.gitignore` mechanism in `git.autoCommit` (it just runs `git add -A`); these must be real `.gitignore` entries. Without them, the outer's auto-commit will commit inner-session clones as gitlinks and check secret env files into git.

## Phase 1 — get the inner UI working (no inner-session preview)

### Runtime mode plumbing
- [ ] `src/server/orchestrator/app-di.ts` — add `runtimeMode: "containerized" | "local"` to `AppDeps`. Default from `process.env.RUNTIME_MODE`, falling back to `"containerized"`. **Distinct from `isTestMode`** — see hardening note in plan.md.
- [ ] `src/server/orchestrator/app-lifecycle.ts:setupContainerManager` — add a `runtimeMode === "local"` early-return *in addition to* the existing `isTestMode` gate. The throw at `app-lifecycle.ts:101` ("Docker is required") must be guarded behind both. No Docker proxy server, no `cleanupOrphanComposeResources`, no `resolveOwnContainerIp`.
- [ ] `src/server/orchestrator/app-lifecycle.ts:buildRunnerFactory` — add a `local`-mode branch that returns a factory constructing `SessionRunner` (the existing in-process runner, `session-runner.ts:356`) instead of `ContainerSessionRunner`.
- [ ] Default `agentFactory` in local mode: when `deps.agentFactory` is not provided and `runtimeMode === "local"`, construct adapters directly (`new ClaudeAdapter()`, `new CodexAdapter()`) keyed by `agentId`. Both seams matter: (a) `runner.createAgent` (only exists on `ContainerSessionRunner`) and (b) the process-level `agentFactory` fallback at `app-lifecycle.ts:445`.
- [ ] Audit `agentFactory` consumers outside session context (e.g. `generateText` for PR descriptions). In local mode they spawn real `ClaudeAdapter` subprocesses with whatever `cwd` is passed; verify no caller passes the outer workspace as cwd with `permissionMode: "auto"`.
- [ ] Confirm `enforceIdleContainerLimit` (`app-lifecycle.ts:319-368`) is a no-op when `containerManager === null`.

### ShipIt repo entry point
- [ ] Add `docker-compose.yml` at the repo root with the `dev` service shown in the plan's "Entry point" section. Must include: `image: node:22`, `command: sh -c "npm install && npm run dev"` (NOT just `npm run dev` — `agent.install` does not run for compose services), `working_dir: /workspace`, `init: true`, `volumes: [".:/workspace"]`, `environment.RUNTIME_MODE: local`, `environment.PORT: 3000`, `environment.SHIPIT_STATE_DIR: /workspace/.inner-shipit`, `ports: ["3000:3000"]`, `x-shipit-preview: auto`, and `x-shipit-secrets` for `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `GITHUB_TOKEN`.
- [ ] Add `compose: docker-compose.yml` to the existing `shipit.yaml` at the repo root. **Without this, `setupServiceManager` skips Compose entirely (`app-lifecycle.ts:576`) and the dev service never starts.**
- [ ] Verify `compose-generator.ts` volume-rewriting (`compose-generator.ts:377-424`) produces a working mount for `.:/workspace` when the Compose file is run inside an outer session.

### Credential injection — `x-shipit-secrets` plus secrets-dir handling
- [ ] Confirm `x-shipit-secrets` resolves correctly: `secret-resolver.ts:writePerServiceEnvFiles` writes `.shipit/.env.dev` into the workspace volume; `compose-generator.ts` adds `env_file:` to the resolved compose service. Verify with one end-to-end test.
- [ ] **Secrets-leak mitigation.** The default secrets path lands `.shipit/.env.dev` in `${workspaceDir}` — i.e. the ShipIt repo source tree. Phase 0 covers gitignore + `WORKSPACE_SKIP_DIRS`. Additionally:
  - [ ] Document the `SHIPIT_SECRETS_INTERNAL_DIR` outer-orchestrator env var and recommend setting it for any production outer that hosts ShipIt-in-ShipIt sessions. With it set, `writeIsolatedSecretFiles` routes secrets to a dir outside the workspace volume entirely.
  - [ ] If we control the outer's deployment config, set `SHIPIT_SECRETS_INTERNAL_DIR` on it.
- [x] Verify `AuthManager` (`auth.ts`) reads Claude OAuth from env vars (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). Both env vars are now honored by `checkCredentials()`; previously only `ANTHROPIC_API_KEY` was checked, so the inner orch reported unauthenticated when the outer forwarded an OAuth-only token under `ANTHROPIC_AUTH_TOKEN`.
- [x] Verify `GitHubAuthManager` (`github-auth.ts`) reads `GITHUB_TOKEN` from env. `checkCredentials()` now falls back to `process.env.GITHUB_TOKEN` when `CredentialStore` has nothing on disk. Env-sourced tokens are not persisted to disk — env stays the source of truth so outer-orch token rotation is picked up on the next check.

### Inner-UI suppressions and surfacing
- [ ] Bootstrap response includes `runtimeMode`. Client store reads it.
- [ ] "Running in local mode" banner in the inner UI when `runtimeMode === "local"`. Brief, dismissible, enumerates what's disabled (terminal, file-watcher live updates, preview).
- [ ] Hide the preview panel in the inner UI when `runtimeMode === "local"` (Phase 2 will re-enable).
- [ ] Hide or disable the inner UI's terminal panel; render "Terminal not available in local mode — use the outer terminal." (`ws-handlers/terminal-handlers.ts` requires `ContainerSessionRunner` and will return an error otherwise.)
- [ ] File-tree refresh: add a manual refresh button (or rely on existing one) since live watcher updates won't fire. Initial scan via `scanFileTree` still works.
- [ ] Suppress `compose_not_configured` events when `runtimeMode === "local"` — either at the emission site (preferred) or in the inner UI's WS handler. Otherwise every inner-session creation flashes a "compose not configured" message.
- [ ] Hide container-specific affordances in the inner UI: idle-container indicators, container-recovery dialogs, anything that would obviously confuse in local mode.
- [ ] Inner sessions: skip / suppress the `agent.install` step in the UI (or surface "install skipped — local mode") since `runInstall` is `instanceof ContainerSessionRunner`-gated and never runs.

### Hardening (see "Hardening notes" in plan.md)
- [ ] Add a comment block at the top of `app-lifecycle.ts` and in `app-di.ts` spelling out the difference between `isTestMode` and `runtimeMode === "local"`. Do not add code that checks both as a single condition unless both are genuinely required.
- [ ] Verify `ClaudeAdapter.kill()` terminates the underlying `node-pty` PTY (`claude.ts:163-172` — already does, confirm). Same check for `CodexAdapter`.
- [ ] Verify `SessionRunner.dispose()` calls `agent.kill()` and awaits exit (`session-runner.ts:551` — already does, confirm).
- [ ] Subprocess-reaping smoke test: create 5 inner sessions, run a turn in each, dispose each, then run `ps -ef` inside the dev compose service container and confirm no leftover `claude` processes. Repeat after `SIGTERM`-ing the inner orch (`init: true` in compose should reap; verify).
- [ ] Verify outer `git status` does not stage inner-session clones as gitlinks. (Phase 0 `.gitignore` should handle this.)
- [ ] Verify `.shipit/.env.dev` is gitignored and not visible to the outer file watcher.
- [ ] Verify the outer file watcher does not flood the outer UI on inner-agent edits (Phase 0 `WORKSPACE_SKIP_DIRS` should handle this — confirm).
- [ ] Verify inner-orch state files land in `/workspace/.inner-shipit/`, not at the ShipIt repo root.

### Sanity / behavior verification
- [ ] Inner-session creation produces a hardlinked clone under `/workspace/sessions/{id}/` and a `SessionRunner` registered in the registry.
- [ ] Sending a message to an inner session spawns a real `ClaudeAdapter` subprocess (real PTY, real CLI) with cwd at the inner clone. **First time real `ClaudeAdapter` runs in production-shape outside an agent container — watch closely for orphan processes, stuck PTYs, NDJSON parse errors.**
- [ ] Auto-commit, auto-push, PR card, GitHub status all work for inner sessions.
- [ ] Switching between inner sessions works without leaking agent processes.
- [ ] Disposing an inner session cleans up the clone and kills the agent subprocess.
- [ ] Inner orch's WS endpoint (`/ws/sessions/:id`) survives the outer preview-proxy's WS upgrade path. The HMR script injection at `preview-proxy.ts` should not interfere with non-HMR WS connections — verify by opening the inner UI through the outer's preview subdomain and confirming the WS connects.
- [ ] Preview proxy `getContainerIpForPort(3000)` resolves to the dev compose service's IP on the session network. (The `ports: ["3000:3000"]` line is stripped by `compose-generator.ts:464`; the proxy uses internal IP discovery.)

### Tests
- [ ] Unit test: `buildRunnerFactory` returns a `SessionRunner` factory under `runtimeMode: "local"`, a `ContainerSessionRunner` factory under `"containerized"`.
- [ ] Integration test: boot the orchestrator with `runtimeMode: "local"`, create a session, run a turn end-to-end. Assert the local path was used (e.g. by checking `containerManager` is null). **Note: this still uses `FakeClaudeProcess`, not `ClaudeAdapter` — real-adapter behavior is only validated by the manual smoke test.**
- [ ] Manual smoke: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the agent responds and edits a file. Document date and result here.

### Quality gates
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` green.
- [ ] No regressions in `runtimeMode: "containerized"` mode (production path unchanged when env var is absent).

### Docs
- [ ] `CLAUDE.md` — add a short "Dogfooding ShipIt in ShipIt" section pointing to this doc.
- [ ] `plan.md` status → `done` once the smoke test passes.

## Phase 1.5 — optional inner UI enhancements (only if v1 dogfooding loop demands them)

Items intentionally cut from v1 but small enough to add later if the dogfooding pain is high.

- [ ] **Inner UI terminal.** Lift the `ws-handlers/terminal-handlers.ts` `instanceof ContainerSessionRunner` gate. Have `SessionRunner` spawn a `TerminalProcess` (from `src/server/session/terminal.ts`) directly. The `TerminalProcess` class is not container-coupled — it's just node-pty.
- [ ] **Inner UI file-watcher live updates.** Same shape: lift the handler gate, have `SessionRunner` spawn a `FileWatcher` instance (from `src/server/session/file-watcher.ts`) directly.

## Outer-agent install pre-bake (landed)

Wires the dogfood install loop end-to-end: the outer agent container hardlink-seeds `/workspace/node_modules` from a baked image layer, so `agent.install` collapses from 60-180s to ~5-10s.

- [x] `scripts/agent-install.sh` — opportunistic prebake-seed wrapper around `npm install`. Falls through to plain `npm install` when no prebake is present, so it's safe as the default `agent.install` everywhere.
- [x] `shipit.yaml` — `agent.install: bash scripts/agent-install.sh`.
- [x] `docker/Dockerfile.session-worker.dogfood` — new session-worker variant that bakes ShipIt's `node_modules` at `/opt/shipit-prebake/`. Documented build / `SESSION_WORKER_IMAGE` invocation in `plan.md`.
- [x] `.dockerignore` — exclude the new dogfood Dockerfile from build contexts (parity with the other session-worker variants).

## Install state machine hardening (landed alongside the prebake)

The "Installing dependencies..." overlay would sometimes stick forever if the orchestrator's SSE dropped between `install_status: running` and the worker's `install_done`, or if `setupServiceManager` triggered a concurrent `runInstall`. Both paths now have explicit fixes:

- [x] `ContainerSessionRunner.runInstall()` is idempotent — concurrent callers join the existing in-flight promise instead of resetting `_resolveInstallComplete` and orphaning the original resolver.
- [x] `session-worker.ts` retains `_lastInstallResult` per-process and exposes it via `GET /install/status`. The SSE endpoint replays the last `install_done`/`install_error` to late-connecting clients so a re-attached orchestrator never silently misses an install completion.
- [x] On SSE reconnect with an install in flight, `ContainerSessionRunner.resyncInstallStateAfterReconnect()` polls `/install/status` and synthesizes the missed completion event.
- [x] Client routes `install_log` chunks into the install step's `logLines` (in addition to the terminal panel), so the StartupSteps overlay shows progress instead of looking frozen.
- [x] Client drives the `dev_server` startup step from real `service_status` / `preview_status` events and falls back to clearing the overlay 6s after install completes (manual-preview case) so the services panel can take over.

## "Connecting to dev server..." overlay hardening (landed)

The previous fix renamed the spinner from "Starting dev server..." to "Connecting to dev server..." and tightened the poll interval, but the underlying bug — the spinner could stay on screen indefinitely — was unaddressed. Root cause: the poll loop in `PreviewFrame.tsx` did `await fetch(pollUrl)` with no timeout, so a single hung `/api/preview-health` response stranded the loop on the await; the `i < 60` cap never advanced, the post-loop slot-creation never fired, and the spinner stayed up forever.

- [x] Add `AbortSignal.timeout(2000)` to each preview-health fetch so a hung response can't strand the poll on a single `await`.
- [x] Add a wall-clock `deadline = Date.now() + 15_000` check at the top of the for-loop so cumulative slow fetches can't drag the total past ~15s; after that the iframe slot is created unconditionally and the spinner clears.
- [x] Regression test in `PreviewFrame.test.tsx` verifying the fetch is invoked with an `AbortSignal`.

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
