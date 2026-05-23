# Non-root Session Worker Checklist

- [ ] Add a stable `shipit` UID/GID to session worker images.
- [ ] Add a minimal root entrypoint that prepares writable mounts and drops to `shipit`.
- [ ] Introduce a shared `AGENT_HOME` runtime constant.
- [ ] Replace `/root` assumptions in worker, Claude, Codex, terminal, and auth probing code.
- [ ] Move credential symlinks to `/home/shipit`.
- [ ] Ensure `/workspace`, `/uploads`, `/dep-cache`, `/credentials`, and browser scratch paths are writable by `shipit`.
- [ ] Validate Claude auth, resume, hooks, and MCP config.
- [ ] Validate Codex auth, app-server startup, and managed review MCP config.
- [ ] Validate `agent.install`, native addon builds, and cache reuse.
- [ ] Validate terminal user and workspace file ownership.
- [ ] Validate brokered Git credentials from inside the container.
- [ ] Validate warm-pool preinstall.
- [ ] Tighten `CapAdd` after the worker runs non-root.
- [ ] Update `src/server/shipit-docs/environment.md`.
- [ ] Run lint, typecheck, and targeted container/worker tests.
