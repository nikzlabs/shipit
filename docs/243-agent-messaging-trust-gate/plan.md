---
title: Agent messaging repository trust gate
description: Make repository trust a fail-closed prerequisite for every new agent turn, enforced at the shared runner boundary and reflected in the composer.
---

# Agent messaging repository trust gate

## Status and scope

This is a requirements/design package only. Production implementation belongs in a later change.

The user requirements are recorded, without additions, in [requirements.md](./requirements.md). This plan separates those requirements from implementation decisions, verified facts, test strategy, and open product questions.

This design supersedes one decision in `docs/178-repo-trust-gate`: an untrusted remote may still be cloned and inspected, but it may no longer send any message to an agent. It remains a separate package from the Agent Interface SDK design. The SDK is a future consumer of the invariant specified here, not its owner.

## Requirement provenance

The requested outcome is narrow:

- an untrusted repository cannot send messages to an agent;
- the normal chat send control reflects that state;
- the server is authoritative; and
- the existing Trust action grants the consent.

Everything below is an implementation decision or an open question. In particular, the requirements do not prescribe a new trust store, a new consent action, a second policy tier, queue cancellation, running-turn interruption, trust revocation, or SDK-specific authorization machinery.

## Verified current behavior

The following facts were verified at source, rather than inherited from the historical docs:

- `RepoStore.isTrusted(url)` is the persisted, synchronous per-remote lookup. It compares `canonicalRepoKey()` identities, treats an unknown remote as untrusted, and `setTrusted()` can technically write either value (`repo-store.ts:isTrusted`, `setTrusted`).
- The public trust action is grant-only. `POST /api/repos/trust` calls `setTrusted(url, true)`; no current UI or API path revokes trust (`api-routes-session-repos.ts`, `services/repos.ts`). Therefore a repository cannot currently transition from trusted to untrusted through a supported product action.
- ShipIt-created template repositories are explicitly marked trusted, and sessions without a remote bypass the existing setup gate as trusted by construction (`api-routes-session-repos.ts`, `service-manager-setup.ts`).
- Install and Compose setup already consult trust. Warm pre-install skips an untrusted remote (`warm-pool-manager.ts`), and activation setup returns before `agent.install` or Compose startup (`service-manager-setup.ts:setupServiceManager`). Trusting later re-runs deferred setup for live runners.
- Agent messaging does not consult trust. `RepoTrustBanner` explicitly says chat remains available; `App.tsx` disables `MessageInput` from WebSocket readiness only; `sendUserMessage` performs optimistic state changes without trust; and neither the WS handlers nor `services/agent.ts` checks `RepoStore.isTrusted`.
- The pre-first-turn warm route is special: the claimed session remains absent from the ordinary session list until graduation. `App.tsx` already resolves its remote from `currentSession?.remoteUrl ?? newSessionRepoUrl` so the existing trust surface works before graduation.
- A normal WS first turn currently graduates a warm session inside `handleSendMessage` before starting the agent. HTTP `/agent/dispatch` likewise graduates inside `dispatchAgentMessage` before calling `runner.dispatch`.
- `dispatchOnRunner()` is the single send/steer/queue/start implementation used by both `SessionRunner` and `ContainerSessionRunner`. It sets running state, may steer, may enqueue, or starts `runDispatchedTurn`.
- Not every turn currently reaches that boundary. An idle composer `send_message` and `answer_question` call `runAgentWithMessage` directly; a running composer message may steer directly before its fallback calls `runner.dispatch`.
- Queued work is in-memory runner state. Queue drain re-enters `dispatchOnRunner()` through `queuedMessageToDispatchOptions`; restart/adoption code may redispatch restored pending work.
- Already-running work is not affected by the current trust grant-only model because supported product flows cannot revoke trust. Forced teardown actions can stop a runner, but they are not trust revocation.

## Agent-turn ingress inventory

