# Checklist — Auto-sized session containers

- [x] Remove `agent.memory` / `agent.cpu` / `agent.pids` from `AgentConfig` + schema in `shipit-config.ts`; route them through a warn-and-ignore deprecation path (alongside `resources:` / `capabilities:`)
- [x] Add host-capacity reader: cgroup v2 (`memory.max`) → cgroup v1 (`memory.limit_in_bytes`) → `os.totalmem()`, ignoring unlimited sentinels (`< osMb` comparison discards them)
- [x] Implement auto-derivation in `container-config-builder.ts`: `perSession = max(min(clamp(usable × PER_SESSION_USABLE_FRACTION, FLOOR, CEILING), usable), BOOT_MIN)`
- [x] Replace the `usable / TARGET_CONCURRENCY` division (a reservation model, contradicting Principle 1) with a fraction of usable; raise `CEILING` 16 GiB → 48 GiB so one heavy session can use the host
- [x] Pass `DEFAULT_SESSION_MEMORY_MB` / `MAX_SESSION_MEMORY_MB` through `deployment/vps/docker-compose.yml` — the documented override was a silent no-op without it
- [x] Add optional `DEFAULT_SESSION_MEMORY_MB` env (baseline) alongside `MAX_SESSION_MEMORY_MB` (cap); resolution `effective = min(baseline, cap)`
- [x] CPU quota = host core count × period (effectively unlimited per session; keeps `cpuQuota` a plain number through the plumbing); PIDs fixed at 8192
- [x] Keep `AGENT_DEFAULTS.memory` removed; `BOOT_MIN` (1536 MiB) lives in `container-config-builder.ts`
- [x] Update diagnostics: `services/diagnostics.ts` + `SessionDiagnosticsPanel.tsx` — show auto-derived sizing (`SessionMemorySizing`) instead of declared `agent.*`
- [x] Update `oom-circuit-breaker.ts` + panel OOM hint to point at `DEFAULT_SESSION_MEMORY_MB` / rescue flow, not "bump memory in shipit.yaml"
- [x] Update tests: `resolve-agent-docker-limits`, `shipit-config`, `diagnostics`, `session-container`, client panel, `diagnostics-endpoint`
- [x] Update warm-pool tests (`standby-container`, `warm-pool-staleness` W2/W3) — standby is auto-sized; limits can't go stale across a HEAD jump
- [x] Update `src/server/shipit-docs/shipit-yaml.md`: remove the resource-field rows; document automatic sizing + optional env overrides
- [x] Remove the now-dead stale-limit reprovision machinery (`reprovisionStandbyIfLimitsChanged` + its claim-time call); `bootedLimits` kept as diagnostics only (booted-vs-live-sizing display)
- [x] Reframe the "full suite OOMs the box" guidance in CLAUDE.md — sizing is automatic, the suite runs in-box when the session has enough memory
