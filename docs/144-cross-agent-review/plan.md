---
status: planned
priority: medium
description: Pin one agent as the session's primary but let the user invoke the other agent for a one-shot, read-only review of the current diff — inline in the same chat.
---

# 144 — Cross-agent review

## Summary

Today a session is locked to a single agent for life (docs/138). That gives us
clean credential isolation, predictable commit attribution, and a coherent
post-turn flow — but it also means a user who codes with Claude cannot get a
second opinion from Codex (or vice versa) without spinning up a separate
session, re-cloning, re-explaining context, and round-tripping the result
themselves.

This doc proposes keeping the primary-agent pin exactly as it is, and adding a
**chat-driven, one-shot, read-only review** primitive that invokes the *other*
agent against the current diff. The reviewing agent never becomes the session's
agent. It can't edit files, can't commit, and doesn't take over the runner. Its
output appears inline in the chat as a review message, threaded into the same
session.

The primitive composes with docs/125 (chat-native AI review) — that work already
established the `submit_review_comments` MCP tool and the "ask the agent to
review" composition path. Cross-agent review is a generalization: instead of
spawning the *primary* agent as the reviewer, spawn the *other* agent.

## Motivation

Different model families have different strengths on different code. Users
already do this manually — they paste a diff into a second tool and ask "what
did I miss?" — and the principle (§1, §2) is that the workflow should happen
inside ShipIt instead of routing them out.

The current pin (docs/138) is the right default: it makes the session legible.
But it shouldn't preclude a structured "ask the other one" affordance, which
is what good engineering teams do informally every day.

## Non-goals

- **Per-turn agent switching.** Alternating agents turn-by-turn breaks commit
  attribution, post-turn auto-push, the chat history's mental model, and the
  guarantees docs/138 was built to provide. Pin one. The other is a tool, not a
  co-driver.
- **Cross-agent editing.** The reviewing agent is read-only. If the user wants
  the review's suggestions applied, the *primary* agent applies them in a normal
  follow-up turn. This keeps every file write attributed to the pinned agent.
- **Multi-agent orchestration / "agent A then agent B then agent A".** Out of
  scope. The primitive is a single review pass, model-invocable, single result.
- **Replacing the existing intra-agent review (docs/125).** That stays. When the
  user wants the *primary* to review (cheaper, same context), they still get it.
  Cross-agent is opt-in for when they want a different model's eyes.

## Current architectural constraints

The constraints we have to work with:

- **Per-session credential isolation (docs/138).** A Claude session's container
  never has `.codex` on disk, and a Codex session never has `.claude`.
  `provisionAgentCredentials()` (`session-credentials.ts`) is *write-once* on
  first turn, copying only the pinned agent's subtree.
- **Single agent per runner.** `ContainerSessionRunner` has one `_agentId` and
  one `_agent` field; `ProxyAgentProcess` is identified by a single `agentId`.
  The session worker runs one agent at a time.
- **`set_agent` is locked after pinning.** `index.ts` rejects a switch to a
  different agent once `agentPinned` is set. This stays.
- **First-turn agent resolution.** The agent is chosen from
  `ctx.activeAgentId()` and the runner's `_agentId` is set then; subsequent
  turns always use the pinned agent.

## Design

The whole feature decomposes into three orthogonal changes:

### 1. Provision *all authed* agents' credentials, not just the pinned one

`provisionAgentCredentials()` currently copies only `AGENT_CREDENTIAL_PATHS[agentId]`
into the session's per-session credentials dir. Change it to also copy *every
other agent's* subtree the user has authed with — gated on
`AgentRegistry.getAuthStatus(agentId)` reporting an authenticated state for
that other agent.

Concretely:

- The pin still happens (docs/138 stays). The pinned agent's subtree lands as
  before.
- For each other registered agent that has an authed credential at the source
  root, copy its subtree too. (So a Claude-primary session with Codex authed
  ends up with both `.claude/` and `.codex/` in `/credentials`; a Claude-only
  user is unchanged from today.)
