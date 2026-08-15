---
description: Run a ShipIt orchestrator in local (no-Docker) mode inside a session container so developers can dogfood and iterate on the ShipIt source via chat.
issue: planning#61
---

# ShipIt UI in local mode (dogfooding ShipIt inside ShipIt)

Run a working-enough ShipIt orchestrator *inside* a ShipIt session container, without the inner orchestrator trying to create Docker containers of its own. The goal is a development loop: open the ShipIt repo in production ShipIt, get an inner UI you can chat with, edit the codebase, and see the changes live.

This replaces the deleted `docs/089-shipit-in-shipit/` plan, which tried to make nested *real* Docker work by relaxing the Docker proxy. That solved a different problem (production-fidelity nesting). For pure dogfooding, never trying Docker is simpler, smaller, and more aligned with the goal.

> **Related:** `docs/131-dogfood-seed-sessions/plan.md` builds on this — a seed
> script that provisions reproducible repo-backed inner sessions on dev-service
> boot, plus the calls the outer agent uses to drive the inner ShipIt. (It also
> once proposed decoupling the inner orch's GitHub token from the outer user's;
> `docs/184-remove-platform-secret-forwarding` did that first.)

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
    build: { context: ., dockerfile: docker/Dockerfile.dogfood }  # node:24 + agent CLIs
    # No `npm install` — the dev service shares the agent container's
    # /workspace/node_modules (populated by agent.install) and just waits for it.
    command: sh -c "... while [ ! -x node_modules/.bin/vite ]; do sleep 1; done && npm run dev ..."
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
      - .:/workspace        # required — also shares node_modules with the agent
    ports:
      - "3000:3000"
    x-shipit-preview: manual  # heavy boot — user starts on demand
    x-shipit-secrets:       # see "Credential injection" hardening note
      - { name: ANTHROPIC_API_KEY,        source: platform:claude_oauth }
      - { name: ANTHROPIC_AUTH_TOKEN,     source: platform:claude_oauth }
      - { name: GITHUB_TOKEN,             source: platform:github_token }
```

> **Update (post-137): shared node_modules, no in-command install.** The dev
> service originally ran `node:22` with `sh -c "npm install && npm run dev"` and
> a per-service anonymous `node_modules` volume. That split existed to avoid
> (a) corrupting a shared tree via concurrent `npm install` runs and (b) an ABI
> mismatch between the dev service (Node 22) and the agent container (Node 24).
> Both reasons are gone: the dev image is now pinned to the **same node:24
> digest** as the agent container, and the in-command `npm install` is removed,
> so `agent.install` is the sole writer of the now-**shared** /workspace/node_modules.
> The dev service simply waits for `node_modules/.bin/vite` to exist, then boots.
> Note 137's `x-shipit-depends-on-install` gate does **not** auto-apply here —
> it only gates `x-shipit-preview: auto` services; `manual` services start via
> `startService` without consulting the gate — hence the explicit wait guard in
> the command rather than relying on the gate. See the live `docker-compose.yml`
> and `docker/Dockerfile.dogfood` for the exact command and image.

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
- **MCP: the browser and user servers work; the internal `shipit` tools do not** (planning#300, `local-agent-mcp.ts`). Until planning#300 a local turn had **no MCP at all** — not "no browser". Two independent gates, either of which alone is fatal, and both keyed on the same thing every other local-mode gap has been: a container. **Config** — `writeMcpConfig()` (the adapter method that writes Claude's `--mcp-config` JSON and Codex's `config.toml` MCP block) has exactly one runtime invocation, `McpConfigController.invokeAgentMcpWriter` in `session/agent-controller.ts`, and `McpConfigController` is constructed only in `session-worker.ts`. **Credentials** — the merged agent-env push (step 4 of `prepareSessionAgentEnvironment`), which carries the `mcp__*` and `MCP_PLATFORM_*` values that `$secret:` / `$platform:` placeholders resolve against, is gated on `runner instanceof ContainerSessionRunner`. Config with no secrets and secrets with nothing configured are equally useless, so both writes were closed together, at the spawn (`applyLocalMcp`, bound into `runner.createAgent` beside `resolveLocalAgentHome`) — the same shape planning#284 settled on, and for the same reason: every step in `session-agent-env.ts` assumes a worker to POST to, so un-gating it would be wrong.

  What that buys: **Playwright** (the browser) and **user-configured MCP servers** (docs/088), including their secrets. Neither needs anything from ShipIt at run time. The dogfood image gained the browser itself in the same change — `playwright-mcp` was already on PATH, but `node:24-slim` has neither Chromium nor the ~50 shared libs it links against, so `Dockerfile.dogfood` now carries the same `playwright install-deps` + `install-browser chrome-for-testing` layer as `Dockerfile.session-worker.prod`.

  What it does **not** buy, deliberately: the internal `shipit` bridge, hence no `present`, `voice_note`, `propose_actions`, `report_shipit_bug`, `permission_prompt`. Every tool on that bridge is a *transport* — each POSTs to `http://127.0.0.1:$WORKER_PORT/agent-ops/…`, and the worker either serves the request (present, permission, ask) or relays it to the orchestrator with the trusted `SESSION_ID` injected (voice, bug, propose_actions). Local mode has no worker, so nothing listens there. Configuring the bridge anyway would be worse than omitting it: the bridge process would start (it is repo code), advertise its tools, and fail every call with ECONNREFUSED — and `writeMcpConfig()` would point Claude's `--permission-prompt-tool` at an unreachable broker. Giving local mode these tools means giving it an `/agent-ops` host. Tracked separately (planning#305).

  **Update (docs/251): the `gh` half of that is done.** The shims were assumed to need the same host as the bridge, but they do not: every endpoint `gh` uses is a pure relay to `/api/sessions/:id/…`, whereas `present` / `permission_prompt` / `ask` are served by the worker itself. `orchestrator/local-agent-ops.ts` now starts a session-bound loopback host per local session and `Dockerfile.dogfood` installs the `gh` shim, so dogfood turns can open PRs and read CI. The `shipit` shim and the MCP bridge are still absent — planning#305 now covers only the worker-served tools.
