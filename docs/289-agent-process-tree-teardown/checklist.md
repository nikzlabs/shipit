# Checklist

- [x] `killProcessTree` + `collectDescendants` in `shared/kill-child.ts`, snapshot-before-signal with a SIGKILL sweep
- [x] Ownership guard (root's `ppid` must be us) and `starttime` identity check on every delayed signal
- [x] Claude one-shot and streaming `kill()` route through the tree helper
- [x] Codex `kill()` (per-turn app-server teardown) routes through the tree helper
- [x] OpenCode kill / stop-kill / error-kill / stall deadline / interrupt escalation / compaction server
- [x] Grok kill / post-result kill / interrupt escalation
- [x] Sweep re-walks from every surviving roster member, not only the root, so a survivor's late child cannot escape
- [x] Co-located helper tests: descendants that outlive their parent, the SIGKILL sweep, a process spawned during the grace, recursion past direct children, the ownership boundary — each verified red with its own mechanism removed
- [x] Adapter tests pin which helper the Claude, Codex, OpenCode and Grok teardowns call
- [x] Independent review addressed (planning#509): survivor-spawn gap fixed, recycled-pid residual documented, test process churn reduced
- [x] `session-processes` skill and CLAUDE.md state the guarantee
