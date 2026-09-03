# Checklist

- [x] `killProcessTree` + `collectDescendants` in `shared/kill-child.ts`, snapshot-before-signal with a SIGKILL sweep
- [x] Ownership guard (root's `ppid` must be us) and `starttime` identity check on every delayed signal
- [x] Claude one-shot and streaming `kill()` route through the tree helper
- [x] Codex `kill()` (per-turn app-server teardown) routes through the tree helper
- [x] OpenCode kill / stop-kill / error-kill / stall deadline / interrupt escalation / compaction server
- [x] Grok kill / post-result kill / interrupt escalation
- [x] Co-located helper tests: descendants that outlive a plain `killChild`, the SIGKILL sweep, recursion past direct children, the ownership boundary — each verified red with its own mechanism removed
- [x] Adapter tests pin which helper the Claude and Codex teardowns call
- [x] `session-processes` skill and CLAUDE.md state the guarantee
