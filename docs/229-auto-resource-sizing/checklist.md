# Checklist — Auto-sized session containers

- [ ] Remove `agent.memory` / `agent.cpu` / `agent.pids` from `AgentConfig` + schema in `shipit-config.ts`; route them through the existing warn-and-ignore deprecation path (alongside `resources:` / `capabilities:`)
- [ ] Add host-capacity reader: cgroup v2 (`memory.max`) → cgroup v1 (`memory.limit_in_bytes`) → `os.totalmem()`, ignoring unlimited sentinels and values ≥ host total
- [ ] Implement auto-derivation in `container-config-builder.ts`: `perSession = max(min(clamp(usable/TARGET_CONCURRENCY, FLOOR, CEILING), usable), BOOT_MIN)`
- [ ] Add optional `DEFAULT_SESSION_MEMORY_MB` env (baseline) alongside `MAX_SESSION_MEMORY_MB` (cap); resolution `effective = min(baseline, cap)`
- [ ] Make `cpuQuota` optional in `container-lifecycle.ts` / `session-container.ts` so `HostConfig` omits `CpuQuota` / `CpuPeriod` by default (undefined, not 0); keep PIDs fork-bomb guard at 8192
- [ ] Keep `AGENT_DEFAULTS.memory` (1536 MiB) only as `BOOT_MIN`
- [ ] Update diagnostics: `services/diagnostics.ts` + `SessionDiagnosticsPanel.tsx` — show auto-derived sizing metadata instead of declared `agent.*`
- [ ] Update `oom-circuit-breaker.ts` OOM guidance to point at deployment env / rescue flow, not "bump memory in shipit.yaml"
- [ ] Update `resolve-agent-docker-limits.test.ts`: derived default, env override, clamp, tiny-host (`usable`-capped) floor, `BOOT_MIN`, no-default-`CpuQuota`, deprecated-field-ignored-with-warning cases
- [ ] Update `src/server/shipit-docs/shipit-yaml.md`: remove the resource-field rows; document automatic sizing + optional env overrides
- [ ] Remove the stale "full suite OOMs the box" framing where it assumes a fixed small container (related, separate change)