The security boundary must cover the behavior, not merely today's routes. The audited ingress classes are:

| Ingress | Current path | Pre-boundary side effects / concern |
|---|---|---|
| Composer, idle | `App.handleSend` → WS `send_message` → `handleSendMessage` → `runAgentWithMessage` | Optimistic client bubble; warm graduation, attachment reads, stale-process handling, running flag, persistence and process start occur outside `runner.dispatch`. |
| Composer, busy | WS `send_message` → direct live steer, otherwise `runner.dispatch` | Direct steering can reach the resident agent and persist the steer before the shared dispatch boundary. |
| Ask/answer and resume UI | WS `answer_question` → `handleAnswerQuestion` → `runAgentWithMessage` | Starts a fresh resumed turn directly and can mutate runner/process state first. |
| Review and follow-up surfaces | `/review`, file/diff/doc review, plan feedback, service-log follow-up | These compose `send_message` or `answer_question`; they must inherit the same block rather than each adding policy. |
| HTTP dispatch | `POST /api/sessions/:id/agent/dispatch` → `services/agent.ts` → `runner.dispatch` | Used by Create PR, preview/Compose error sends, preview auto-fix, and similar actions; currently performs validation, attachment resolution, and warm graduation before dispatch. |
| Programmatic/system turns | direct `runner.dispatch(prepareDispatch(...))` | Includes lifecycle wake, notify-on-merge, rebase resolution, CI fix, headless/quick sessions, child-session start/message/resume, and session reports. |
| Queue insertion and drain | `dispatchOnRunner` enqueue → `dequeue` → `dispatchOnRunner` | Admission must happen before insertion; drain must re-check so future revocation semantics cannot run an entry under stale authorization. |
| Persisted pending/restart recovery | bootstrap queued-message restore, turn adoption, delivery retry | Restored work must re-enter the same admission boundary, not be treated as pre-authorized because it was created earlier. |
| Warm-session first turn | WS or HTTP path, then `graduateSession` | Must reject before graduation, naming, branch rename, repo touch, warm-pool refill, or any first-turn persistence. |
| Future Agent Interface SDK | future caller | Must call the same runner admission API; SDK transport/auth must not become a parallel trust implementation. |

Direct `runner.dispatch` production callers found in the audit are in `app-lifecycle.ts`, `wake-session.ts`, `bootstrap-managers.ts`, `turn-adoption.ts`, `services/agent.ts`, `services/headless-sessions.ts`, `services/rebase-driver.ts`, `services/child-sessions.ts`, and `services/github-ci-fix.ts`, plus the WS queue fallback. The implementation phase must repeat the search for `runner.dispatch`, `.dispatch(`, `runAgentWithMessage`, `sendUserMessage`, `send_message`, and `answer_question`; this list is a verified snapshot, not a whitelist.

## Design: one admission boundary

### Decision

Make `SessionRunnerInterface.dispatch()` the only way to introduce a new agent message, including interactive composer and answer/resume turns. Put a synchronous, fail-closed trust admission check as the first operation in the shared `dispatchOnRunner()` implementation, before settlement creation, steering, queue insertion, running-state mutation, persistence, graduation, attachment resolution, or process creation.

Both runner implementations already delegate to `dispatchOnRunner`, so the invariant is stated once:

> A dispatch for a session with a remote is admitted only when that remote is trusted at the instant the dispatch boundary is entered. A missing session/trust resolver or an unknown remote denies admission. A session with no remote is trusted by construction.

The runner must be wired at creation with an authorizer that resolves the session by `runner.sessionId`, reads its authoritative `remoteUrl`, and asks `RepoStore.isTrusted(remoteUrl)`. It must not accept a client-supplied URL or trust flag. Missing dependencies fail closed for production runners; test helpers must opt into an explicit trusted authorizer rather than inheriting an allow-by-default fallback.

