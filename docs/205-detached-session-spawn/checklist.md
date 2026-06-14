# 205 — Detached Session Spawn — checklist

- [ ] Add `--detached` parsing to the `shipit session create` shim handler.
- [ ] On detached spawn: skip the `parentSessionId` / `rootSessionId` write
      (`setParentSession`), keep `spawnedByTurn`.
- [ ] On detached spawn: suppress the `session_spawned` WS event / `SpawnedSessionCard`.
- [ ] Enforce the per-turn spawn cap on detached spawns; exempt them from the
      per-parent active-children cap.
- [ ] Tests: no parent/root linkage, absent from `findChildren`, counts toward
      per-turn cap, no `session_spawned` emit, renders flat in the sidebar.
- [ ] Ship the agent instruction into `src/server/shipit-docs/sessions.md`
      (only once the flag is live).
- [ ] Decide final flag name (`--detached` vs alternatives).
