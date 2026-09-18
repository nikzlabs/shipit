# Checklist — autonomous work survives a quota wall

- [x] `QuotaContinuationManager`: stand-down decision, registry, sweep, wake
- [x] Availability answered through `selectRouteForSelection`, so a subscription carried as a string counts
- [x] Continuation prompt that stands on its own hours later
- [x] `retireOnSpentAccount` asks the router, drops the "send a message" instruction, and names no turn type
- [x] `quota-continuation` runs last in both terminal sequences, inside `postTurnStep`
- [x] Adapter-error refusals stand down too, stamping the bench the result path gets from the listener
- [x] Sweep waits on `agentBusy`, so it cannot start a successor against an uncommitted tree
- [x] Undeliverable wakes retried, bounded at three attempts
- [x] Wiring through `SystemTurnDeps`, the runner registry and bootstrap; sweep stopped on shutdown
- [x] Tests for both files, each assertion verified red on its own
- [x] Independent cross-model review; findings fixed or recorded under "Known gaps"
- [x] docs/140 phase 6.12 marked superseded in part, with the reason
- [ ] Record a stall when a continuation is refused by every credential (see "Known gaps")