This is smaller than adding checks to every WS/HTTP/programmatic route, and stronger than adding a `RepoStore` check to the two visible send handlers. A future SDK or remediation manager receives the invariant automatically by using the only turn API.

### Unifying interactive turns

Refactor the WS paths so they prepare a complete `PreparedDispatch` with `execution: "interactive"` and call `runner.dispatch` before any turn-specific effect:

- Idle composer sends are admitted, then the interactive executor performs validation/attachment preparation, warm graduation, persistence, and process start.
- Busy composer sends enter the same boundary; only an admitted dispatch may steer or enqueue. The current direct-steering branch moves behind `dispatchOnRunner` rather than retaining a pre-check bypass.
- `answer_question` becomes an interactive dispatch variant instead of calling `runAgentWithMessage` directly. Any answer-specific preparation (formatting the answer, preserving permission mode, resume metadata) must be data carried by the prepared dispatch or performed only after admission.

The implementation should extend the existing prepared-dispatch type only as needed to preserve interactive semantics. It should not create a second queue or a trust-aware wrapper that callers can bypass.

### Warm graduation and other preparation

Admission must precede all behavior observable as accepting a new turn. Move warm graduation out of the WS and HTTP ingress services into the post-admission executor, or provide one post-admission preparation hook used by both interactive and dispatched execution. The ordering is:

1. resolve authoritative session and trust;
2. reject or admit;
3. validate/resolve attachments as required;
4. graduate a warm session and refill its pool;
5. persist the user/system message;
6. steer, enqueue, or start the process.

Input shape validation may happen before admission if it is pure and has no session mutation, disk read, persistence, or agent effect. The security contract is that an untrusted request cannot graduate, steer, enqueue, persist transcript content, set running state, or start a process.

### Re-checking queued and recovered work

The same boundary runs both when an item is first submitted and when it is later dequeued or recovered. Initial rejection means ordinary untrusted requests never enter the queue. Re-checking at drain/recovery is deliberate defense in depth for future revocation and for durable pending work reconstructed after restart.

If a re-check denies an existing queued item, remove it through the normal settlement/drop machinery, do not start it, and surface the same stable rejection reason. The implementation must avoid a drain loop repeatedly selecting an entry that can never run.

### Stable server error

Define one typed admission failure shared by WS and HTTP adapters, with:

- HTTP status `403`;
- a stable machine code such as `repository_untrusted`;
- one user-facing message directing the user to the existing Trust action; and
- the authoritative session ID where the transport supports it.

The WS adapter emits the ordinary error response with the stable code added to the shared WS type. The HTTP adapter maps the same error to its normal JSON error envelope. Callers must not parse prose to identify the trust failure.

`dispatch()` currently returns a `TurnHandle`, so rejection needs an explicit synchronous result or a settled `rejected` outcome that adapters can translate without optimistic success. The implementation should choose the smallest compatible shape and make denied dispatch impossible to mistake for `queued` or `started`.

## Client behavior

### Deriving restricted state

Use the same repository lookup already used by `RepoTrustBanner`: resolve the route/session remote from `currentSession?.remoteUrl ?? newSessionRepoUrl`, normalize it consistently with the existing repo list, and treat `repo?.trusted === false` as untrusted. The pre-first-turn warm route must therefore disable the composer before the session graduates.

Unknown/hydrating state is security-neutral on the client because the server is authoritative. For UX, the implementation must avoid briefly enabling send for a known remote before its repo record loads; a remote whose trust state is not yet known should keep send disabled until resolved. No-remote/template sessions remain enabled because they are trusted by construction.

### Composer and explanatory UX

Pass the trust restriction into `MessageInput.disabled` in addition to its existing socket readiness condition. Keyboard submit and every send-button variant already respect `disabled`; tests must keep that contract.

Do not add a second consent control. The existing `RepoTrustBanner` and “Trust this repository” button remain the explanation and action. Update their copy to state that agent messages, install, and services remain blocked until trust. If the banner remains preview-only, the normal chat surface needs a small inline explanation adjacent to the disabled composer that points the user to the existing Trust surface without creating another Trust button; whether the banner itself should become visible from chat is an open product question below.

