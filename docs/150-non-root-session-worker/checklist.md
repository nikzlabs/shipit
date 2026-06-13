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

## Deferred (separate steps — not in this PR)

- [ ] **Validate on a real built image:** Claude/Codex auth + resume + hooks, `agent.install` with native addons, MCP `npmPackage` install, browser tools, brokered git, warm-pool preinstall, archive-restore. (requires image build + deploy)
- [ ] **Make the new values the standing default** — bake `SHIPIT_SESSION_WORKER_UID=1000` into the permanent deploy config (Rollout step 3), not a one-off env.
- [ ] **Code cleanup (optional, after rollback is off the table):** delete the `SHIPIT_SESSION_WORKER_UID` gate so the chowns + privilege drop are unconditional, and retire the `worker-uid-guard`. (The `AGENT_HOME=/root` pin for local mode stays forever.)
- [ ] **Tighten `CapAdd`** after the worker runs non-root — drop `DAC_OVERRIDE` and `NET_BIND_SERVICE` if no regressions (§10).
