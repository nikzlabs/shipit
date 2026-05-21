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

## A — the 401 (deferred: diagnose first)

A is NOT root-caused yet. The token is long-lived (~1 year), so plain expiry
isn't it; A2 (expiry validation) was dropped. The leading hypothesis is a
stale/rotated credential copy in the existing session's container.

- [ ] **Run the discriminating experiment** (now possible with C in): create a
      fresh Claude session, send one turn.
  - Works → existing session's 401 is a stale copy → do A3.
  - Also 401s → orchestrator token is dead → re-auth once; A1 is what matters.
- [ ] (optional) On the box, compare `expiresAt` / `hasRefresh` / `tokenTail`
      between the orchestrator creds and the failing session's per-session copy.
- [ ] A1 — classify the runtime 401 (`invalid authentication credentials` / `401`,
      including `result` events with `subtype: "error"`) so it emits
      `auth_required` instead of dying as a generic error.
- [ ] A3 — re-provision the pinned agent's `.claude` subtree into already-pinned
      sessions on `auth_complete` (write-once provisioning currently strands the
      fix). No-op in local mode; both-modes safe.
- [ ] Tests for A once the path is chosen.

## Cross-cutting

- [ ] Update `src/server/shipit-docs/` if any agent-facing auth behavior changes
      (A may touch this).
- [ ] Operational: if the experiment shows the orchestrator token is dead, do a
      one-time **sign out + sign in** to mint a fresh token.
