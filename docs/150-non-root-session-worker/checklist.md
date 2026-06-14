# Non-root Session Worker Checklist

## Implemented in this PR (SHI-31) — flag-off-by-default

The whole migration is gated on `SHIPIT_SESSION_WORKER_UID`. Unset (default) =
byte-for-byte today's behavior: the entrypoint execs the worker as **root** with
no chown, and the orchestrator's chown helpers are no-ops. Set (e.g. `1000`) =
the entrypoint chowns the mounts + drops to `shipit`, and the orchestrator hands
ownership of its post-boot writes to the same UID. Nothing here changes prod
behavior until the var is set.

- [x] Add a stable `shipit` UID/GID to session worker images (rename upstream `node` → `shipit`, UID/GID 1000).
- [x] Root entrypoint that prepares writable mounts and drops to `shipit` — **gated** on `SHIPIT_SESSION_WORKER_UID` (`docker/session-worker/entrypoint.sh`, `gosu`). Unset → exec as root; no privilege drop, no chown.
- [x] Shared `agentHome()` runtime resolver (`src/server/shared/agent-home.ts`), resolved at call time. Default `/home/shipit`; local mode pins `/root`.
- [x] Replace `/root` assumptions in worker, Claude, Codex, terminal, and the container env builder.
- [x] Move credential symlinks to `/home/shipit`; npm global prefix → `~/.npm-global` (§6); Playwright browsers pinned to `/opt/playwright-browsers` (§8).
- [x] Orchestrator-side ownership handoff gated on `SHIPIT_SESSION_WORKER_UID` (§7): per-session credentials (incl. `provisionRepoMemory` so auto-memory stays writable), container gitconfig, user uploads, CI-fix logs.
- [x] Keep local/dogfood mode on root with `AGENT_HOME=/root` (§9).
- [x] Ops `.docker` image: add `shipit` to `systemd-journal`/`adm` so host journal reads survive.
- [x] Enumerate the writable paths the worker needs (groundwork for SHI-97 ReadonlyRootfs/seccomp) — see `plan.md` "Writable paths".
- [x] Hide the `.shipit-uid-1000` chown sentinel from the file tree/watcher.
- [x] Update `src/server/shipit-docs/environment.md`.
- [x] Startup fail-fast guard on `SHIPIT_SESSION_WORKER_UID` drift (`worker-uid-guard.ts`, wired into `buildApp` for containerized prod). Persists a per-boot marker; refuses to start on a non-root → unset rollback with sessions present, unless `SHIPIT_SESSION_WORKER_UID_ALLOW_DOWNGRADE=1`.
- [x] Unit/integration tests: `agent-home`, `session-worker-uid`, `worker-uid-guard`, `container-lifecycle` env, `session-credentials` §7 chown (creds + memory).
- [x] Run lint, typecheck, and targeted container/worker tests.

## Nothing reverted

Reviewed for parts to back out: none. The earlier asymmetry (image dropped to
`shipit` unconditionally while the orchestrator chowns were gated, which would
break auth if the new image shipped with the var unset) was fixed by gating the
entrypoint's privilege drop on the same var — not by reverting any feature.

## Activation-blocker fix — deploy validation found two gaps (SHI-31)

A real deploy validation with `SHIPIT_SESSION_WORKER_UID=1000` surfaced two
gaps the original §7 reasoning missed. Both are the **gate to flipping the var
in prod**; fixed in this PR, still flag-gated.

