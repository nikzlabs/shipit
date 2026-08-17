# 272 — User-selectable roles: checklist

Implementation to-do for this branch. See [`plan.md`](./plan.md).

## Server

- [x] `roleName` on `SessionInfo`, `role_name` column + migration, `setRoleName`
- [x] `services/session-role.ts` — `resolveUserRole`, `applyRoleToSession`, `takeRoleStandingInstructions`
- [x] `set_role` WS message (type + handler), refused after the first turn
- [x] `set_agent` / `set_model` / `set_reasoning` clear the role in force
- [x] `roleName` on `model_selection_changed`
- [x] `?role=` connect param, overriding the agent/model/reasoning seeds
- [x] Standing instructions as a prompt context block, latched on `originRoleName`
- [x] `role` in the headless creation body (quick capture)
- [x] A child session spawned from a role also carries `roleName`

## Client

- [x] `RoleSelector` + `useRolePickerState` (list, disabled reasons, "Adjust parameters…")
- [x] Wide row: three states, role replaces harness/model/reasoning
- [x] Narrow menu: Role row + panel, harness included
- [x] Role seed in localStorage; cleared by a harness/model/reasoning pick
- [x] `?role=` on connect; `set_role` from the composer
- [x] Quick capture carries the role
- [x] The same mark in Settings → Roles

## Verification

- [x] Unit tests: refusals, apply, the one-shot latch, the picker state, prompt ordering
- [x] Integration test: select → session seeded → parameter change clears the name
- [x] `eslint` over the changed files, `tsc --noEmit`
- [x] Independent review against every numbered requirement — ShipIt's configured reviewer
      (Codex, run `d4146b02`). All 17 met; two concerns raised, both resolved (see `plan.md`)
- [x] Visual check in a running instance — driven in the dogfood inner ShipIt:
      pick → pill replaces the three controls → "Adjust parameters…" brings them
      back showing the ROLE's values → moving one leaves the role. Both layouts.
      This is what caught the warm-session display bug, which every unit and
      integration test passed straight through.
