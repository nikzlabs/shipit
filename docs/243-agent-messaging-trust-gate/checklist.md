# Agent messaging repository trust gate — checklist

## Product decisions still open

- [ ] Decide where the existing trust explanation appears when the user is not on the Preview tab
- [ ] Decide how an AskUserQuestion answer control renders while repository messaging is blocked
- [ ] Decide whether blocked programmatic/system turns settle as blocked or retry after trust is granted
- [ ] If trust revocation is added later, define its effect on running and queued work; revocation is not part of the current requirements

## Shared server admission invariant

- [ ] Make `SessionRunnerInterface.dispatch()` the only ingress for every new agent turn
- [x] Add one synchronous, fail-closed authorization check at the start of shared `dispatchOnRunner()`
- [x] Resolve the authoritative remote from `sessionManager.get(runner.sessionId)` and check it with `RepoStore.isTrusted()`
- [x] Deny unknown remotes, missing sessions, and missing production authorization dependencies
- [x] Preserve trusted-by-construction behavior for sessions without a remote and ShipIt-created templates
- [x] Ensure denial happens before settlement side effects, running-state mutation, steering, queue insertion, persistence, graduation, attachment reads, or process creation
- [x] Re-check authorization when queued or recovered work re-enters `dispatchOnRunner()`
- [ ] Drop and settle a denied queued entry exactly once without starting it or looping the drain

## Interactive ingress migration

- [ ] Route idle composer `send_message` turns through `runner.dispatch` with interactive execution semantics
- [x] Move the busy composer's direct live-steering path behind the runner-owned admission boundary
- [ ] Route `answer_question` / resume turns through `runner.dispatch`
- [ ] Preserve attachments, uploads, permission mode, review metadata, compaction, and merged-branch-reset semantics through `PreparedDispatch`
- [ ] Move warm-session graduation and pool refill after successful admission for WS and HTTP dispatch paths
- [ ] Keep lower-level turn executors private to admitted runner execution rather than usable as new-turn ingress
- [ ] Repeat the production ingress audit for `.dispatch(`, `runAgentWithMessage`, `send_message`, and `answer_question` before completion

## Stable rejection contract

- [x] Define one typed repository-trust admission failure shared by all transports
- [x] Return HTTP `403` with stable machine code `repository_untrusted`
- [x] Emit the same stable code and explanatory message on the WS error path
- [x] Include authoritative session identity where supported
- [x] Make a denied dispatch distinguishable from started, steered, and queued outcomes without parsing prose

## Client restricted state and consent UX

- [x] Derive repository trust for normal and pre-first-turn warm routes from `currentSession?.remoteUrl ?? newSessionRepoUrl`
- [x] Keep send disabled while a known remote's trust state is unresolved or explicitly untrusted
- [x] Add repository trust to `MessageInput.disabled` without weakening existing connection-state disabling
- [ ] Apply the same client guard to review, answer, Create PR, send-logs/errors, auto-fix, and other messaging affordances for clean UX
- [x] Keep the existing “Trust this repository” action as the only consent action
- [x] Update the existing trust explanation to say agent messages, install, and services remain blocked until trust
- [x] Enable messaging only after the authoritative trust response/SSE state update
- [x] On trust-request failure, keep messaging disabled, reset the Trust button busy state with `try/finally`, and surface the error

## Optimistic-state rollback

- [x] Give WS sends a precise request/delivery identity for correlating a rejected optimistic message
- [x] Roll back only the matching optimistic WS or HTTP bubble on `repository_untrusted`
- [x] Clear loading, activity, optimistic active-runner state, and an unsent pending WS frame for the rejected message
- [ ] Preserve the user's composer draft where practical
- [x] Ensure rejection never leaves UI state implying that an agent turn started

## Server tests

- [ ] Cover untrusted, unknown-remote, missing-session, and missing-authorizer rejection on both runner implementations
- [ ] Assert denial occurs before every forbidden side effect named in the invariant
- [x] Assert an untrusted busy runner neither steers the resident agent nor grows its queue
- [ ] Assert denied queued/recovered work settles once and cannot loop
- [ ] Assert authorization uses the session's server-owned remote rather than dispatch input
- [ ] Cover trusted remote and no-remote/template controls
- [ ] Cover WS `send_message`, `answer_question`, review/follow-up sends, and HTTP `/agent/dispatch` with the stable error
- [ ] Cover an untrusted warm first turn with no graduation, naming, branch rename, repo touch, pool refill, persistence, disk read, queue insertion, or process start
- [ ] Cover programmatic ingress classes: lifecycle/merge wake, CI fix, rebase resolution, child/headless/quick sessions, session report/message resume, bootstrap pending work, and turn adoption
- [ ] Add a structural guard that interactive WS paths cannot bypass `runner.dispatch`

## Client tests

- [ ] Disable the composer for an untrusted existing session
- [ ] Disable the composer on `/{slug}/new` before warm-session graduation
- [ ] Avoid an enabled-state flash while trust data for a known remote is unresolved
- [ ] Enable messaging after authoritative trust state arrives
- [ ] Keep no-remote and ShipIt-template sessions enabled
- [ ] Verify the existing Trust surface remains the only consent action and explains the message restriction
- [ ] Verify failed trust restores the button and leaves send disabled
- [ ] Verify exact optimistic rollback without removing unrelated messages

## Regression, docs, and completion

- [ ] Keep existing install, warm pre-install, Compose, and RepoStore trust tests green
- [x] Run affected tests, `npm run lint:dev`, and `npm run typecheck`
- [ ] Update `docs/178-repo-trust-gate` only if the implementation changes the concise supersession relationship
- [ ] Add the relationship reference to the Agent Interface SDK package when that package exists in the checkout
- [ ] Run `bash .claude/skills/docs-navigator/index.sh` and confirm this package remains independently discoverable
- [ ] Mark every completed item above and move the feature to Done only when implementation and tests are complete
