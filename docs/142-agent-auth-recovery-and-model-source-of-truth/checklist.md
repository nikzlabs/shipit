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
- [x] Expiry-guard `syncAgentTokenIn` too (not just sync-back) so it never
      overwrites a session's fresher local token with a staler source — and so a
      stale/dead source can't be propagated into every session (that uniform
      propagation is what also broke session naming during the incident).
- [x] Tests — token sync-in/back + both expiry guards; A1 detectors.
- [x] **One-time prod step DONE (2026-05-21):** signed out (cleared the dead
      `Ds9AAA` token) + signed in → fresh token `n7mAAA`, `expiresAt` ~28h out.
      New + existing sessions work again (#577 live; per-turn sync-in healed the
      pinned sessions). NOTE: sign-out was required because the UI couldn't tell
      a dead token from a live one — see the honest-auth-state item below.
- [ ] **Validate copy-back at the TTL boundary (~28h after re-login):** create a
      Claude session past the access-token expiry — if it still works, a session
      refreshed and wrote the rotated token back. If it 401s, move sync-back off
      the post-turn hook (the CLI may refresh lazily) onto a credential-file
      watch.
- [ ] **Honest auth state:** A1 (now live) flips the card reactively on the next
      runtime 401 → `auth_required` → OAuth flow, so the manual sign-out we
      needed this time should not recur. Confirm at the TTL boundary that a dead
      token auto-surfaces the re-auth prompt (rather than a silent 401). A
      *proactive* "is the token usable" probe is deliberately NOT built — it
      can't distinguish expired-but-refreshable from dead without rotating.
- [ ] A3 (follow-up) — on `auth_complete`, push the fresh token into
      already-pinned Claude sessions. Lower priority now: copy-back's next-turn
      sync-in already pulls the fresh source token.
- [ ] Extend the token sync to **Codex** once its `auth.json` token/expiry shape
      is verified (same latent rotation bug; not yet observed).

## D — worker timeout crashed the orchestrator (done; not yet deployed)

Found on prod (2026-05-21): the dead token made a `POST /terminal/start` worker
call hit the 10s timeout; the resulting `WorkerTimeoutError` floated out of the
WS dispatcher's `return handler(...)` as an unhandled rejection and killed the
whole orchestrator (`RestartCount=1`), taking every live session with it. This
is also the likely reason the first re-login attempt "didn't go through" — the
orchestrator restarted mid-flow.

- [x] D1 — WS dispatcher awaits each handler inside a try/catch
      (`dispatchSessionMessage`); a rejection degrades to a per-session
      `error`, never an unhandled rejection.
- [x] D2 — process-level `unhandledRejection` backstop in `autoStart`
      (production entry point) logs and stays alive; `uncaughtException` left
      to Node's default on purpose.
- [x] Test — `ws-handler-error-isolation.test.ts`: a rejecting handler surfaces
      a client error and the socket/process survive.
- [ ] Verify on prod after deploy: a wedged worker call no longer restarts the
      orchestrator (no new `RestartCount` bumps in the crash window).

## Cross-cutting

- [ ] Update `src/server/shipit-docs/` if any agent-facing auth behavior changes.
- [ ] After deploy: confirm B (no stuck "Agent already running") and C (new
      session shown as Opus runs Claude) on prod.