Client affordances outside the composer (review, answer, Create PR, send logs/errors, auto-fix) may still race or be invoked programmatically. They should either share a client-side `canMessageAgent` guard for clean UX or rely on rollback, but neither replaces server admission.

### Trust race and optimistic rollback

Trust state can change between render and click, and HTTP/programmatic surfaces optimistically append bubbles. Every optimistic sender must roll back on `repository_untrusted`:

- remove only the matching pending/optimistic bubble;
- clear loading/activity and any optimistic active-runner marker introduced by that send;
- clear a pending WS frame that has not yet flushed;
- retain the user's composer draft where practical; and
- show the stable explanatory error, without implying the agent ran.

`dispatch-agent-message.ts` already rolls back its pending HTTP bubble on any error. The WS `sendUserMessage` path currently has no equivalent rejection correlation, so the implementation needs a delivery/request ID or another precise rollback mechanism; do not pop “the last user message” without identity because another tab or send may have appended since.

Trust acceptance is authoritative only after the server response/SSE updates `RepoStore`. Do not optimistically enable sending on button click. If the trust request fails, `RepoTrustBanner` must leave the repository untrusted, restore its button state, and surface an error; its current `await` path needs `try/finally` so `trusting` cannot stick forever.

## Existing work and trust revocation

Verified fact: ShipIt currently exposes only a trust grant. There is no supported way to revoke a trusted repository, so existing running or queued work cannot encounter a trust-to-untrusted transition today.

This design does not invent revocation requirements. It does ensure queue drains and restart recovery re-check trust, so a later revocation feature will not automatically bypass the gate. Whether a future revoke action should interrupt a running turn or cancel already-queued work is an open product decision, not answered here. Until such a feature exists, this change blocks new turns for repositories that have never been trusted and leaves already-running work unchanged.

## Tests

### Server invariant

- Unit-test `dispatchOnRunner` for both runner implementations: untrusted, unknown remote, and missing authorizer all reject before `running`, steering, enqueue, settlement side effects, or `runDispatchedTurn`; trusted and no-remote sessions proceed.
- Assert an untrusted busy runner cannot call the resident agent's steering method and cannot grow its queue.
- Assert a queued/recovered entry whose authorization check denies at drain is dropped/settled once and does not start or loop.
- Assert the authorizer uses `sessionManager.get(runner.sessionId).remoteUrl` and `RepoStore.isTrusted`, not dispatch input.

### Transport and ordering

- WS `send_message`, `answer_question`, review/follow-up sends, and HTTP `/agent/dispatch` return the same stable `repository_untrusted` error.
- For an untrusted warm session, assert no graduation, branch rename, repo touch, naming, warm refill, transcript persistence, running flag, queue insertion, attachment disk read, or process creation.
- Exercise every production `runner.dispatch` ingress class with an untrusted remote, including CI/rebase/lifecycle wake, child/headless/quick-session turns, session report/message resume, bootstrap pending work, and turn adoption.
- Add a guard test or lintable structural assertion that interactive WS turns use `runner.dispatch` and that production code does not call the lower-level turn executor as an ingress.
- Confirm trusted remote and no-remote/template controls retain current behavior.

### Client

- `MessageInput` is disabled for an untrusted existing session and for `/{slug}/new` before warm-session graduation; it enables after authoritative trust state arrives.
- A known remote with unresolved trust data stays disabled without flashing enabled.
- The existing Trust surface explains the message restriction and remains the only consent action.
- Failed trust leaves send disabled, resets the button's busy state, and reports the failure.
- A server-side trust rejection rolls back the exact optimistic WS/HTTP bubble, loading/activity, active-runner optimism, and pending WS frame without deleting unrelated messages.
- No-remote and ShipIt-template sessions remain enabled.