- [x] **Root orchestrator git refused on worker-owned worktrees (`detected dubious ownership`).** §7 reasoned only about *write* ownership and never anticipated that root then can't *read/operate* git over a 1000-owned tree. Broke auto-commit, auto-push, branch graduation, the bare-cache fetch, and the `gh pr` branch lookup. Fixed by adding `safe.directory=*` to the orchestrator's **global** git config in `initGlobalGitConfig` — gated on `sessionWorkerUid()`. `safe.directory` is honored only from system/global config (never `-c` / repo-local), and the orchestrator's `GIT_CONFIG_GLOBAL` is root-owned so git-as-root trusts it; one `*` covers the bare cache + every per-session worktree + the `gh`/PR git path (all inherit `GIT_CONFIG_GLOBAL`). Running git as uid 1000 was rejected — it would break on the root-owned bare cache and the root-owned global config.
- [x] **Post-boot orchestrator git/compose writers left files root:root.** Finished the §7 chown wiring for the writers that were missed: `compose-generator.writeComposeOverride` (the override file **and** its `.shipit` dir — this also clears the transient `EACCES /workspace/.shipit/.install-done` during warm-claim, since the dir is now worker-owned), the post-turn auto-commit (`ws-handlers/post-turn.ts` hands `.git` back on every path), `repo-git.cloneFromCache` (post-boot reclone), and the claim / warm-pool / fork-merge / child-session git ops. New helper `chownWorkspaceGitToSessionWorker(workspaceDir)` chowns `<dir>/.git`.
- [x] Tests: `safe.directory` gated write (git-config), `chownWorkspaceGitToSessionWorker` (session-worker-uid), compose-override chown (compose-generator).
- [x] **Rebase driver left `.git` AND the worktree root-owned (SHI-144).** The user-driven rebase + auto-conflict-resolve flow (`services/rebase-driver.ts`) runs its git ops (fetch / rebase / `--continue` / stageAll / forcePush / abort) as the root orchestrator but dispatches resolution turns with `postTurn: "none"`, which elides the `postTurnCommit` handoff every normal turn gets. The root rebase re-roots **both** `.git` (so the non-root agent's in-container `git` fails) **and the worktree files** — including the conflicted files the agent must *edit* to resolve (so the resolution turn EACCESes even with `.git` handed back; caught by a prod-machine agent on the live conflict path before merge). Fixed by `handWorkspaceBackToWorker(runner.sessionDir)`, which hands back `.git` (object-aware `chownWorkspaceGitToSessionWorker`) **and** the worktree (`chownWorktreeToSessionWorker`, new helper — walks the worktree, skips `.git` + the declared `agent.dep-dirs` so it stays bounded by the source tree, not `node_modules`). Called (a) before each resolution turn (so the agent can both run git and edit conflicts), (b) in a `finally` wrapping `runRebaseFlow` (every exit: clean / resolved / up-to-date / abort / throw — also heals pre-existing root-owned worktree files), and (c) on the auto-path stale-rebase pre-flight abort + post-`Promise.race` (timeout-teardown abort). Gated/no-op when the flag is unset. Tests spy both handoffs (incl. asserting the worktree is handed back *before* the agent edits) across up-to-date / clean / conflict / throw; the real uid-1000 EACCES proof is the live dev validation.

## Deferred (separate steps — not in this PR)

- [x] **Validate the built image — container/image side (standalone).** Prod image built; verified on WSL2/Docker: `id -u==1000`/`whoami==shipit` with the flag on, mounts chowned + `.shipit-uid-1000` sentinel, `/app`+`/opt`+shims root-owned but readable/executable by `shipit`, npm global prefix `~/.npm-global` writable (`npm i -g cowsay` resolves there), Playwright chrome under `/opt/playwright-browsers` readable/executable, credential symlinks owned by `shipit`, `HOME`/`AGENT_HOME=/home/shipit`, auto-memory write through `~/.claude` succeeds (owner 1000), `SHIPIT_SKIP_WORKSPACE_CHOWN=1` skips the `/workspace` chown while other mounts still chown, and **flag-off is byte-for-byte legacy** (`id -u==0`, no chown, no sentinel). `gosu` is non-setuid. Guard cases 7/7 green.
- [ ] **Validate the orchestrator-coupled paths (staged deploy with `SHIPIT_SESSION_WORKER_UID=1000`).** **Prod confirmed live 2026-06-14** (build ec3bd92e): all post-flip workers run as `shipit(1000)` (`docker top`), `safe.directory=*` active, marker `1000`, **0 dubious-ownership** this boot, no "Refusing to start", auto-commit + `git push` working on 1000-owned worktrees, `.git/index` `1000:shipit`, live Claude auth + brokered in-container git fetch/push, creds isolated (token file `1000` `0600`, no cross-agent), caches/npm-prefix writable, browser store reachable. (Dev also covered Codex auth + warm-pool preinstall.) One pre-flip session container predating the redeploy stayed root as expected and flips on next restart. **Exercised on dev (flag on) 2026-06-14:** `agent.install` native addon (better-sqlite3 `--build-from-source` compiles via node-gyp + loads, `.node` `1000:shipit`); MCP `npmPackage` install (`npm i -g @modelcontextprotocol/server-everything` → `~/.npm-global`, `1000:shipit`); live chromium headless launch + screenshot to `/tmp/.playwright-mcp` (`1000:shipit`); archive→unarchive re-clone (`cloneFromCache` leaves `.git` root-owned on the orchestrator but the entrypoint `chown -R` self-heals it at next boot — sentinel removed by archive — end state fully `shipit`, 0 dubious-ownership). **Still unexercised against a running instance:** Claude/Codex resume + hooks, a forced OAuth token-refresh boundary, fork-merge, and CI-fix-log fetch (needs a real failing CI run).
- [x] **Make the new values the standing default** — `SHIPIT_SESSION_WORKER_UID=1000` + `AGENT_HOME=/home/shipit` baked into the permanent deploy configs (`deployment/vps/docker-compose.yml` prod, `docker/local/dev/compose.yml`, `docker/local/prod/compose.yml`) in PR #1336. Orchestrator `HOME` stays `/root` (auth.ts); dogfood/local mode left unflipped. Rollout step 3.
- [ ] **Code cleanup (optional, after rollback is off the table)** — tracked in [SHI-143](https://linear.app/shipit-ai/issue/SHI-143/remove-shipit-session-worker-uid-gate-retire-worker-uid-guard-make-non): delete the `SHIPIT_SESSION_WORKER_UID` gate so the chowns + privilege drop are unconditional, and retire the `worker-uid-guard`. (The `AGENT_HOME=/root` pin for local mode stays forever.)
- [x] **Tighten `CapAdd`** (§10) — dropped `DAC_OVERRIDE` + `NET_BIND_SERVICE` in PR #1349; kept `CHOWN`/`SETUID`/`SETGID`/`FOWNER` (the root entrypoint's chown + `gosu`-drop) and `KILL`. Validated on dev: post-change containers carry `CapAdd=[CHOWN SETUID SETGID FOWNER KILL]`, the worker still drops to `1000`, and workspace write / brokered git fetch / npm install / chromium launch+screenshot / the `:9100` listener all work with no regression.
