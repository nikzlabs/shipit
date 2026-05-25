# Checklist

- [ ] Probe and document the exact app-server behavior for `/goal resume`.
- [ ] Enable Codex `goals` feature flag and `experimentalApi` initialize capability.
- [ ] Add Codex adapter goal request methods and goal notification mapping.
- [ ] Proxy goal operations through session worker and orchestrator runner layers.
- [ ] Intercept recognized `/goal` chat commands for Codex sessions.
- [ ] Render goal state inline in the client without adding command buttons.
- [ ] Add adapter, integration, and client tests for set/status/clear states.
- [ ] Revisit Codex app-server process lifetime for active and paused goals.
