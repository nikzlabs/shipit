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
- [x] Session-scoped chip + consult card (`sessionId` on `sub_agent_spawn`,
      central `TRANSCRIPT_SCOPED_MESSAGES` drop in `dispatchMessage`) — a
      sub-agent spawned by a background session no longer renders in whichever
      session happens to be active

## Post-v0 — result delivery (SHI-245, docs/236)

- [x] Whole-answer capture in `runAgentToCompletion` (join every completed
      assistant message; dedupe an adapter's verbatim re-emit)
- [x] `runSubAgent` returns its `spawnId`; `shipit agent run` prints the run id
      on stderr (stdout stays the sub-agent's verbatim text)
- [x] `shipit agent result [RUN-ID] [--json]` reading the persisted consult
      card — broker leg, orchestrator route, `getSubAgentResult`
- [x] Termination-signal handler on the in-flight `run` window — say the run
      survives and where to read it, instead of exiting silently
- [x] Survives-the-caller contract documented: a killed shim does NOT cancel
      the spawn (explicit user cancel stays symmetric)
- [x] Agent-facing guidance to background long consults — `shipit-docs/agent.md`
      plus the always-loaded Claude and Codex system prompts
- [x] Replace the pre-ship "30–120s for a review-sized task" estimate
      everywhere (docs, shim help, code comments, the in-flight spinner) — the
      cap was raised 5 → 30 min because real consults overran it

## Deferred / follow-up

- [ ] Ground consult duration in real data rather than a characterisation: the
      `usage` table already stores `duration_ms` per consult against
      `sub_agent_id`, so a p50/p90 is a query away.

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