- **No isolation between inner sessions.** Inner sessions share the inner orch's process and filesystem. If one breaks `node_modules`, others see it.
- **`agent.install` from inner-session repos does not run.** `runInstall` is `instanceof ContainerSessionRunner`-gated. For v1 dogfooding (only the ShipIt repo) this is fine; an inner session opening a *different* repo will not have its install honored. Inner UI surfaces "install skipped (local mode)" rather than pretending.
- **No resource caps on inner sessions.** A runaway agent can exhaust the dev compose service's resources.
- **No reconnect-after-disposal flow** for inner sessions. The `ContainerSessionRunner`-specific reconnect logic doesn't apply.
- **The anti-framing headers are deliberately NOT sent** (planning#379, `frame-guard.ts`). Every other deployment answers with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` so a hostile page can't overlay the UI and steal a click. Local mode exists *to be framed* — the outer instance renders it in the preview pane at `{sessionId}--{port}.<outer host>`, a different origin from the outer UI, so `'self'` wouldn't cover it either. The exemption is scoped to this mode because a local-mode instance is reached only through the developer's own outer instance and holds dogfood state; running it as a real deployment is the non-goal above. Note this is currently invisible in the dogfood loop: the inner shell is served by **Vite**, not by `serveStaticClient`, so the inner orchestrator never sees the framed document request. It becomes load-bearing the moment an inner instance serves its own production build.
- **The `dev` service is NOT root, despite what this bullet used to say — `AGENT_HOME` must be writable by uid 1000.** Session-worker *containers* drop to the unprivileged `shipit` user (UID 1000, home `/home/shipit`) via a `gosu` entrypoint. Local mode has no such container, and the original design read that as "the inner orchestrator runs as **root** in the `dev` service", pinning `AGENT_HOME=/root` in both `Dockerfile.dogfood` and the compose service on that basis. **That premise is false on any deployment with `SHIPIT_SESSION_WORKER_UID` set**: `compose-generator` forces `user: <uid>:<uid>` onto every service that doesn't declare its own `user:`, and `dev` doesn't. So the inner orch runs as uid 1000 with `HOME=/root`, and the first thing to actually *write* under that home failed with `EACCES: permission denied, lstat '/root/.codex'` (planning#284, found the moment credential linking started running at all). `AGENT_HOME` now points at `${SHIPIT_STATE_DIR}/agent-home` — bind-mounted, same uid, already gitignored, survives a restart. The image ENV keeps `/root` as a fallback only, since it cannot know the mount path. Still **do not** create a `shipit` user in `Dockerfile.dogfood` or set `SHIPIT_SESSION_WORKER_UID` on the *inner* orch; the orchestrator-side chown helpers (docs/150 §7) are no-ops without it, which is correct for local mode. The shared `node_modules` mount caveat is covered in docs/150 §9.
- **Credentials reach the local CLI through a spawn-time `HOME`, not through provisioning** (`local-agent-home.ts`, planning#284 + docs/150 req 19). An earlier version of the bullet above said `/root` is "where the dogfood image actually wrote them" — true only of the pre-docs/150 singleton login, which ran `claude /login` with a hardcoded `HOME=/root`. Once accounts existed the login wrote to `<credentialsDir>/provider-accounts/<provider>/<id>/` instead, and nothing put anything in `/root` again. Containerized mode bridges that gap by *provisioning* the routed account's subtree into `<credentialsDir>/sessions/<id>/` and mounting it — but every branch of that, in `session-agent-env.ts`, is gated on `runner instanceof ContainerSessionRunner`, and `buildRunnerFactory` returns a plain `SessionRunner` in local mode. So the gate was **always false here**: provisioning never ran, no per-session dir was ever created, and every dogfood turn spawned a CLI against an empty home and reported itself signed out. Because the gate keys on the *runner type* rather than the agent, Claude and Codex failed identically — the symmetry is what identified it.

  The first local-mode replacement pointed `${agentHome()}/.claude`, `.claude.json` and `.codex` at the routed account's subtree, mirroring what the session-worker *image* does with its `/credentials` mount rather than what the orchestrator does. **A second fix for the same defect landed four minutes later** (`local-agent-home.ts`, docs/150 req 19) and took the design the first had explicitly rejected as too large: threading a per-session HOME into the Claude and Codex adapters. Both were green in isolation and neither could be reverted — the first also carried the `managed-settings.json` install and the `AGENT_HOME` move, the second carried the env scrub and Codex's `CODEX_HOME` agreement. They were reconciled rather than one being deleted; what follows is the mechanism as it stands.

  **A session turn's credentials come from the per-spawn HOME, not from a link.** `resolveLocalAgentHome` reads the session's own pinned route at spawn time and the adapter spawns with `HOME` at `provider-accounts/<provider>/<accountId>` directly. That reaches every session-scoped spawn path, because they all resolve an agent through `runner.createAgent` (`route-registry.ts`'s WS context and `runner-registry-factory.ts`'s `SystemTurnDeps` both prefer it over the process-wide `agentFactory`) — verified at those two call sites, not assumed. This is strictly better than the shared home: per-session correct, no last-turn-wins race between two sessions on different accounts, and it carries the env scrub that makes selection actually stick.

  **`local-agent-credentials.ts` was demoted to maintaining the *fallback* home** — the process-global `agentHome()` that a spawn with no session route still lands on. In local mode that is `generateText` (`app-di.ts`, backing PR-description and AI-review generation), which takes the bare `agentFactory` with no resolver, plus the cases `resolveLocalAgentHome` deliberately answers `undefined` for. It is *not* on the per-turn credential path, which is why "delete the duplicate file" would have been the wrong reconciliation. Nothing else reads `agentHome()` in local mode: `terminal.ts` and `install-controller.ts` are constructed only by the session *worker*, which local mode has none of, and the auth managers and OAuth refreshers pass account roots directly.

  Linking rather than copying stays load-bearing, and is what makes the two safe to run together. The OAuth refresh token is single-use and rotating, so a copy would also need the per-turn `syncAgentTokenIn`/`syncAgentTokenBack` pair — which is container-gated too. And local mode runs **no orchestrator-side refresher** (`claude-oauth-refresh` and `codex-oauth-refresh` both log `skipping start: runtimeMode != containerized`), so the CLI is the only thing refreshing anything: given a copy it would rotate the copy and permanently kill the account root's refresh token, leaving the inner orchestrator's own auth status wrong. Both sides compute the path with `providerAccountCredentialRoot`, so a scoped spawn's `HOME/.claude` and the fallback home's `.claude` symlink resolve to the same bytes — **exactly one physical credentials file per account**, which the CLI both reads and refreshes in place. There is nothing to go stale. A pre-existing *real* path at a destination is renamed aside, never deleted — it would be a legacy singleton login whose conversation jsonl we cannot recreate.

  **The reserved-route seam, closed.** `resolveLocalAgentHome` returns `undefined` for a reserved env route (`ANTHROPIC_AUTH_TOKEN` → `claude-env-oauth`, `ANTHROPIC_API_KEY` → `claude-api-key`, `OPENAI_API_KEY` → `codex-api-key`), so `scrubEnvAuthForScopedHome` correctly does not run — the env credential *is* that route's auth. But the link step used to run anyway with no account id, find no source at the flat credentials root, and leave an earlier account-routed turn's link in place. The home then held one route's subscription credentials while the turn ran on another, and only the CLI's env-beats-disk preference kept the billing right. A reserved route now *clears* those links instead (`clearAgentHomeCredentialLinks`), so docs/150 req 12 holds by construction rather than by coincidence, and the fallback home reflects exactly one route: the most recent local turn's. Only symlinks are removed; a real path is left alone, same stance as the link path's rename-aside.

  **`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` on the `dev` service: no longer fatal, still leave them unset.** The earlier guidance here said setting them breaks every turn (`⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login`) — that was true when written and is not true now: `scrubEnvAuthForScopedHome` deletes both from any account-routed spawn, which is the common case. The reason to leave them unset is smaller and different. They are a metered fallback ranked *below* connected accounts, so they buy nothing while an account is signed in; and an **unscoped** spawn is not scrubbed, so `generateText` would bill against the key while every real turn ran on the subscription. Scoping `generateText` the same way (it has a provider, just no session) would close that too and is not done — it is the last residual, and it is auxiliary calls only, never a turn.

  Consequence, accepted: **the fallback home is shared across local sessions**, so two of them pinned to different accounts repoint it, last turn wins. This no longer affects turns — each spawns at its own account root — only which account an unscoped `generateText` call bills. Local mode already shares the orchestrator process, its gitconfig and its `/workspace`.

- **Workspace trust is written per inner session, because local mode disables the check and the CLI offers no switch** (docs/118 follow-up, `agents/claude/user-config.ts` → `ensureClaudeWorkspaceTrusted`). The Claude CLI silently drops a workspace's own `.claude/settings.json` `permissions.allow` entries until that workspace is trusted (`Ignoring N permissions.allow entries … this workspace has not been trusted`), so the agent got approval prompts for tools that were explicitly allowlisted. The third container-gated writer this mode was missing, after planning#284 and planning#300: both `POST_PROVISION_CONFIG.claude` and the per-turn re-assert `ensureSessionAgentUserConfig` sit inside `runner instanceof ContainerSessionRunner` branches, so nothing wrote session-scoped trust here at all.

  **The decision: local mode is a testing surface running only trusted repositories, so there is nothing there for the check to protect against — turn it off.** Containerized mode is untouched, and deliberately so: a container session can hold an arbitrary user repository, which is exactly the case the check exists for. `CLAUDE_PRE_TRUSTED_DIRS` keeps meaning precisely what it means today.

  **There is no off switch, so the per-directory key is the mechanism.** Probed against the shipped CLI (2.1.219) and all ineffective: `CLAUDE_CODE_SANDBOXED=1`, `IS_SANDBOX=1`, `--dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--add-dir <workspace>`, a trust key on an **ancestor** directory, a `"*"` or glob `projects` key, a top-level `hasTrustDialogAccepted`, and every plausible `--settings` key. The only lever is `projects[<key>].hasTrustDialogAccepted` in the user config, and the key is the **enclosing git repository root of the CLI's cwd** — verified by running the CLI in `<repo>/sub/deep` and reading the path in its own warning. A container is covered by the pre-trusted `/workspace` because its cwd *is* `/workspace`; an inner session's workspace is `<dataDir>/sessions/<id>/workspace` and is its own clone, so the ancestor grants it nothing.

  `CLAUDE_CONFIG_DIR` **is** the one knob that relocates the config, and was rejected: it relocates the whole `~/.claude` tree with it (`.credentials.json`, `sessions/`, `projects/`), which would break the one-physical-credentials-file invariant above and fragment the CLI's memory and conversation state per session.

  **So it writes to the shared account config, and bounds it.** In local mode the CLI reads `<accountRoot>/.claude.json`, which is shared by every session on the account *and* is the source containerized sessions are provisioned from — so unbounded per-session accumulation was the thing to avoid. `ensureClaudeWorkspaceTrusted` prunes sibling `<dataDir>/sessions/<other>/workspace` entries whose directory no longer exists, capping the file at the set of live local sessions. The match is deliberately narrow (same grandparent, same leaf name, absent from disk) so a real per-project entry the CLI keeps for a directory that still exists is never touched, and a shallow key like `/workspace` prunes nothing. The writer is also narrower than `applyClaudeUserConfigDefaults`: it writes the one trust key and no onboarding or pre-trusted dirs, so the two paths cannot drift into each other.

  Only Claude needs this. Codex has a comparable `projects.<path>.trust_level` in `config.toml`, but ShipIt spawns it with an explicit `approvalPolicy: "never"`, so nothing is silently dropped there.

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
| `src/server/orchestrator/local-agent-credentials.ts` (planning#284) | Maintains the process-global **fallback** agent home — not the per-turn credential path. `isLocalRuntime()` (reads `RUNTIME_MODE` at call time, like `agentHome()`, so no `SessionAgentEnvDeps` threading and no import cycle back into `app-di`); `linkAgentHomeToCredentials()` points `${agentHome()}`'s `.claude` / `.claude.json` / `.codex` at the routed provider-account subtree (idempotent, repoints on an account change, treats a missing or dangling source as absent, renames a pre-existing real path aside rather than deleting it); `clearAgentHomeCredentialLinks()` removes them for a reserved env route, which has no account subtree. |
| `src/server/orchestrator/local-agent-home.ts` (docs/150 req 19) | **The per-turn mechanism.** `resolveLocalAgentHome()` answers, at spawn time, which account root a local session's CLI should use as `HOME`; `undefined` (reserved route, or a cross-provider sub-agent whose provider has no selectable account) falls back to `agentHome()`. Bound to each local runner's `createAgent` in `app-lifecycle.ts`. |
| `src/server/orchestrator/session-agent-env.ts` | Step 1b: call the above on **every** turn when `isLocalRuntime()`, alongside (not inside) the `ContainerSessionRunner`-gated provisioning. Fail-open like every other step in this module. Step 1c: the workspace-trust write, same gate and same fail-open stance; it resolves the config path from the turn's `accountId` exactly as `resolveLocalAgentHome` does, so the file written is the file the spawn will read. |
| `src/server/orchestrator/agents/claude/user-config.ts` | `claudeTrustKey()` reproduces the CLI's key derivation (enclosing git root of cwd, resolved by walking up for a `.git` entry rather than shelling out to `git rev-parse`, so a `.git` *file* — a linked worktree — counts). `ensureClaudeWorkspaceTrusted()` writes that one key and prunes dead sibling session workspaces to bound the shared account config. Deliberately separate from `applyClaudeUserConfigDefaults()`, which stays the containerized writer and keeps emitting exactly `CLAUDE_PRE_TRUSTED_DIRS`. |
| `src/server/orchestrator/session-agent-credentials.ts` | `LOCAL_WORKSPACE_TRUST` — the per-agent runtime table behind `ensureLocalWorkspaceTrust()`, a sibling of `POST_PROVISION_CONFIG` and a runtime table for the same docs/155 reason. Only Claude has a row. |
| `src/server/orchestrator/local-agent-mcp.ts` (planning#300) | The worker's two pre-spawn MCP writes, performed in-process. `applyLocalMcp()` patches a local adapter's `run()` so the spawn (a) applies the MCP env — `localMcpSpawnEnv()`, which is literally `selectAgentEnvForPush` with no `ServiceManager`, i.e. the payload the container path POSTs to the worker — and (b) calls the adapter's own `writeMcpConfig()` inside that env, threading `mcpConfigPath` into `run()` and `runtimeEnv` into the spawn. Bound to each local runner's `createAgent` in `app-lifecycle.ts`, beside `resolveLocalAgentHome`. `LOCAL_SHIPIT_BRIDGE = null` is the deliberate omission of the internal bridge (planning#305). Fault-tolerant: a failed config write logs and spawns without MCP rather than killing the turn. |
| `docker/Dockerfile.dogfood` (planning#300) | Chromium + its system libraries, mirroring `Dockerfile.session-worker.prod`: `playwright install-deps chromium`, then `playwright-mcp install-browser chrome-for-testing` into a shared `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` (`chmod a+rX`, because the `dev` service is not necessarily root — same planning#284 constraint that moved `AGENT_HOME`). `playwright-mcp` was already on PATH; the browser and its libs were not, so the MCP server had nothing to launch. |
| `docker/Dockerfile.dogfood` | Installs `/etc/shipit/managed-settings.json` + the hooks it references (PR #1915). `prepareClaudeRunParams` hardcodes `--settings /etc/shipit/managed-settings.json` and the CLI treats a missing settings file as fatal, so before this every dogfood turn died with `Error: Settings file not found` — upstream of the credential failure above, and masking it. |

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

4. **inotify instance exhaustion in the dev compose service.** The dev service runs both `tsx watch` (server) and `vite build --watch` (client) concurrently. Both are chokidar-backed. Chokidar's default inotify mode creates one inotify *instance* per watched source file — with the ShipIt source tree (~300+ TS files plus the client graph), that easily blows past `fs.inotify.max_user_instances` (commonly 128 on Linux hosts), crashing the inner orch with `ENOSPC: System limit for number of file watchers reached`. **Fix:** the dev compose service sets `CHOKIDAR_USEPOLLING=1` and `CHOKIDAR_INTERVAL=1000`, switching both watchers to polling. Polling avoids inotify entirely, sidestepping both `max_user_instances` and `max_user_watches`. The 1s interval is acceptable for the dogfooding loop, and polling is also more reliable on Docker bind-mounts where host→container inotify propagation can be lossy. Bumping the kernel limits would also work but requires host-level sysctl, which isn't portable across the platforms ShipIt runs on.

5. **The inner orchestrator must remain a direct service child.** The split dev command backgrounds `npm run dev` and then `exec`s Vite in the foreground. Do not wrap the background command in a parenthesized subshell or a log-prefixing pipeline: either can detach `tsx watch` from the service lifetime while Vite continues serving a UI whose `/api` proxy only returns connection errors. Keeping `npm run dev` as a direct child also leaves its startup errors visible and unbuffered in the service log.

6. **Local mode keeps credentials under its state directory.** The dogfood service runs as the session worker UID and deliberately has no `/credentials` mount. At entry-point startup, local mode therefore passes `<SHIPIT_STATE_DIR>/credentials` to `buildApp()` instead of accepting the containerized `/credentials` default. This gives the secret cipher, credential store, and git config a writable persistent location alongside the inner database; without it, boot fails while trying to create `/credentials/secret-key`, leaving Vite up but every `/api` request returning 502.

### Credential injection — `x-shipit-secrets` plus secrets-dir handling

A previous draft of this plan proposed a new `x-shipit-orchestrator: true` marker. **This was wrong** — `platform-credentials.ts` already supports this exact use case (its docstring names ShipIt-in-ShipIt as the flagship). However, the *mechanism* is more subtle than "env vars in compose":

`secret-resolver.ts` resolves `x-shipit-secrets` by writing per-service `.env` files (e.g. `.env.dev`) and emitting `env_file:` references in the generated compose override.

**The hazard this section was written about is gone (planning#292).** When this plan was drafted, those files landed **inside the workspace volume** at `${workspaceDir}/.shipit/.env.<service>` unless a root was configured — and for ShipIt-in-ShipIt `${workspaceDir}` for the `dev` service is `/workspace`, *the ShipIt repo's source tree*, so `/workspace/.shipit/.env.dev` held the user's Claude OAuth + GitHub tokens where the outer agent could `cat` it, the outer `git add -A` could commit it, and the outer file watcher fired on every refresh. docs/183 moved the default write to `<serviceEnvDir>/<sessionId>/.env.<service>` outside the workspace, and planning#292 deleted the in-workspace writer entirely and made the root required, so there is no configuration in which those files land in the source tree.

The stronger `SHIPIT_SECRETS_INTERNAL_DIR` path (Docker secrets — `secret-resolver.ts:writeIsolatedSecretFiles`) still exists and is still worth setting on the outer, but it is now a hardening step rather than a leak mitigation. The Phase 1 actions below are kept as the historical record of what was required at the time.

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

### Vite `allowedHosts` blocks the preview-proxy host

Vite ≥ 5 enforces a `Host` header allowlist on its dev server (defaulting to localhost / 127.0.0.1 / the bound IP). The dogfood `dev` Compose service is reached through ShipIt's preview proxy, which forwards requests with `Host: <sessionId>--3000.<preview-domain>`. To Vite that is an unknown host, so it answers every request with `403 Blocked request. This host is not allowed.` From the user's side this looks like "the preview never loads" — the inner orch and Vite are both healthy, the page just never gets served.

`vite.config.ts` sets `server.allowedHosts: true` to disable the check. The trust model is fine: the dev server only ever sits behind ShipIt's preview proxy, never directly on the public internet. The setting only affects `vite dev`; production `vite build` is unaffected.

### Vite's dep-optimizer cache cannot live on the overlayfs `node_modules`

Committing a dep-optimizer run is a pair of **directory** renames inside the
cache dir: `deps` → `deps_temp_<hash>`, then the processing dir → `deps`
(`vite/dist/node/chunks/node.js`, `commit()`). In the dogfood, `node_modules` is
an overlayfs mount — the docs/183 overlay dep store, a shared read-only base
plus a per-session upper layer — and overlayfs refuses to rename a directory
that still lives in its lower layer, failing with `EXDEV: cross-device link not
permitted` even though both paths are on the same device. Vite has no fallback
for that rename, so the optimizer died in a loop and the inner dev server served
no client at all.

The trigger is anything that re-runs optimization, most commonly
`Re-optimizing dependencies because lockfile has changed` — so a plain rebase
onto a `main` that touched `package-lock.json` was enough to break the dogfood.
Note the first optimization can succeed (nothing to rename aside), which is why
this presents as "it worked yesterday".

`vite.config.ts` honors `VITE_CACHE_DIR`, and the `dev` service sets it to
`/workspace/.inner-shipit/vite-cache` — the state dir is a plain bind mount on
ext4, already gitignored, and survives a service restart, so both sides of those
renames land on one ordinary filesystem. Vite's default (`node_modules/.vite`)
is unchanged everywhere else.

### All-manual compose stacks must lazy-join the orchestrator network

`ServiceManager.start()` skips `composeUp` entirely when every service in the compose file is `x-shipit-preview: manual` (the dogfood case — only `dev` exists, and it's manual). Compose only materializes the per-session `shipit-session-<id>` network during an `up`, so when `start()` then calls `networkJoinFn`, the network doesn't exist yet and the call silently fails. The user clicks "Start" → `startService()` → `composeUpService()` finally creates the network and attaches the dev container — but historically `networkJoinFn` was never re-invoked, so the **orchestrator** never joined. The preview proxy resolved a correct container IP that the orchestrator had no route to, surfacing as `Preview unreachable on port 3000 — connect ETIMEDOUT 172.x.y.z:3000` in the outer UI. Auto-preview repos worked fine because their `composeUp` at startup creates the network before the join attempt.

Fix lives in `service-manager.ts`: a private `joinSessionNetwork()` helper is now invoked after every successful `composeUpService` (in `startService`, `restartService`, and the install-retry path `runRetryNow`) in addition to the original call from `start()`. `networkJoinFn`'s "already exists" handling at the call site (`app-lifecycle.ts`) makes the helper idempotent. Regression coverage: `service-manager.test.ts` — "joins the orchestrator to the session network when the first manual service starts (all-manual stack)".

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

### Agent CLIs must be baked into the dev image

The dev compose service runs the inner orch in `RUNTIME_MODE=local`, which spawns `claude` / `codex` as **in-process subprocesses** via `ClaudeAdapter` / `CodexAdapter`. The shared `AgentRegistry` detects agents by probing `which <binary>` — so if the CLIs aren't on `PATH`, the inner UI sits on the "Agent Setup" screen with both agents shown as "Not installed" and no session can start.

Production session-worker images install these via an `npm install -g @anthropic-ai/claude-code @openai/codex @playwright/mcp` layer. `Dockerfile.dogfood` carries the **same layer** (placed before the `COPY package.json` so it stays cached across lockfile churn). Without it the dogfood loop is dead on arrival.

**Rebuilds.** `docker-compose.yml` pins `image: shipit-dogfood:local`. `ServiceManager.composeUp` / `composeUpService` run `docker compose up -d --build` — the `--build` flag forces Compose to re-evaluate the `build:` section on every `up`, so a changed `Dockerfile.dogfood` (or anything in its build context) is always rebuilt rather than silently ignored on a host that still has a cached `shipit-dogfood:local`. Docker's layer cache keeps the no-change case cheap (all cache hits). This is a general `ServiceManager` property, not dogfood-specific: any repo with a `build:` section gets the same always-fresh behavior, and repos that only declare `image:` see `--build` as a harmless no-op.

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

## Outer-agent install cache

The outer agent container's `agent.install` (`npm install` on the ShipIt repo) is a 60-180s job — it fetches Playwright + Chromium, builds `better-sqlite3` / `node-pty`, and extracts ~600MB of `node_modules`. That wait shows up as the "Installing dependencies..." overlay in the outer preview panel and dominates session creation latency for dogfooding.

Feature 148 replaces the repo-specific wrapper with the generic worker-side fast-install path: ShipIt's [shipit.yaml](../../shipit.yaml) uses a bare `npm install`, and the session worker can materialize `node_modules` from `/dep-cache/nm-store/<storeKey>` when the lockfile/runtime/install-command key has already been populated. This matters because shell wrappers are intentionally treated as arbitrary side-effectful install commands and bypass the cache.

The old dogfood-only session-worker image and `scripts/agent-install.sh` wrapper have been removed. They added a ShipIt-specific baked dependency tree and created a second install path that bypassed the production cache. The generic cache is now the only supported acceleration path for ShipIt itself.

## A second inner instance for testing onboarding (2026-08-13)

`dev` is a *configured* install and there is no way to un-configure it. Every key supplied in
the outer Settings → Secrets is injected into it; `adoptEnvCredentials` turns each one into a
stored credential at boot (docs/252 req 20); `resolveHarnessOnboarding` then stamps
`harnessOnboardingCompletedAt` on the first read, and nothing ever clears that stamp. So the
onboarding flow — the one experience every new user has and the hardest to keep honest — was
only reachable by destroying the developer's own setup.

`DOGFOOD_SEED_CREDENTIALS=0` is **not** the answer, and this is the trap worth writing down: it
stops the seeder POSTing credentials, and adoption then makes rows out of the same variables
anyway. Turning off the seeder looks like it worked right up until the instance boots
credentialed.

So `docker-compose.yml` declares a second manual service, `onboarding`, differing from `dev` in
exactly two ways:

- **`GITHUB_TOKEN`, and no service credential.** A name in `x-shipit-secrets` is what injects
  the value, so that list *is* the mechanism: every catalogue `storageEnv` absent from it is a
  credential this instance does not hold. GitHub is supplied deliberately — the subject is the
  **services** onboarding, and making the developer re-paste a GitHub token before reaching it
  every time is friction rather than coverage. The block is pinned by exact membership in
  `scripts/seed-inner-credentials.test.ts`, because one service key added here in good faith
  ("it needs a key to be useful") turns the fresh instance into a second configured one, and
  the symptom is an *absence*: the panel under test never appears.
- **Its own `SHIPIT_STATE_DIR`**, `.inner-shipit/onboarding`. Everything an install remembers
  hangs off that path — the SQLite db (`app-di.ts`) and, in local mode, the credential store
  (`resolveAutoStartDeps` → `<stateDir>/credentials`) — so a separate path *is* a separate
  ShipIt. Nested under `.inner-shipit/` to inherit its `.gitignore` entry, and `rm -rf` on it is
  the whole reset.

It takes port 3001, so the configured instance stays up on 3000 rather than being traded for
it. It seeds nothing (`DOGFOOD_SEED=0`), so the repo list starts empty as well; swapping that
for `DOGFOOD_SEED_CREDENTIALS: "0"` leaves a repo waiting while keeping the credential half off
whatever is declared.

Verified: with no secrets at all it opened on *Connect GitHub*; with `GITHUB_TOKEN` supplied it
opens directly on *"Add a service, and the chat starts working"*, both harnesses reading `no
model it can run yet` and the composer disabled — `GitHub credentials found: true`, `Agent auth
status: claude ✗, codex ✗`, its own freshly generated encryption key. `dev` came back up with
both its credentials and its repo untouched.
