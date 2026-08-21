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
- [x] A locked role keeps the model and reasoning controls, in both layouts (req 4, second half)
- [x] …and keeps the ROUTE to them, not the controls themselves: the locked pill opens onto
      "Adjust parameters…" and no roles, and the row stays short until the user asks (reqs 5, 15)

## Verification

- [x] Unit tests: refusals, apply, the one-shot latch, the picker state, prompt ordering
- [x] Integration test: select → session seeded → parameter change clears the name
- [x] `eslint` over the changed files, `tsc --noEmit`
- [x] Independent review against every numbered requirement — ShipIt's configured reviewer
      (Codex, run `d4146b02`). All 17 met; two concerns raised, both resolved (see `plan.md`)
- [x] Re-reviewed after the locked-route correction (Codex, run `69835b9f`). All 17 still met, no
      route to the parameters lost on any locked path, the reversal judged honestly documented.
      Three docstrings said "no role applies any more" where they meant "no role can be chosen";
      all three corrected
- [x] Visual check in a running instance — driven in the dogfood inner ShipIt:
      pick → pill replaces the three controls → "Adjust parameters…" brings them
      back showing the ROLE's values → moving one leaves the role. Both layouts.
      This is what caught the warm-session display bug, which every unit and
      integration test passed straight through.

## No role (req 18, 2026-08-20)

- [x] `set_role` takes `roleName: string | null`; the `null` branch writes only the name and
      refuses on `agentPinned` exactly as a selection does
- [x] "No role" is the first row of the roles list, in both layouts, and is what the list shows as
      chosen while none is in force
- [x] The seed follows it, so the next new session starts with no role (req 12)
- [x] Quick capture applies no seeds when the role is cleared — the parameters stay where the role
      left them
- [x] The clear is recorded as a CHOICE (`role_name = ''`), so the `?role=` seed cannot put the role
      back on a reconnect — the browser's seed lives in a memoized per-session WS URL, and the
      shipped "no fourth guard needed" argument only ever covered the two automatic clears
- [x] Tests: the clear leaves every parameter untouched; the clear is refused after the first turn;
      the option is absent from a locked control in both layouts; a reconnect that still seeds the
      cleared role leaves it cleared, and re-picking it still works
