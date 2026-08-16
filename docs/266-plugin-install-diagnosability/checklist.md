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

## Requirement 11 — a successful install's output (planning#416)

- [x] `PluginInstallRecord.output`: the tail an install PRINTED, written on the
      success path as well as the failure one, bounded by the existing
      `LOG_TAIL_LINES` / `REASON_MAX_CHARS` and clipped once more over the whole
      run so several installing exports cannot multiply it
- [x] `runInstallContainer` returns `{failure, output}` — the tail is read
      before the container is removed, on both outcomes
- [x] The record rides `refresh`'s rows; the shim emits it under `--json` only,
      and drops a record with no `commit`/`at` rather than inventing one
- [x] `status --json` carries it too (same record, no route change); the human
      status line points at `--json` when there is output and says so when the
      install printed nothing
- [x] Tests: success output recorded, both bounds, per-export labelling, no
      output for a skip, refresh row carries the record with its own commit,
      shim `--json` vs human output, malformed record dropped
- [x] `shipit-docs/plugins.md` — `--json` on both verbs, the `commit` caveat,
      and the plugin-author section corrected where it said the consumer cannot
      see a successful install's log at all
- [x] Independent review of requirement 11's slice — run ab815522
- [x] Review findings applied: a `skipped-stamp` for the SAME commit carries the
      output forward instead of erasing it on the re-stage path (finding 1); the
      tail is captured on the timeout and cancellation paths too, so a hung
      install's partial output survives (finding 3); the docs stop saying "the
      last 40 lines", which is per command and not per run (finding 2); guards
      added for the line bound, for `status`'s projection carrying the output,
      and for the carry-forward rules (finding 5).
      **Finding 4 not acted on**: `readInstallRecord` type-checks `output` but
      does not re-clip it, so the length bound is enforced where ShipIt writes
      rather than where the text lands. Same is already true of `detail`; the
      file is in the session state dir, which the agent container mounts
      read-only, so there is no writer to defend against — and duplicating the
      bound into a second module to defend a path nothing can reach costs more
      than it buys.
