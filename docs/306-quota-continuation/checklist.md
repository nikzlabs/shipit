# Checklist — autonomous work survives a quota wall

- [x] `QuotaContinuationManager`: stand-down decision, stall registry, sweep, wake
- [x] Continuation prompt that stands on its own hours later
- [x] `retireOnSpentAccount` asks the router and drops the "send a message" instruction
- [x] `quota-continuation` runs last in the terminal sequence, inside `postTurnStep`
- [x] Wiring through `SystemTurnDeps`, the runner registry and bootstrap; sweep stopped on shutdown
- [x] Service unit tests, each assertion verified red on its own
- [x] Executor tests: continuation when a credential is free, stand-down when none is
- [x] docs/140 phase 6.12 marked superseded in part, with the reason
