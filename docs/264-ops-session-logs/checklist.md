# Checklist — `shipit session logs`

- [x] `services/host-session-logs.ts` — source allowlist, target resolution,
      time/line bounds, `redactStage1`
- [x] Ops-gated route `GET /api/sessions/:id/host-session-logs`
- [x] `logStore` threaded into `ApiDeps` from `route-registry.ts`
- [x] Worker relay `/agent-ops/session/host-session-logs`
- [x] `shipit session logs` shim handler + dispatch registration
- [x] Unit tests: source filter over every `LogSource`, window, tail, prefix
      resolution, redaction, pruned-vs-empty
- [x] Integration tests: ops gate (200/403/404), no non-server source in the
      payload, container-is-gone
- [x] Golden container-accessible route table + §3 path-scope case
- [x] `/shipit-docs/ops-session.md` — capability + boundary paragraph + recipe
      index
- [x] `/shipit-docs/sessions.md` — subcommand row
- [x] `templates-ops.ts` — README bullet, `prompts/read-session-logs.md`, and
      the two host-facing recipes reordered to run it first
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [x] Independent reviewer pass against every numbered requirement
- [x] Act on the review: content-template filter replacing the source-only
      allowlist (req 4), full-retention store read, `--lines` validation,
      strict ISO bounds, compile-time-exhaustive source sweep
- [x] Second independent reviewer pass on the narrowed design

## 2026-09-02 — the second incident packet (reqs 10–12)

- [x] `auto-push-scheduler.ts` reports a landed push, a nothing-to-push, and an
      unmeasurable count — counts and a duration only
- [x] Split the push-failure report: authored class line + `Git said:` line
- [x] Templates for the new lines, the two `Not pushed:` skips, the deferral
      pair, the GH008/LFS line, and the CLI watchdog / live-steer warnings
- [x] `WITHHELD_SHAPES` + `withheldTotal` / `withheldByShape` /
      `withheldUnclassified`, and the `by shape:` line in the CLI renderer
- [x] Meta-test that every withheld-shape pattern is a ShipIt-authored prefix
- [x] Regression tests: success template (unit + real-git integration), the
      split, the breakdown, the unclassified residue, the shim's fallback to an
      orchestrator that predates the breakdown
- [x] `/shipit-docs/ops-session.md` + `templates-ops.ts` state what the read now
      answers and what it still does not
- [x] `npm run test:dev`, `npm run lint:dev`, `npm run typecheck`
- [ ] Independent reviewer pass on reqs 10–12