- This is *additive* — it only relaxes docs/138's guarantee in the case where
  the user has explicitly authed both agents and a cross-agent review is
  therefore possible at all. The user-facing isolation invariant becomes:
  *"a session container only ever holds credentials for agents the user has
  themselves logged into,"* which is what they'd reasonably expect.
- **Activation-time top-up.** Today provisioning is purely write-once at first
  turn, so a user who authes the second agent *after* a session has started
  would never see the new creds land. Add a cheap top-up step on session
  activation that re-runs the *cross-agent* portion of provisioning (never
  re-touches the pinned agent's subtree — the CLI writes to it in place and we
  don't want to clobber). This is a small extension of the existing per-turn
  token-sync code path in `session-credentials.ts`.

### 2. A new "review job" primitive in the orchestrator

The existing `runAgentWithMessage` flow ties an agent invocation to *the
session's pinned agent*. Cross-agent review needs a sibling primitive that
takes the target agent as a parameter and runs a constrained, short-lived
invocation against the current diff.

Shape:

- **Endpoint:** WS message `start_review_with` (or a slash command — see §3),
  parameters `{ reviewerAgentId: AgentId, scope?: "branch" | "uncommitted" }`.
- **Server entry point:** a new function in `services/reviews.ts` (or alongside
  it) — `runCrossAgentReview({ sessionId, reviewerAgentId, scope })` — that:
  1. Verifies `reviewerAgentId` is registered, authed, and **different from**
     the session's pinned agent. Reject otherwise with a typed error message
     that the UI can render gracefully ("Codex is not signed in").
  2. Resolves the diff text (reuse the existing diff service that powers the
     diff panel — no new git plumbing needed).
  3. Spawns the reviewer through the same `ProxyAgentProcess` machinery as the
     primary, but with `agentId = reviewerAgentId`, a constrained system prompt
     ("review-only: you may not edit files, you may not commit; submit findings
     via `submit_review_comments`"), and the diff pre-loaded into the prompt.
  4. Wires the reviewer's events into the chat history as a dedicated
     **review message group** (distinct visual treatment so the user can see
     "this turn came from Codex, not from your primary agent"). The grouping
     follows the same tool-result boundary rules as normal turns
     (`agent-listeners.ts`).
  5. Persists the resulting comments through the existing
     `submit_review_comments` path (docs/125) so the unified review surface
     (docs/112) shows them like any other AI review.
  6. **Does not** trigger the post-turn flow (no auto-commit, no auto-push, no
     PR card update). Cross-agent review is purely advisory.
- **Concurrency:** the reviewer runs *alongside* the primary if the primary is
  mid-turn? Or is it queued? Recommendation: queue it. The session worker runs
  one agent at a time today (single PTY, single agent process), so the simplest
  correct behavior is "wait until the primary's turn finishes, then run the
  review." Surface the queued state in the chat as a pending bubble.

### 3. UX entry points

Two surfaces, both following CLAUDE.md §5 (chat is the input, agent is the
actor):

- **Primary: chat-driven.** The user types `/review-with codex` (or
  `/review-with claude`) — a new slash command in the registry
  (docs/132). The composer expands this into a `start_review_with` WS
  message. This is the on-ramp the principles favor: no new button surface, no
  category mistake (§5).
- **Secondary: contextual shortcut.** The existing "Ask agent to review" button
  in the file-preview modal (docs/125) grows a small overflow / split-button
  affordance — e.g. a chevron that opens "Review with Claude" / "Review with
  Codex" when both are authed. Single button (no chevron, no menu) when only
  the primary is authed — i.e. exactly today's behavior. The shortcut composes
  the same WS message; the button is not a separate action surface, just an
  alternate composition path for the modal's draft state (the same reasoning
  docs/125 used to keep that button at all).

The agent picker / model selector stays as-is — it's about the *pinned*
session agent, which is still write-once after turn 1.

### 4. Usage attribution

Review turns burn the user's *reviewer* agent quota, not the primary's. The
existing `UsageManager` keys cost by agent already; the new path just needs to
make sure it records cost against `reviewerAgentId`, not the runner's pinned
`agentId`. Surface the breakdown in the existing usage UI so it's clear which
agent spent what.

## Touchpoints

- **`session-credentials.ts`** — `provisionAgentCredentials()` grows a
  cross-agent copy pass (gated on `AgentRegistry` auth state for each other
  agent). New `topUpCrossAgentCredentials()` called on session activation when
  the cross-agent auth state has changed since the last provision.
- **`AgentRegistry`** — already exposes per-agent auth state; no API change
  needed, but the new code consumes it from inside the orchestrator's
  credential-provisioning path.
- **New `services/cross-agent-review.ts`** (or extend `services/reviews.ts`) —
  `runCrossAgentReview()`. Composes diff + reviewer agent + constrained system
  prompt; spawns via `ProxyAgentProcess`; wires events into chat history;
  pipes comments through `submit_review_comments`.
- **New WS message `start_review_with`** — `ws-client-messages.ts` +
  `ws-server-messages.ts` (for the result events) + a handler in
  `ws-handlers/` (likely a new `cross-agent-review.ts` to keep it isolated
  from the primary `send-message.ts` path). See the `add-endpoint` skill.
- **Slash command registry** — register `/review-with`. Tab completion offers
  only currently-authed-and-different agent ids.
- **`AgentPicker` / file-preview modal** — split-button affordance when the
  user has two authed agents; otherwise unchanged.
- **`UsageManager`** — confirm cost recording handles a `reviewerAgentId`
  distinct from the runner's `agentId`. Likely a small parameter plumbing
  change.
- **Chat history rendering** — a new message-group "kind" for cross-agent
  review so it's visually distinct ("Codex review" header on a Claude-primary
  session). The existing tool-result boundary logic (`agent-listeners.ts`) is
  the right place to anchor the group.
