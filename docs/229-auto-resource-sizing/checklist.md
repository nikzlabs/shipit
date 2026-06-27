# Checklist — Auto-sized session containers

- [ ] Remove `agent.memory` / `agent.cpu` / `agent.pids` from `AgentConfig` + schema in `shipit-config.ts`; route them through the existing warn-and-ignore deprecation path (alongside `resources:` / `capabilities:`)
- [ ] Add host-capacity reader: `os.totalmem()` with `/sys/fs/cgroup/memory.max` fallback when set below host total
- [ ] Implement auto-derivation in `container-config-builder.ts` (`reserve` / `usable` / `clamp(usable/TARGET_CONCURRENCY, FLOOR, CEILING)`)
- [ ] Add optional `DEFAULT_SESSION_MEMORY_MB` env (baseline) alongside existing `MAX_SESSION_MEMORY_MB` (cap); resolution `effective = min(baseline, cap)`
- [ ] Default CPU to no `CpuQuota` (optionally soft `CpuShares`); keep PIDs fork-bomb guard at 8192
- [ ] Keep `AGENT_DEFAULTS.memory` (1536) only as the tiny-host floor
- [ ] Update `resolve-agent-docker-limits.test.ts`: derived default, env override, clamp, tiny-host floor, and deprecated-field-ignored-with-warning cases
- [ ] Update `src/server/shipit-docs/shipit-yaml.md`: remove the resource-field rows; document automatic sizing + optional env overrides
- [ ] Remove the stale "full suite OOMs the box" framing where it assumes a fixed small container (related, separate change)
