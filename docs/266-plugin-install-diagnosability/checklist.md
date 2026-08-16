# Checklist — plugin install diagnosability and forced re-install

- [x] `requirements.md` from nikzlabs/shipit#2323, with the three design
      questions answered and receipted (user, 2026-08-16)
- [x] `plan.md` — the four changes and why each reuses existing machinery
- [x] Durable last-install record: written on every terminal path of the install
      runner (and on the "runtime cannot install" publish), read for `status`
- [x] `GET /api/sessions/:id/plugin/status` + the snapshot assembly extracted so
      the card and the verb cannot disagree
- [x] `/agent-ops/plugin/status` relay; `force` normalized to a strict boolean
- [x] `shipit plugin status [name] [--json]` in the shim, with the corrected
      "reviewed out of the design" docstring
- [x] Refresh rows carry the live version's own degradation; exit code unchanged
- [x] `--force` threads shim → agent-ops → route → refresh → activation → install
- [x] Force skips the already-live short-circuit, the install stamp, and the
      dep-store adoption; refused without an explicit repository name
- [x] A forced round reports `re-installed <commit>`, not `already at <commit>`
- [x] Tests: record round-trip and outcome distinctions, status projection,
      refresh degradation + force re-activation, install force bypasses, shim
      rendering and refusals, agent-ops relays
- [x] `shipit-docs/plugins.md` — both verbs, what force costs, and the stale
      "no `logs`" passage corrected
- [x] `npm run lint:dev`, `npm run typecheck`, `npm run test:dev` clean
- [x] Independent review (`shipit agent run --role reviewer`) against every
      numbered requirement — run 9703d1fd
- [x] Review findings applied: the record only speaks for the LIVE commit
      (findings 1, 4); publish renames aside instead of deleting the live tree
      (finding 2); an unexpected throw in the install runner still records
      (finding 3); the absent-record line names both its causes (finding 5); the
      status route runs the tab's pending and unreadable-config pre-checks
      (finding 6); docs corrected where they overclaimed