- **Integration tests** — `integration_tests/cross-agent-review.test.ts` with
  fakes for both agents and a scripted diff; assert read-only enforcement
  (the reviewer cannot trigger `submit_file_edit` or commit), correct chat
  history grouping, correct usage attribution, no post-turn side effects.

## Open questions

- **Constrained system prompt vs. tool allowlist.** Should "review-only" be
  enforced by prompting alone, or by stripping write tools from the reviewer's
  allowed tool list at spawn time? Allowlist is the safer answer — prompt
  enforcement is a strong norm but not a guarantee. Both agents' adapters
  already support tool restriction; verify which subset is the right one to
  expose to a reviewer.
- **Branch scope vs. uncommitted scope.** Default to reviewing the uncommitted
  + most-recent-commit diff (matches what the user just did and is what
  docs/125 reviews today), with `scope: "branch"` for a full branch review on
  request.
- **What happens if the user cross-agent-reviews on turn 0** (before the
  primary pin)? Easiest answer: reject until the session is pinned, because
  before then there isn't a diff to review and the chat history doesn't yet
  have a coherent agent identity to render the result against. Verify this
  matches the UI's natural flow — likely yes, since the entry points only
  appear once there's something to review.
- **Should the reviewer's MCP tool surface be the same `submit_review_comments`
  bridge docs/125 built, or a separate one?** Recommendation: reuse it. Same
  payload shape, same allow-listing logic, same write-back path through the
  orchestrator. The reviewer agent just doesn't get write tools.
- **Auth-state drift during a session.** If the user *signs out* of the
  reviewer agent mid-session, do we leave the now-orphaned credentials in the
  per-session dir until the container is recycled? Probably yes — the
  activation-time top-up is the natural cleanup point and forcing a mid-session
  scrub buys little. Document it as a known limitation in line with docs/138's
  similar `.gitconfig` token-freshness caveat.

## Out of scope

- A general "co-pilot two agents on every turn" mode — see Non-goals.
- Removing or relaxing the docs/138 isolation guarantee for users who have only
  authed one agent. They see no change.
- Cross-agent *editing*. Out of scope, by design.
