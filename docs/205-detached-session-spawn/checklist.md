# 205 — Detached Session Spawn — checklist

- [x] Add `--detached` parsing to the `shipit session create` shim handler.
- [x] On detached spawn: skip the `parentSessionId` / `rootSessionId` write
      (`graduateSession` omits them), keep `spawnedByTurn`.
- [x] On detached spawn: suppress the `session_spawned` WS event / `SpawnedSessionCard`
      (and the `session_spawn_failed` card too — a detached spawn stays silent in
      the parent chat on success *and* failure).
- [x] Enforce the per-turn spawn cap on detached spawns; exempt them from the
      per-parent active-children cap. (Per-turn count now sums linked children +
      `countDetachedSpawnedInTurn`, since detached sessions aren't in `findChildren`.)
- [x] Tests: no parent/root linkage, absent from `findChildren`, uncoordinatable
      (view 404), counts toward per-turn cap (incl. mixed linked+detached), no
      `session_spawned` emit, shim forwards `detached:true`, `--detached` +
      `--shipit-source` rejected.
- [x] Ship the agent instruction into `src/server/shipit-docs/sessions.md`
      (*Child vs detached spawns*) + the runtime system-prompt sections
      (`claude/`, `codex/`).
- [x] Final flag name: `--detached`.
