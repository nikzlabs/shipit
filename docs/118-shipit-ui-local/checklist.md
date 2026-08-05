# Checklist — ShipIt UI in local mode

> **Status (2026-05-20, updated).** Server-side plumbing is complete: `stateDir`,
> `runtimeMode`, the `setupContainerManager` local early-return, the
> `buildRunnerFactory` local branch, the local `agentFactory`, env-based auth
> (Claude + GitHub), `compose_not_configured` suppression, the `isTestMode`
> vs `runtimeMode` comment blocks, and the subprocess-kill paths are all in,
> with unit coverage for `buildRunnerFactory` and the idle-limit no-op. The
> repo entry point (`docker-compose.yml`, `Dockerfile.dogfood`, `shipit.yaml`
> `compose:`, `.gitignore`, `WORKSPACE_SKIP_DIRS`) is in place, as is the
> install-state-machine/preview-overlay hardening (see "landed"
> sections).
>
> **Inner-UI surfacing now landed.** `runtimeMode` is threaded into the
> `/api/bootstrap` payload (`BootstrapData.runtimeMode`, defaulting to
> `"containerized"`) and read into `useUiStore.runtimeMode`. The inner UI now:
> renders a dismissible `LocalModeBanner`; hides the Preview and Terminal tab
> buttons and coerces a persisted preview/terminal `rightTab` selection to
> `files`; keeps the existing manual file-tree refresh button (live watcher
> updates don't fire in local mode). The `RuntimeMode` type was moved to
> `shared/types` (re-exported from `app-di`) so the client references it
> without reaching into orchestrator-only modules. A `local-mode.test.ts`
> integration test boots with `runtimeMode: "local"` and runs a turn through
> the in-process `SessionRunner` to auto-commit; `http-bootstrap.test.ts`
> asserts the `"containerized"` default. The `agentFactory`-consumer audit is
> done: all `generateText` callers (`services/github.ts`, `services/reviews.ts`)
> pass a per-session directory resolved via `resolveSessionDir`, never the
> outer orchestrator workspace, so the real adapter's cwd is the inner-session
> clone.
>
> **Remaining for v1:** (1) the optional "install skipped — local mode" inner-UI
> messaging (low priority — preview/StartupSteps overlay is hidden in local
> mode anyway); (2) the compose-volume-rewrite check (empirical, covered by the
> smoke test); (3) the manual smoke test (which also first-exercises the real
> `ClaudeAdapter` and the subprocess-reaping check). Flip `plan.md` to `done`
> after the smoke test passes.

## Phase 0 — preconditions (could land as a separate refactor PR before 118 starts)

- [x] Add a `stateDir` parameter to `AppDeps` in `app-di.ts`. Default `stateDir = workspaceDir` so existing production installs need no migration. Route three paths through `stateDir`: the SQLite database, `repo-cache/`, and `dep-cache/`. `sessionsRoot` (`${workspaceDir}/sessions`) does **not** move — inner-session clones must live in the user's view of the workspace. Done: `stateDir` in `AppDeps` (`app-di.ts:97`), `SHIPIT_STATE_DIR` read at `app-di.ts:212`, DB at `app-di.ts:237`.
- [x] `src/server/shared/fs-constants.ts` — add `sessions/`, `.inner-shipit/`, and `.shipit/` to `WORKSPACE_SKIP_DIRS`. Done (`fs-constants.ts:26-28`).
- [x] ShipIt repo's checked-in `.gitignore` — add `sessions/`, `.inner-shipit/`, and `.shipit/`. There is no auto-`.gitignore` mechanism in `git.autoCommit` (it just runs `git add -A`); these must be real `.gitignore` entries. Done (`.gitignore:18-19` and `.shipit` entry).

## Phase 1 — get the inner UI working (no inner-session preview)

### Runtime mode plumbing
- [x] `src/server/orchestrator/app-di.ts` — add `runtimeMode: "containerized" | "local"` to `AppDeps`. Default from `process.env.RUNTIME_MODE`, falling back to `"containerized"`. **Distinct from `isTestMode`** — see hardening note in plan.md. Done: type at `app-di.ts:39`, `resolveRuntimeMode()` at `app-di.ts:42-45`.
- [x] `src/server/orchestrator/app-lifecycle.ts:setupContainerManager` — add a `runtimeMode === "local"` early-return *in addition to* the existing `isTestMode` gate. The "Docker is required" throw must be guarded behind both. No Docker proxy server, no `cleanupOrphanComposeResources`, no `resolveOwnContainerIp`. Done (`app-lifecycle.ts:108-110`).
- [x] `src/server/orchestrator/app-lifecycle.ts:buildRunnerFactory` — add a `local`-mode branch that returns a factory constructing `SessionRunner` instead of `ContainerSessionRunner`. Done (`app-lifecycle.ts:327-334`).
- [x] Default `agentFactory` in local mode: when `deps.agentFactory` is not provided and `runtimeMode === "local"`, construct adapters directly (`new ClaudeAdapter()`, `new CodexAdapter()`) keyed by `agentId`. Done: `buildLocalAgentFactory()` (`app-di.ts:385-402`), wired at `app-di.ts:223`.
- [x] Audit `agentFactory` consumers outside session context (e.g. `generateText` for PR descriptions). Done: the only `generateText` callers are `services/github.ts` (PR title/body) and `services/reviews.ts` (AI markdown review); all pass a per-session directory resolved via `resolveSessionDir` (`session.workspaceDir`), never the outer orchestrator workspace. In local mode the real `ClaudeAdapter` therefore runs with cwd at the inner-session clone, which is the intended sandbox.
- [x] Confirm `enforceIdleContainerLimit` is a no-op when `containerManager === null`. Done — covered by `integration_tests/container-exit-logging.test.ts:260` ("is a no-op when no containerManager is wired (local mode)").

### ShipIt repo entry point
- [x] Add `docker-compose.yml` at the repo root with the `dev` service. Done. Includes `init: true`, `command: sh -c "npm install && npm run dev"`, `RUNTIME_MODE: local`, `SHIPIT_STATE_DIR: /workspace/.inner-shipit`, `CHOKIDAR_USEPOLLING: "1"`, `x-shipit-secrets` for the three credentials, and `build:`/`image: shipit-dogfood:local` referencing `docker/Dockerfile.dogfood`. **Note:** the service is `x-shipit-preview: manual` (per the plan's heavy-boot rationale), not `auto` as this checklist line originally stated — manual is correct.
- [x] Add `compose: docker-compose.yml` to the existing `shipit.yaml` at the repo root. Done (`shipit.yaml:17`).
- [ ] Verify `compose-generator.ts` volume-rewriting produces a working mount for `.:/workspace` when the Compose file is run inside an outer session. (Empirical — covered by the manual smoke test.)

### Credential injection — `x-shipit-secrets` plus secrets-dir handling
- [ ] Confirm `x-shipit-secrets` resolves correctly: `secret-resolver.ts:writeServiceEnvFilesToRoot` writes `.env.dev` to `<serviceEnvDir>/<sessionId>/` — outside the workspace volume, since SHI-290 deleted the in-workspace `writePerServiceEnvFiles` path — and `compose-generator.ts` adds an absolute `env_file:` to the resolved compose service. Verify with one end-to-end test.
- [x] **Secrets-leak mitigation.** ~~The default secrets path lands `.shipit/.env.dev` in `${workspaceDir}` — i.e. the ShipIt repo source tree.~~ **No longer true since SHI-290**: the default path is `<serviceEnvDir>/<sessionId>/.env.dev`, outside the workspace, and the in-workspace writer is deleted, so there is no leak into the source tree to mitigate. The `SHIPIT_SECRETS_INTERNAL_DIR` note below still applies as the stronger Docker-secrets option:
  - [ ] Document the `SHIPIT_SECRETS_INTERNAL_DIR` outer-orchestrator env var and recommend setting it for any production outer that hosts ShipIt-in-ShipIt sessions. With it set, `writeIsolatedSecretFiles` routes secrets to a dir outside the workspace volume entirely.
  - [ ] If we control the outer's deployment config, set `SHIPIT_SECRETS_INTERNAL_DIR` on it.
- [x] Verify `AuthManager` (`auth.ts`) reads Claude OAuth from env vars (`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`). Both env vars are now honored by `checkCredentials()`; previously only `ANTHROPIC_API_KEY` was checked, so the inner orch reported unauthenticated when the outer forwarded an OAuth-only token under `ANTHROPIC_AUTH_TOKEN`.
- [x] Verify `GitHubAuthManager` (`github-auth.ts`) reads `GITHUB_TOKEN` from env. `checkCredentials()` now falls back to `process.env.GITHUB_TOKEN` when `CredentialStore` has nothing on disk. Env-sourced tokens are not persisted to disk — env stays the source of truth so outer-orch token rotation is picked up on the next check.

### Inner-UI suppressions and surfacing
- [x] Bootstrap response includes `runtimeMode`. Client store reads it. Done: `BootstrapData.runtimeMode` (`services/types.ts`), forwarded by `getBootstrapData` (`services/misc.ts`) and `ApiDeps`/`index.ts`; client `BootstrapResponse.runtimeMode` → `useUiStore.setRuntimeMode` (`session-data.ts`, `ui-store.ts`). `RuntimeMode` now lives in `shared/types` (re-exported from `app-di`) so the client doesn't import orchestrator-only modules.
- [x] "Running in local mode" banner in the inner UI when `runtimeMode === "local"`. Brief, dismissible, enumerates what's disabled (terminal, file-watcher live updates, preview). Done: `components/LocalModeBanner.tsx`, mounted in `AppLayout.tsx` alongside the other banners; dismissal persisted in localStorage.
- [x] Hide the preview panel in the inner UI when `runtimeMode === "local"` (Phase 2 will re-enable). Done: `App.tsx` hides the Preview tab button and keeps the always-rendered `PreviewFrame` `invisible` in local mode; a persisted `rightTab === "preview"` coerces to `files`.
- [x] Hide or disable the inner UI's terminal panel. Done: `App.tsx` hides the Terminal tab button and coerces a persisted `rightTab === "terminal"` to `files` (so the panel never renders). The banner tells the user to use the outer terminal.
- [x] File-tree refresh: relies on the existing `FileTree` refresh button (`App.tsx` `onRefresh`) since live watcher updates won't fire in local mode.
- [x] Suppress `compose_not_configured` events when `runtimeMode === "local"` — either at the emission site (preferred) or in the inner UI's WS handler. Done at the emission site: `runner-registry-factory.ts:167-172` skips `setupServiceManager`/the event when `runtimeMode === "local"`.
- [x] Hide container-specific affordances in the inner UI. The Docker memory badge / pressure banner are driven by `dockerMemory` (only populated when a `containerManager` + Docker stats poller exist — both absent in local mode), and container-recovery dialogs are driven by container SSE events that never fire in local mode, so these affordances are naturally inert. The explicit hiding above (preview/terminal) covers the panels a user would otherwise click into.
- [ ] Inner sessions: surface "install skipped — local mode" (or skip the step) since `runInstall` is `instanceof ContainerSessionRunner`-gated and never runs. **Deferred (low priority)** — the install/StartupSteps overlay is part of the preview panel, which is hidden in local mode, so there's no visible "install" affordance to correct yet.

### Hardening (see "Hardening notes" in plan.md)
- [x] Add a comment block at the top of `app-lifecycle.ts` and in `app-di.ts` spelling out the difference between `isTestMode` and `runtimeMode === "local"`. Done (`app-di.ts:22-37`, `app-lifecycle.ts:201-204`).
- [x] Verify `ClaudeAdapter.kill()` terminates the underlying `node-pty` PTY. Confirmed: `ClaudeAdapter.kill()` (`claude-adapter.ts:216`) → `ClaudeProcess.kill()` kills the PTY. `CodexAdapter.kill()` (`codex-adapter.ts:337`) sends `SIGTERM` to the process and rejects pending requests.
- [x] Verify `SessionRunner.dispose()` calls `agent.kill()` and awaits exit. Confirmed: `session-runner.ts:560` `dispose()` calls `this.agent.kill()` and `this._terminal.kill()`.
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
- [x] Unit test: `buildRunnerFactory` returns a `SessionRunner` factory under `runtimeMode: "local"`, a `ContainerSessionRunner` factory under `"containerized"`. Done (`app-lifecycle.test.ts:434-524`, incl. "local mode wins over a non-null containerManager").
- [x] Integration test: boot the orchestrator with `runtimeMode: "local"`, create a session, run a turn end-to-end. Done: `integration_tests/local-mode.test.ts` boots with `runtimeMode: "local"`, asserts `/api/bootstrap` reports `runtimeMode: "local"`, and runs a send_message → init → result → done turn through the in-process `SessionRunner` to a `git_committed`. `http-bootstrap.test.ts` asserts the `"containerized"` default. (Uses `FakeClaudeProcess`, not the real `ClaudeAdapter` — the adapter is first exercised by the manual smoke test below.)
- [ ] Manual smoke: open the ShipIt repo in production ShipIt, confirm the preview panel shows the inner UI, create an inner session, send a chat message, confirm the agent responds and edits a file. Document date and result here. **Not done.**

### Quality gates
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` clean.
- [ ] `npm run test:dev` green.
- [ ] No regressions in `runtimeMode: "containerized"` mode (production path unchanged when env var is absent).

### Docs
- [x] `CLAUDE.md` — add a short "Dogfooding ShipIt in ShipIt" section pointing to this doc. Done.
- [ ] `plan.md` status → `done` once the smoke test passes. Still `in-progress` — pending the inner-UI surfacing work and the manual smoke test.

## Phase 1.5 — optional inner UI enhancements (only if v1 dogfooding loop demands them)

Items intentionally cut from v1 but small enough to add later if the dogfooding pain is high.

- [ ] **Inner UI terminal.** Lift the `ws-handlers/terminal-handlers.ts` `instanceof ContainerSessionRunner` gate. Have `SessionRunner` spawn a `TerminalProcess` (from `src/server/session/terminal.ts`) directly. The `TerminalProcess` class is not container-coupled — it's just node-pty.
- [ ] **Inner UI file-watcher live updates.** Same shape: lift the handler gate, have `SessionRunner` spawn a `FileWatcher` instance (from `src/server/session/file-watcher.ts`) directly.

## Outer-agent install cache (landed)

Legacy dogfood install loop removed: the outer agent container previously hardlink-seeded `/workspace/node_modules` from a baked image layer, but that required a repo-specific wrapper that bypassed the feature-148 fast-install cache. `shipit.yaml` now stays on bare `npm install` so the generic worker-side `node_modules` cache can engage in production.

- [x] Remove `scripts/agent-install.sh` so the wrapper path cannot be re-enabled accidentally.
- [x] `shipit.yaml` — reverted to bare `agent.install: npm install` for the feature-148 fast-install cache.
- [x] Remove `docker/Dockerfile.session-worker.dogfood`; the generic fast-install cache replaces the prebaked ShipIt-specific dependency tree.
- [x] `.dockerignore` — exclude the new dogfood Dockerfile from build contexts (parity with the other session-worker variants).

## Install state machine hardening (landed alongside install caching)

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

## Dogfood could never run a turn (landed)

Three stacked failures, each hiding the next. A turn now completes end-to-end.

- [x] `docker/Dockerfile.dogfood` installs `/etc/shipit/managed-settings.json` and the two hooks it references. `prepareClaudeRunParams` hardcodes `--settings /etc/shipit/managed-settings.json`; a missing settings file is fatal to the Claude CLI, so every turn died on `Error: Settings file not found`. Both session-worker images already installed it; this one never did.
- [x] **SHI-282** — local mode could never authenticate *any* agent. Credential provisioning in `session-agent-env.ts` is gated on `runner instanceof ContainerSessionRunner`, and `buildRunnerFactory` returns a plain `SessionRunner` in local mode, so the gate was always false: no per-session credentials dir was ever created and the CLI spawned against an empty `${agentHome()}`. Keyed on the runner type rather than the agent, so Claude and Codex failed identically.
- [x] `local-agent-credentials.ts` links `${agentHome()}`'s `.claude` / `.claude.json` / `.codex` at the routed account's subtree, on every turn. Symlink not copy — a copy needs the container-gated per-turn token sync to survive refresh-token rotation. **Since reconciled** (see the section below): this now maintains the *fallback* home only; a session turn's own spawn gets `HOME` at its account root from `local-agent-home.ts`.
- [x] Unit tests: link/relink/idempotence, dangling and missing sources, Codex's subtree, the legacy flat root and its docs/150 alias, a real path renamed aside rather than deleted, and `isLocalRuntime()` pinned against `resolveRuntimeMode()` (duplicated to avoid an import cycle) plus asserted false under the suite.
- [x] `AGENT_HOME` moved off `/root`. The linking fix immediately hit `EACCES: permission denied, lstat '/root/.codex'` — the `dev` service is **not** root, because `compose-generator` forces `user: <uid>:<uid>` on any service without an explicit `user:` when `SHIPIT_SESSION_WORKER_UID` is set. Now `${SHIPIT_STATE_DIR}/agent-home`; `plan.md`'s "runs as root" bullet corrected.
- [x] Verified live in the dogfood: `[local-credentials] … linked .claude, .claude.json from account:acct_…`, links present on disk pointing at the account roots, and the `Agent CLI requires authentication` failure gone for the linked-credentials reason.

### Follow-up
- [x] Normalize `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` out of the local agent spawn env when the turn routed to an *account*. **Already done** by `scrubEnvAuthForScopedHome` (`claude/process.ts`), which landed in `67480fd3` four minutes after the commit that recorded this as pending — the two crossed, so it was never actually outstanding. It deletes both vars whenever a scoped home applies, which is exactly "the turn routed to an account". Codex's half is the same commit's `!scopedHome && OPENAI_API_KEY` tightening. **Residual, deliberate:** an *unscoped* spawn is not scrubbed, so `generateText` (PR descriptions, AI reviews — no session, so no route to scope by) would still prefer an env key over a connected account. Auxiliary calls only, never a turn; scoping it by provider would close it and is not done.
- [x] **Local-mode workspace trust** — the CLI dropped `permissions.allow` entries because `CLAUDE_PRE_TRUSTED_DIRS` covers `/workspace` but an inner session lives at `/workspace/sessions/<id>/workspace`. The third container-gated writer local mode was missing, after SHI-282 and SHI-298 — both `POST_PROVISION_CONFIG.claude` and the per-turn `ensureSessionAgentUserConfig` re-assert sit inside `runner instanceof ContainerSessionRunner` branches. **Decision:** local mode is a testing surface running only trusted repositories, so the check is off there; containerized mode is untouched, since a container session can hold an arbitrary user repo and that is exactly what the check exists for.
- [x] Established that the CLI has **no** off switch, by probing the shipped binary (2.1.219) rather than assuming. Ineffective: `CLAUDE_CODE_SANDBOXED=1`, `IS_SANDBOX=1`, `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--add-dir <workspace>`, a trust key on an **ancestor** directory, a `"*"` or glob `projects` key, a top-level `hasTrustDialogAccepted`, and every plausible `--settings` key. The only lever is `projects[<key>].hasTrustDialogAccepted` in the user config, keyed by the **enclosing git root of cwd** (confirmed by running the CLI in `<repo>/sub/deep` and reading the path in its own warning). `CLAUDE_CONFIG_DIR` does relocate the config but takes the whole `~/.claude` tree — credentials, `sessions/`, `projects/` — with it, so it was rejected: it would break the one-physical-credentials-file invariant and fragment CLI memory per session.
- [x] `ensureClaudeWorkspaceTrusted` writes the key into the config the spawn will actually read (`<accountRoot>/.claude.json`, or `agentHome()` for a reserved route — resolved from the turn's `accountId` exactly as `resolveLocalAgentHome` does). Because that file is shared per account *and* is the provisioning source for containerized sessions, growth is bounded by pruning sibling `sessions/<other>/workspace` entries whose directory is gone. The match is narrow (same grandparent, same leaf, absent from disk), so a live directory's real per-project state is never touched and a shallow key like `/workspace` prunes nothing.
- [x] Per-agent dispatch through a runtime table (`LOCAL_WORKSPACE_TRUST`, sibling of `POST_PROVISION_CONFIG`) rather than an `agentId === "claude"` branch. Codex has a comparable `projects.<path>.trust_level` in `config.toml`, but ShipIt spawns it with an explicit `approvalPolicy: "never"` so nothing is silently dropped — no row, no Codex work.
- [x] Tests: trust-key derivation (git root, `.git` file for a linked worktree, non-repo fallback), the write, idempotence, CLI per-project state preserved, pruning and its narrowness, unparseable/unwritable configs. Plus the regression that matters — **containerized is unchanged**: a first-turn provision and an already-pinned re-assert both still produce exactly `/app` + `/workspace` and nothing keys off the host `sessionDir`. Verified non-vacuous by disabling the writer (the three local-mode cases fail, the containerized ones do not).
- [x] Verified end-to-end against the real CLI: reproduced `Ignoring 2 permissions.allow entries … has not been trusted` in a simulated `<dataDir>/sessions/<id>/workspace`, ran the production `ensureClaudeWorkspaceTrusted` against the account-root config, and confirmed the warning is gone and the dead sibling entry was pruned. Not verified through a live inner-orchestrator turn — the `dev` service's inner instance has no interactively connected provider account, so a real turn could not be driven from here.
- [x] Codex turns in local mode no longer reproduce the recorded exit 1 on the current spawn path (Codex CLI 0.146.0). Drove the real binary with subscription file auth and the adapter's exact account-scoped environment — `HOME=<account-root>`, `CODEX_HOME=<account-root>/.codex`, and `OPENAI_API_KEY` absent — and `codex exec` completed a model turn with exit 0. The `HOME`-only and `CODEX_HOME`-only controls also completed with exit 0. A reserved-route control matched the live seam after `clearAgentHomeCredentialLinks()` removes the previous account's `.codex` link: unscoped `HOME`, `CODEX_HOME` unset, no `$HOME/.codex`, and `OPENAI_API_KEY` present. Codex created `$HOME/.codex` itself and reached the API; the probe failed only with the expected 401 because this outer session had no real API key and used a placeholder. By contrast, explicitly setting `CODEX_HOME` to a nonexistent directory does exit 1 (`Error finding codex home`), but neither current local route does that: account routes set it to the existing auth directory, while reserved routes leave it unset. The dogfood service itself booted successfully in `RUNTIME_MODE=local`, but its fresh inner state had no Codex provider account (`authConfigured: false`), so it could not supply an additional UI-driven turn without interactive sign-in. No speculative code change warranted.
- [x] **[SHI-298](https://linear.app/shipit-ai/issue/SHI-298)** — local-mode agents received no MCP configuration *and* no MCP credentials. Two independent gates, either of which alone is fatal: `writeMcpConfig()` has one runtime invocation (`McpConfigController.invokeAgentMcpWriter`, constructed only by `session-worker.ts`), and the agent-env push that its `$secret:` resolution depends on is gated on `runner instanceof ContainerSessionRunner`. Both closed together at the spawn — `applyLocalMcp` (`local-agent-mcp.ts`), bound into `runner.createAgent` beside `resolveLocalAgentHome`, so it covers both backends by construction (each adapter writes its own format). `prepareSessionAgentEnvironment` is untouched; containerized mode is untouched.
- [x] The dogfood image gained the browser itself: `playwright-mcp` was already on PATH but `node:24-slim` has neither Chromium nor its system libraries, so `Dockerfile.dogfood` now carries the same `playwright install-deps` + `install-browser chrome-for-testing` layer as `Dockerfile.session-worker.prod`. Checking this before assuming "config-only" was the right call — the wiring alone would have produced a `playwright` server that connects and fails on first tool call.
- [x] Unit tests where the bug is testable even though the wiring isn't: `local-agent-mcp.test.ts` pins the env payload, the ordering (MCP env live at `writeMcpConfig` *and* at the spawn, restored after — including a pre-existing value restored rather than deleted), `runtimeEnv` applied for the spawn only, `mcpConfigPath` threading, cleanup on `done`, the dropped-server report, and the fault-tolerant path. `app-lifecycle.test.ts` pins the `createAgent` wiring and the no-credential-store fallback.
- [x] **Verified live in the dogfood, both halves** — this bug is invisible to unit tests by construction (it is a code path that never ran), so it was driven through the inner UI on a real Claude turn. *Config half*: the inner agent listed `playwright` among its MCP servers with all 24 `browser_*` tools, navigated to the inner UI and took a screenshot — which also proves the new `Dockerfile.dogfood` browser layer works under the service's runtime uid. The tool result carried a genuine MCP image block (`[{"type":"text",…},{"type":"image","source":{"type":"base64","media_type":"image/png",…}}]`), which is the shape docs/244 could not obtain anywhere else. *Credential half*: a probe MCP server registered through the inner `POST /api/mcp-servers` with `$secret:mcp__probe__TOKEN` in both `args` and `env` launched with the placeholder **resolved to its stored value**, so the MCP env really was live in `process.env` at `writeMcpConfig()` and in the spawn env. The second turn also confirmed the resident-streaming behavior is unchanged: it reused the process and did **not** re-write MCP config (a fresh session was needed to pick the probe server up), matching containerized mode.
- [ ] **The `shipit` MCP bridge stays absent in local mode ([SHI-303](https://linear.app/shipit-ai/issue/SHI-303)).** Every tool on it POSTs to the worker's `/agent-ops/*` — a host local mode does not have — so it is configured as `null` rather than advertised-and-broken (which would also point Claude's `--permission-prompt-tool` at an unreachable broker). So no `present` / `voice_note` / `propose_actions` / `report_shipit_bug` in dogfood turns. **The `gh` shim is no longer part of this (docs/251)** — the shims were assumed to need the same host as the bridge, but `gh` is a pure relay while the bridge's tools are worker-served, so `gh` now works in the dogfood via `orchestrator/local-agent-ops.ts`. SHI-303 keeps the bridge and the `shipit` shim.

## Reconciling the two local-mode credential fixes (landed)

`67480fd3` and `ae58d3b4` merged into `main` four minutes apart, both fixing "local mode ignores the selected account" by different means, and `ae58d3b4`'s docstring argued against the design sitting in the next file over. Neither was revertible — each carried work the other did not. Reconciled without deleting either.

- [x] Established that main was **green** before changing anything: `local-agent-credentials`, `local-agent-home`, `app-lifecycle`, `agent-home`, `claude/process`, `codex/adapter` (235 tests) and `session-agent-env` / `session-credentials` / `provider-account` (214 tests) all pass together. The two mechanisms were redundant, not destructive.
- [x] Verified the "one physical credentials file" invariant that makes coexistence safe: both sides compute the account root with `providerAccountCredentialRoot`, so a scoped spawn's `HOME/.claude` and the fallback home's `.claude` symlink are the same bytes. No copy, nothing to rotate out from under anything. Pinned by a test.
- [x] Verified the per-spawn resolver reaches **every session-scoped spawn path** — `route-registry.ts:999` (WS context) and `runner-registry-factory.ts:386` (`SystemTurnDeps`) both prefer `runner.createAgent` over the process-wide `agentFactory`, and `turn-executor.ts` / `session-runner.ts` go through those. The one spawn that does *not* is `generateText` (`app-di.ts:495`), which has no session.
- [x] Audited the other `agentHome()` readers, correcting the assumption that the auth managers and OAuth refreshers were among them: they pass account roots (or a hardcoded `/root`) directly. `terminal.ts` and `install-controller.ts` do read it, but only the session *worker* constructs them and local mode has no worker. So the fallback home has exactly one local-mode consumer, `generateText` — which is why deleting the linking step would have been wrong.
- [x] Ownership split written down in `plan.md`: `local-agent-home.ts` owns per-turn delivery, `local-agent-credentials.ts` owns the unscoped fallback home. Docstrings on both updated; the "rejected alternative" and "accepted trade-off" paragraphs, which described a world that no longer exists, are gone.
- [x] Closed the reserved-route seam: `clearAgentHomeCredentialLinks()` removes stale account links when the turn routes to a reserved env route, so the home never carries one route's credentials while the turn runs on another (docs/150 req 12 by construction, not by the CLI's env-beats-disk luck). 5 new tests.
- [x] `CLAUDE.md` and `plan.md` corrected: setting `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` no longer breaks every turn (the scrub handles it), but should still be left unset for the narrower `generateText` reason.
- [x] **A dogfood turn does complete** — driven end to end through the inner UI. A Claude turn spawned a subagent via the `Agent` tool, its nested Bash call rendered under "Subagent's work", the final report came back, and usage and cost appeared in the composer. That also closed one of docs/244's two open verification items, and turned up SHI-287 (subagent final reports render as raw block-array JSON — pre-existing, not caused by docs/244).
- [x] **…but not on *this* tree — and deliberately left that way (accepted 2026-08-03).** The dogfood turn that completed ran on `ae58d3b4`, before the reconciliation commit existed, so it exercised the per-spawn resolver and the linking step coexisting *unreconciled*. What was never observed live is specifically `clearAgentHomeCredentialLinks` — a reserved-route turn clearing a prior account turn's links.

  **Not going to be verified live. Do not re-open this as pending work.** The user's call, and the reasoning is worth keeping so nobody re-derives it as a gap:

  - **Local mode only.** `isLocalRuntime()` is the sole gate on the one call site, and only the dogfood `dev` service sets `RUNTIME_MODE`. Containerized sessions deliver credentials by per-session copy and never involve these links at all, so production cannot reach this code.
  - **The worst case is a re-login.** The clear only ever unlinks; `rmSync` on a symlink cannot touch its target, and a non-symlink path is skipped outright as a possible legacy singleton login. If that guard were somehow wrong on a shape the tests don't construct, the outcome is signing back into one account in the dogfood.
  - **Covered where it counts.** 5 unit tests, including that the account's own credentials survive the clear, that a real directory is left alone with its `projects/*.jsonl` intact, and that `isLocalRuntime()` is false under the test suite so a test run can never unlink into a developer's real home.

  A rare, low-consequence, testing-mode-only path whose destructive step is guarded and unit-covered. The cost of standing up an interactive sign-in to watch one log line exceeds what the observation is worth.
- [x] The operational half of the env-var story, confirmed the hard way: with `ANTHROPIC_AUTH_TOKEN` set on the `dev` service, turns failed with `Agent CLI requires authentication` — a symptom identical to SHI-282 and *not* it. Unsetting it in outer Settings → Secrets is what let the first turn through. `scrubEnvAuthForScopedHome` means that is no longer required, but the incident is why the docs still say to leave it unset.
  (Inner sessions having no MCP servers — first recorded here from the missing-browser-tool symptom — is the same gap; consolidated into the SHI-298 entry under **Follow-up** above, now fixed, so there is one record, not two.)

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
