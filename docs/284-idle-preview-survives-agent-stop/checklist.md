# Idle preview survives the agent container — checklist

- [x] Attribute Docker memory usage per session (agent vs services).
- [x] Make the pressure fraction measure against a user-set memory budget.
- [x] Replace the `maxIdleContainers` setting with `memoryBudgetMb` end to end.
- [x] Rewrite the idle enforcer as a two-tier, memory-driven reclaim ladder.
- [x] Keep the Compose stack alive when tier 1 stops an agent container.
- [x] Repoint the warm-pool standby guard at the budget.
- [x] Distinguish tier 1 from tier 2 in the SSE reason, Logs copy, and the health strip.
- [x] Report the memory banner against the budget and name it.
- [x] Cover budget math, per-session attribution, and both tiers with tests.
- [x] Default a local install's budget to half the machine.
- [x] Update the agent-facing environment and preview docs.
