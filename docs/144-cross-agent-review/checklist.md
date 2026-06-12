# 144 — Sub-agent spawning — checklist

## v0 (this PR)

- [x] Global setting `enableSubAgents` (default off) — store, service, route, client toggle
- [x] `shipit agent run --agent <id> --prompt-file -` shim subcommand
- [x] Worker broker route `/agent-ops/agent/spawn` (trusted SESSION_ID, unbounded)
- [x] Orchestrator route `POST /api/sessions/:id/agent/spawn`
- [x] `services/sub-agent.ts` — setting/auth/pin/recursion/per-turn-cap gates
- [x] Worker `POST /agent/spawn` + `/agent/cancel` (fresh adapter outside the slot, no SSE)
- [x] Shared adapter-run core (`runAgentToCompletion`) — container + local
- [x] `SHIPIT_AGENT_DEPTH` stamping + best-effort recursion guard
- [x] Per-turn cap (3) — forgery-resistant, reset at primary-turn start
- [x] Wall-clock + output caps (truncation flagged)
- [x] Lazy, account-correct cross-agent credential provisioning + wipe
- [x] Token-sync-back before wipe
- [x] Sign-out sweep (AgentRegistry `sign-out` event → wipe non-pinned subtrees)
- [x] Usage attribution to `subAgentId` (+ `sub_agent_id` column)
- [x] Transient spawn chip (WS message + client store + MessageList row)
- [x] Symmetric cancel (interrupt/kill cancels in-flight spawns)
- [x] Local/dogfood mode in-process spawn
- [x] Agent-facing `shipit-docs/agent.md`
- [x] Unit/service tests (shim, run-helper, service gates, credentials, registry, chip)

## Deferred / follow-up

- [ ] Docker-backed integration run asserting the two-CLI memory floor
      (+500MB–1GB RSS) and confirming container sizing before GA.
- [ ] Live token-rotation-mid-run integration assertion (sub-agent CLI rotates
      its OAuth refresh token → resolved account root updated before wipe).
- [ ] Per-agent usage breakdown row in the per-session usage UI (the
      `sub_agent_id` column is stored; the UI split is not yet rendered).

## Future work (out of v0 scope — see plan.md "Future work")

- [ ] Hard read-only / `isolated` worktree spawn modes
- [ ] Structured review cards via `submit_review_comments` in a review-shaped spawn
- [ ] Streaming sub-agent progress into a collapsible chat region