### Regression and discovery

- Existing install/Compose trust-gate tests remain green.
- **Every integration fixture whose scenario runs an agent turn against a
  session with a remote must grant trust explicitly** —
  `repoStore.setTrusted(REPO_URL, true)` beside the existing
  `add()` / `setReady()` in its `beforeEach`. The gate is fail-closed, so a
  fixture that omits it fails at the first turn with "Trust this repository
  before sending messages to the agent", which surfaces far from the cause: as
  a 500 from `POST /api/sessions/:id/spawn`, a wake-turn that never delivers,
  or a `waitForClaude` timeout. The first pass covered the agent-driven PR,
  spawned-session, Ops fix-spawn, PR auto-create and quick-capture fixtures;
  `session-report`, `session-notify-on-merge`, `release-flow` and
  `warm-sessions` were missed and fixed after they went red on main.
- Run the docs navigator index and confirm this package is listed independently from docs/178 and the Agent Interface SDK package.

## Complexity challenge

The necessary mechanism is one runner admission check plus migration of the few interactive bypasses onto the existing dispatch funnel. The following are intentionally rejected:

- client-only disabling — it is not a security boundary;
- checks copied into WS, HTTP, SDK, and each system-turn caller — future ingress will miss one;
- a trust boolean carried in `PreparedDispatch` — caller-controlled and stale;
- a second trust store or SDK-owned policy — `RepoStore` already owns canonical per-remote trust;
- cancelling all current work — there is no current revoke transition and no requirement for it;
- persisting a special “blocked message” queue — rejected requests should not become turns later without a new user/programmatic dispatch.

After implementation, removing any route-specific client guard should worsen UX but must not weaken server security. Removing the single runner admission check should break the invariant tests across every ingress. That is the intended concentration of responsibility.

## Open product questions

1. Where should the explanatory trust surface appear when the user is on chat or another non-preview tab: move/mirror the existing banner into the central session view, or keep the consent in Preview and add a non-action explanation beside the disabled composer?
2. Should an AskUserQuestion answer control remain visible-but-disabled while untrusted, or be replaced by the same repository-trust explanation until trust is granted?
3. If trust revocation is added later, should it interrupt an already-running turn, cancel queued work immediately, or only reject subsequent admission/drain attempts?
4. Should a rejected programmatic/system turn be retried automatically after the user trusts the repository, or should its owning workflow settle as blocked and require a new trigger? The requirements only say messages are blocked until consent; they do not define deferred execution.

## Relationship to adjacent docs

- `docs/178-repo-trust-gate` remains the shipped trust-on-first-use design for install and Compose. This package supersedes only its “chat remains available while untrusted” decision and reuses its trust identity, persistence, and consent action.
- `docs/242-agent-interface-sdk` was named as a related consumer in the request but is not present in this checkout. When that package is available, it should reference this invariant and require SDK-created turns to use `runner.dispatch`; the trust design must not be merged into or duplicated by the SDK package.
- `docs/240-unlosable-turn-dispatch` and `prepared-dispatch.ts` supply the shared dispatch/queue machinery this design extends; they do not currently authorize repository trust.

## Implementation touchpoints (future production change)

- Server invariant: `session-runner.ts`, `container-session-runner.ts`, `runner-registry-factory.ts`, `prepared-dispatch.ts`.
- Interactive migration: `ws-handlers/send-message.ts`, `services/agent.ts`, lower-level turn execution/listener helpers.
- Trust resolution: `repo-store.ts`, `sessions.ts`, trust route/services.
- Client state and rollback: `App.tsx`, `MessageInput`, `RepoTrustBanner.tsx`, `send-user-message.ts`, `dispatch-agent-message.ts`, connection/message handlers.
- Tests: co-located unit tests plus WS/HTTP integration tests, warm-session first-turn coverage, and all direct dispatch consumers named in the ingress inventory.
