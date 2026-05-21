# Checklist — agent auth recovery & model source-of-truth

Tracks remaining work for docs/142. See `plan.md` for design and rationale.

## C — model source-of-truth (done; shipped in PR #576)

- [x] `agentIdForModel(model, agentList)` helper + unit test
- [x] `useSessionWebSocket` derives the WS `agent` query param from the saved model
- [x] `ModelAgentSelector` always persists the picked model's agent (removed the
      stale in-memory `activeAgentId` guard)
- [ ] Verify on prod: a new session shown as Opus actually runs Claude/Opus
      (no silent switch to gpt-5.5)
- [ ] C2/C3 — server reconciliation (`index.ts` new-session agent/model resolve)
      left as a defensive guard. Confirm it no longer fires now the client sends
      a coherent (derived-agent, model) pair; if it still does, invert it to
      derive the agent from the model for unpinned sessions.

## B — stuck-state recovery (done; shipped in PR #576)

- [x] `_startAgentViaProxy` kills the stale worker agent + restarts on a
      persistent 409
- [x] `auth_required` tears the turn down (kill worker agent, clear `running`)
- [x] Tests: kill+restart path; `auth_required` teardown
- [ ] Verify on prod: after a failed turn, the next send is not blocked by
      "Agent already running"

## A — the 401 (ROOT-CAUSED + primary fix shipped)

Confirmed on prod (2026-05-21): short-lived access token, expired, refresh token
present; `claude -p` in the session 401s and leaves the file unchanged; both new
and existing Claude sessions fail. Root cause = rotating single-use refresh
token vs. write-once one-directional credential copy (the rotated token is never
written back to the orchestrator source, so every new session inherits a dead
refresh token). The earlier "~1 year expiry" premise was wrong; A2 dropped.

Chosen fix: **orchestrator-mediated copy-back** (keeps warm-pool + isolation
intact; closes the write-back loop with an expiry guard).

- [x] A-copyback — `syncAgentTokenIn` (pre-turn) + `syncAgentTokenBack`
      (post-turn, expiry-guarded, atomic) in `session-credentials.ts`, wired
      into `agent-execution.ts`. Claude-scoped; no-op in local mode.
- [x] A1 — classify the runtime 401 (`invalid authentication credentials` etc.,
      including error `result` events) → emits `auth_required`.
- [x] Tests — token sync-in/back + expiry-guard race; A1 detectors.
- [ ] **One-time prod step:** sign out + sign in to seed a fresh source token
      (the existing refresh token is already dead). Then verify a new Claude
      session works AND survives past the access-token TTL (create another
      session a few hours later — should still work, proving copy-back).
- [ ] A3 (follow-up) — on `auth_complete`, push the fresh token into
      already-pinned Claude sessions. Lower priority now: copy-back's next-turn
      sync-in already pulls the fresh source token.
- [ ] Extend the token sync to **Codex** once its `auth.json` token/expiry shape
      is verified (same latent rotation bug; not yet observed).

## Cross-cutting

- [ ] Update `src/server/shipit-docs/` if any agent-facing auth behavior changes.
- [ ] After deploy: confirm B (no stuck "Agent already running") and C (new
      session shown as Opus runs Claude) on prod.
