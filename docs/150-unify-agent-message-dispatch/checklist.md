# Checklist — 150 unify agent message dispatch

## Done

- [x] Add `AgentDispatchOptions` interface; rename `runner.sendSystemMessage` → `runner.dispatch(opts)` on `SessionRunnerInterface`, `SessionRunner`, `ContainerSessionRunner`.
- [x] Rename `runSystemTurn` → `runDispatchedTurn`; widen signature to accept `AgentDispatchOptions`.
- [x] Fix the recursive drain at `session-runner.ts` to thread every `QueuedMessage` field (not just `text`).
- [x] Auto-commit summary fallback: `turnSummary || opts.activity || "agent turn"` (drops legacy literal `"CI fix"`).
- [x] `message_queued` is broadcast via `runner.emitMessage` from inside `dispatch`'s enqueue branch; WS handler no longer emits it on a per-socket basis.
- [x] New service `services/agent.ts::dispatchAgentMessage` — input validation, runner resolution, auth gate, attachment resolution, dispatch.
- [x] New route `POST /api/sessions/:id/agent/dispatch` in `api-routes-agent.ts`; registered in `api-routes.ts`.
- [x] WS `send_message` queue branch delegates to `runner.dispatch(...)` (drops inline `messageQueue.push` + `ctx.send({ type: "message_queued" })`).
- [x] Convert client callsites: `handleCreatePr`, `handleSendErrors`, `handleSendComposeErrorToAgent`, `handleSendComposeHintToAgent`, `handleSendServiceLogsToAgent`, `useAutoFix.handleSendAutoFix`.
- [x] `ChatMessage.pendingDispatch?: true` flag; client helper `dispatchAgentMessage` sets it on the optimistic append.
- [x] `system_user_message` handler dedupes the tail bubble when `pendingDispatch === true`.
- [x] Per-callsite `inFlightRef` double-click guard.
- [x] Comment on `setPrefillText` documenting the "edit-then-send only" rule.
- [x] Update remaining doc-comments referencing `sendSystemMessage` / `runSystemTurn` in `services/rebase-driver.ts`, `services/pr-lifecycle.ts`, `session-agent-env.ts`, `session-agent-run-params.ts`, integration test comments.
- [x] Tests: `session-runner.test.ts` extended for `dispatch`, queue drain round-trip, broadcast `message_queued`. New `integration_tests/agent-dispatch-route.test.ts` covers 400/401/404 + idle vs queued. New `system-user-message.test.ts` covers the dedupe.

## Out of scope (future work)

- File-review send (`handleFileSendComments`, DiffPanel review), `/review` slash command, "Ask agent to review" — still WS `send_message` / `send_review_message`. Internally they reach the same `runner.dispatch` funnel via the WS handler delegation in this PR.
- Replace `prefillText` with an explicit "edit-then-send" modal for "Start Session from doc". The comment on `setPrefillText` is enough guardrail short-term.
- Per-request `requestId` server-side dedupe — client `inFlightRef` handles realistic double-clicks; add this only if telemetry shows duplicates leaking through.
- Threading attachments / permissionMode all the way into `runDispatchedTurn → agent.run(...)`. Today the HTTP service validates them up front and the queue carries them through; the WS-side drain (`runAgentWithMessage`) honors them when the queue drains via the user path. The system-turn path runs with `text` + `activity` only — the HTTP callers in this PR (Create PR, Fix compose, etc.) don't need attachments, so threading them deeper is deferred.
