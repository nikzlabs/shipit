# Non-root Session Worker Checklist

- [x] Add a stable `shipit` UID/GID to session worker images. (rename upstream `node` → `shipit`, UID/GID 1000)
- [x] Add a minimal root entrypoint that prepares writable mounts and drops to `shipit`. (`docker/session-worker/entrypoint.sh`, `gosu`)
- [x] Introduce a shared `AGENT_HOME` runtime constant. (`src/server/shared/agent-home.ts` — `agentHome()`, resolved at call time)
- [x] Replace `/root` assumptions in worker, Claude, Codex, terminal, and auth probing code. (claude `process.ts`, `terminal.ts`, codex `adapter.ts`, `session-worker.ts`, `container-lifecycle.ts`)
- [x] Move credential symlinks to `/home/shipit`. (dev + prod Dockerfiles)
- [x] Ensure `/workspace`, `/uploads`, `/dep-cache`, `/credentials`, and browser scratch paths are writable by `shipit`. (entrypoint chown + orchestrator-side `chown` helpers §7)
- [x] Orchestrator-side ownership handoff gated on `SHIPIT_SESSION_WORKER_UID` (§7): credentials, gitconfig, uploads, CI-fix logs.
- [x] Pin Playwright browsers to `/opt/playwright-browsers` (readable by `shipit`) and mirror the env in `container-lifecycle.ts` (§8).
- [x] `npm install -g` global prefix moved to `/home/shipit/.npm-global` (§6); MCP installs spawn from `agentHome()`.
- [x] Keep local/dogfood mode on root with `AGENT_HOME=/root` (§9).
- [x] Enumerate the writable paths the worker needs (groundwork for SHI-97 ReadonlyRootfs/seccomp) — see `plan.md` "Writable paths".
- [x] Update `src/server/shipit-docs/environment.md`.
- [x] Unit/integration tests: `agent-home`, `session-worker-uid`, `container-lifecycle` env, `session-credentials` §7 chown.
- [x] Run lint, typecheck, and targeted container/worker tests.

## Follow-ups (not in this change)

- [ ] Validate end-to-end on a real built image: Claude/Codex auth + resume + hooks, `agent.install` with native addons, MCP `npmPackage` install, browser tools, brokered git, warm-pool preinstall, archive-restore. (requires image build + deploy)
- [ ] Tighten `CapAdd` after the worker runs non-root — drop `DAC_OVERRIDE` and `NET_BIND_SERVICE` if no regressions (§10).
- [ ] Single atomic deploy that ships the non-root image AND sets `SHIPIT_SESSION_WORKER_UID=1000` + `AGENT_HOME=/home/shipit` + `HOME=/home/shipit` on the orchestrator (Rollout step 3).
- [ ] Orchestrator startup fail-fast guard on UID/env drift (Rollout).
