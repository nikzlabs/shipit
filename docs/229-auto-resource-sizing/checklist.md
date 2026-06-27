# Checklist — Auto-sized session containers

- [ ] Preserve "unset" for `agent.memory` (and cpu/pids) in `shipit-config.ts` parser (don't substitute `AGENT_DEFAULTS` at parse time)
- [ ] Add host-capacity reader: `os.totalmem()` with `/sys/fs/cgroup/memory.max` fallback when set below host total
- [ ] Implement auto-derivation in `container-config-builder.ts` (`reserve` / `usable` / `clamp(usable/TARGET_CONCURRENCY, FLOOR, CEILING)`)
- [ ] Add optional `DEFAULT_SESSION_MEMORY_MB` env (baseline) alongside existing `MAX_SESSION_MEMORY_MB` (cap)
- [ ] Re-semantic repo `agent.memory` as a floor: `effective = clamp(baseline, repoFloor, cap)`
- [ ] Default CPU to no `CpuQuota` (optionally soft `CpuShares`); keep PIDs fork-bomb guard at 8192
- [ ] Update `resolve-agent-docker-limits.test.ts`: derived default, clamp, floor, tiny-host floor cases
- [ ] Update `src/server/shipit-docs/shipit-yaml.md`: `agent.memory` as minimum, auto behavior, env overrides
- [ ] Remove the stale "full suite OOMs the box" framing where it assumes a fixed small container (separate from this change, but related)
