# Checklist — waiting on a sub-agent run

- [x] `requirements.md` written before any implementation
- [x] Status-carrying exit codes on `shipit agent result` (reqs 1–3)
- [x] `waitForSubAgentResult` — level-triggered wait over the persisted card (reqs 4, 9)
- [x] Route + broker forwarding for `wait`/`timeout`/`segment`
- [x] Shim segment loop with backoff and an overall deadline (reqs 5, 6)
- [x] Resumable pending exit with the re-run hint (req 7)
- [x] stdout/stderr output unchanged (req 8)
- [x] Narrowed the consult-card query so a poll doesn't scan the whole transcript (req 9)
- [x] Service tests (`sub-agent.test.ts`) and shim tests (`shipit.test.ts`)
- [x] `shipit-docs/agent.md` + `shipit --help` document the flag and exit codes (req 10)
- [x] Independent fresh-context review against the numbered requirements
- [x] Review defects fixed: unreadable 2xx never reads as success, shim-side run
      pinning across segments, hot-loop floor, request budget bounded by the
      caller's timeout, `--json` parity, sub-second `--timeout`
- [x] Restart-strand limitation stated honestly in plan.md and filed (planning#309)
- [x] Docs warn against piping a consult through `tail`/`head`/`grep` — the
      mistake that truncated this feature's own review to its last two findings
