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
agent against the current branch diff. The reviewing agent never becomes the
session's agent. It can't edit files, can't commit, can't take over the runner,
and its credentials are wiped from the container the moment the review finishes.
Its output appears inline in the chat as a review message, threaded into the
same session.

The primitive composes with docs/125 (chat-native AI review) — same review
modal, same chat history surface — but uses a **separate** MCP write-back tool
(`submit_diff_review`) because docs/125's `submit_review_comments` is allow-
listed per single open file via `runner.activeReviewFilePath`, and cross-agent
review writes against a *set* of files.

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
  the review's suggestions applied, the *primary* agent applies them in a
  normal follow-up turn. This keeps every file write attributed to the pinned
  agent.
- **Multi-agent orchestration / "agent A then agent B then agent A".** Out of
  scope. The primitive is a single review pass, model-invocable, single
  result.
- **Concurrent execution of primary and reviewer.** The worker has one agent
  slot (`session-worker.ts` 409s a second `/agent/start`); doubling that slot
  is more work than this feature is worth in v1. Reviews queue.
- **Replacing the existing intra-agent review (docs/125).** That stays. When
  the user wants the *primary* to review (cheaper, same context), they still
  get it. Cross-agent is opt-in for when they want a different model's eyes.

## Current architectural constraints

Confirmed by reading the code, not extrapolated:

- **Per-session credential isolation (docs/138).** A Claude session's container
  never has `.codex` on disk, and a Codex session never has `.claude`.
  `provisionAgentCredentials()` (`session-credentials.ts`) is *write-once* on
  first turn, copying only the pinned agent's subtree.
- **One agent process per worker.** `session-worker.ts` returns 409 on a second
  `/agent/start` while `this.agent` is non-null. The orchestrator must
  serialize.
- **One agent slot per runner, SSE has no agent identifier.**
  `ContainerSessionRunner` has a single `_agent: ProxyAgentProcess | null` and
  the SSE event handler (`handleSSEEvent`) demuxes every `agent_event`/`done`/
  `error`/`auth_required`/`log` straight onto that one field. Swapping
  `_agent` mid-stream or running two would silently route reviewer events into
  the primary's accumulators (`accumulatedText`, `chatMessageGroups`,
  `turnSummary`).
- **`set_agent` is locked after pinning.** `index.ts` rejects a switch to a
  different agent once `agentPinned` is set. This stays.
- **First-turn agent resolution.** The agent is chosen from
  `ctx.activeAgentId()` and `runner._agentId` + `agentPinned` are set then;
  subsequent turns always use the pinned agent.

## Design

Four orthogonal pieces. The first three are load-bearing; the fourth is UX.

### 1. Lazy, scoped, post-review-wiped cross-agent credentials

The previous draft of this doc proposed eagerly provisioning *all* authed
agents' subtrees at first turn. That's a meaningful security regression for
exactly the dogfood/power-user population most likely to have valuable creds:
under docs/138 today, a supply-chain compromise of the Claude CLI inside a
container can only exfiltrate `.claude`; eager provisioning would also expose
`.codex` in every session where the user had both authed, regardless of
whether they ever asked for a cross-agent review. **Doubling the blast radius
unconditionally is not acceptable for a feature most users will never invoke.**

The replacement is lazy, scoped, and reversible:

- **Lazy.** The other agent's subtree is provisioned *only* the first time the
  user invokes `/review-with <agent>` in a given session. Pre-review,
  per-session credential isolation holds exactly as docs/138 specifies.
- **Just-in-time, just-before-spawn.** `runCrossAgentReview` calls a new
  `provisionReviewerCredentials(credentialsRoot, sessionId, reviewerAgentId)`
  synchronously before the worker `/agent/start`. The function copies *only*
  `AGENT_CREDENTIAL_PATHS[reviewerAgentId]` plus a refresh of the token-sync
  files; it must never touch `AGENT_CREDENTIAL_PATHS[pinnedAgentId]` (would
  clobber the CLI's in-place writes per docs/138 §"write-once").
- **Wiped on review completion.** The companion
  `removeReviewerCredentials(credentialsRoot, sessionId, reviewerAgentId)` runs
  in a `finally` after the review ends (success, failure, crash, or user
  cancel). It deletes only the reviewer's subtree from the per-session dir.
  The pinned agent's subtree is untouched.
- **Cumulative reviews skip re-copy if creds were re-provisioned since the
  last wipe** (it costs nothing to re-copy, but a guard avoids spurious
  filesystem churn during a queued sequence of reviews).
- **The activation-time top-up from the previous draft is deleted.** It's
  obsolete under lazy provisioning, and was the source of the activation /
  first-turn race the previous reviewer flagged.
- **Wipe is best-effort.** The reviewer CLI may still be flushing writes to
  its subtree (e.g. an exit-time token refresh) at the instant we `rm -rf`
  it. That's tolerable: any interrupted write is the reviewer's *own*
  transient state, and the next `provisionReviewerCredentials` re-copies
  cleanly from the orchestrator's source-of-truth. The pinned agent's
  subtree is never touched by either path.
- **Sign-out propagation.** When the user signs out of an agent
  (`AgentRegistry` emits a sign-out for `agentX`), the orchestrator runs
  `removeReviewerCredentials(root, sid, agentX)` for every session where
  `agentX` is *not* the pinned agent — sweeping any in-flight cross-agent
  creds that would otherwise outlive the user's authorization. Cheap loop;
  no-op for sessions that never invoked cross-agent review.
- **Codex review MCP config provisioning.** For a Codex reviewer in a
  Claude-pinned session, the per-session `.codex/config.toml` needs the
  `[mcp_servers.shipit-review]` block (same registration docs/125 wrote
  via `ensureCodexReviewMcpConfig`) so the reviewer can call
  `submit_diff_review`. Under docs/138's symlink scheme `~/.codex/` in the
  container resolves into the per-session credentials subtree, so the
  append lands inside the wipe scope: the block is added in the same step
  as `provisionReviewerCredentials` and is removed along with the rest of
  `.codex/` on review completion — no special cleanup path needed.

Net guarantee: docs/138's invariant is preserved word-for-word *except* during
the lifetime of an in-flight `/review-with` invocation, and the relaxation is
gated on an explicit user action.

### 2. ReviewerSession: a separate accumulator alongside the primary runner

The runner cannot multiplex two agent processes onto its single `_agent` field
and single accumulator set. The design instead introduces a `ReviewerSession`
that lives on the runner but owns its own state and its own listeners:

```
ContainerSessionRunner
  _agent: ProxyAgentProcess | null            // primary, unchanged
  _agentId: AgentId                            // pinned, unchanged
  reviewer: ReviewerSession | null             // NEW
```

`ReviewerSession` carries:

- `reviewerAgentId: AgentId` — the *other* agent.
- `proxyAgent: ProxyAgentProcess` — distinct instance, constructed with
  `reviewerAgentId`.
- `accumulator: ReviewerAccumulator` — separate `accumulatedText`,
  `messageGroups`, comments staging. Never written into the runner's primary
  accumulators.
- `costRecorder` — records usage against `reviewerAgentId`.
- `cancel(): Promise<void>` — calls `/agent/interrupt` and resolves
  `runner.reviewer = null`.

**Event demux: swap `runner._agent` for the duration.** The orchestrator's
existing SSE handler dispatches on `this._agent.emit(...)` — there is no
agent identifier on the SSE event itself, and threading one through would
mean a worker protocol change plus a message-shape change. Instead, exploit
strict serialization (§3): while a reviewer is running, *replace* the
runner's `_agent` slot with the reviewer's `ProxyAgentProcess`, restore the
primary's slot on cleanup. Concretely:

- `runCrossAgentReview` saves `prevPrimary = runner._agent` (almost always
  `null`, since the queue ensures the primary is idle first), assigns
  `runner._agent = reviewer.proxyAgent`, runs the invocation, awaits
  completion **and SSE drain**, then restores `runner._agent = prevPrimary`
  inside the `finally`.
- A companion field `runner.activeInvocation: "primary" | "reviewer" | null`
  is set/cleared at the same boundaries. It exists for UI (the queued-state
  bubble, disabling the composer's "send" affordance during reviewer
  execution) and for the dispose guard (§3) — *not* for SSE routing, which
  is naturally handled by the swap.
- **SSE drain is awaited in cleanup.** The SSE stream is owned by the
  *runner* (`ContainerSessionRunner.handleSSEEvent`), not the proxy —
  `ProxyAgentProcess` is a thin event-relay with no SSE awareness. Late
  reviewer events (`agent_log`, `auth_required` retries arriving after
  `agent_done`) therefore drain through the runner's SSE handler, not the
  proxy. `runCrossAgentReview` awaits the reviewer proxy's terminal event
  AND a runner-level drain (a new `runner.drainSse(): Promise<void>` that
  resolves once the SSE handler has no in-flight events for a short
  quiescence window) before swapping `_agent` back and running the wipe.
  Without the drain, a late reviewer event would arrive after the swap and
  emit on the restored primary proxy, corrupting primary accumulators —
  exactly the bug round 2 of review caught. The drain hook is load-bearing.

The worker stays oblivious — it just runs one agent at a time, exactly as
today.

**Message-group persistence.** `ReviewerAccumulator` flushes into
`ChatHistoryManager` as message groups with `kind: "cross-agent-review"` and
`reviewerAgentId`. They are appended *after* whatever the most recent
primary group was when the review completed. UI renders them with a header
("Codex review" / "Claude review") and a distinct chrome so the user can never
mistake reviewer output for primary output.

**No post-turn side effects.** `runCrossAgentReview` never calls
`postTurnCommit`, `scheduleAutoPush`, or `emitPrLifecycleCard`. The pin-skip
rule is explicit: the reviewer code path *never* touches
`session.agent_pinned` or `session.agent_id`. The pinning logic is structurally
in `runAgentWithMessage` (which the reviewer path does not call), so the
guarantee falls out of the call-graph rather than a runtime check.

### 3. Strict-sequential queue

The runner gains a `reviewQueue: ReviewerJob[]`. Ordering is FIFO across
primary turns and reviewer jobs both:

| Event | Behavior |
|---|---|
| Primary idle, user runs `/review-with X` | Reviewer starts immediately. |
| Primary mid-turn, user runs `/review-with X` | Reviewer job enqueued. UI shows a pending bubble: "Codex review queued — waiting for current turn." |
| Reviewer mid-execution, user sends a primary message | Primary message enters the existing `runner.messageQueue`. Drained after the reviewer finishes. |
| Reviewer mid-execution, user runs another `/review-with X` | Second reviewer job enqueued behind the first. |
| User cancels (existing stop button) | `/agent/interrupt` to whichever invocation is active. If `activeInvocation === "reviewer"`, the cleanup of §1 still fires. **The queue is preserved** — cancel acts on the current invocation only, matching today's "cancel the current turn" semantics. A queued primary message behind a cancelled reviewer drains as normal; a queued reviewer behind a cancelled primary drains as normal. The user did not ask to abandon queued work, only to skip the current invocation. |
| Reviewer crashes (worker error, OOM, timeout) | `runCrossAgentReview` catches, surfaces an error message in chat with `kind: "cross-agent-review-error"`, runs cleanup, processes the next queued job. |
| Reviewer takes a long time | Soft cap of **N minutes wall-clock** and **M tokens output** (initial values: 5 min, 8K output tokens; tunable). Hitting either truncates with a system note ("Review cut short at 8K tokens"). The hard reasoning: a runaway reviewer prompt could otherwise read the entire repo to "understand the diff" and burn the user's quota with no ceiling. |

Queue ownership lives on the runner (not in a global manager). The dispose
guard must protect reviewer invocations from idle eviction the same way it
protects primary turns: change the guard from `_isRunning && !force` to
`(activeInvocation !== null || reviewQueue.length > 0) && !force`. Without
this, idle eviction (60s grace, see container-session-runner) could kill a
container mid-reviewer-execution — credentials un-wiped, reviewer output
lost, queued primary messages lost. Queued reviews and the active invocation
both pin the runner alive; on `{ force: true }` disposal (archive, full
reset) the queue is dropped and the credential wipe still runs in `finally`.

### 4. Tool-allowlist enforcement of read-only

System prompt instructions are necessary but not sufficient. The reviewer's
agent process is spawned with an *explicit per-spawn allowlist*. This
parameter **does not exist today** — `AgentCapabilities.toolNames` is a
static capability advertisement (the full set of tools the CLI exposes), and
`AgentRunParams` has no `allowedTools` field. The feature requires plumbing
a new optional `allowedTools?: string[]` parameter end-to-end:

1. `AgentRunParams.allowedTools?: string[]` on the type.
2. `ProxyAgentProcess.run` forwards it in the `/agent/start` body.
3. The worker passes it to each adapter's `.run()`.
4. Each adapter translates it to the CLI's flag (Claude:
   `--allowedTools`; Codex: the equivalent, confirm at implementation
   time).
5. **Worker-side enforcement for *our* MCP tools.** The CLI's
   `--allowedTools` flag governs the agent's built-in tools. The orchestrator
   additionally enforces, on the `/review-submit-diff` route (§5), that the
   caller's runner is in the reviewer-active state. The symmetric guard on
   `/review-submit` (docs/125) hard-rejects calls from a reviewer
   invocation. Belt and suspenders.

The read-only subset per agent (exact tool names verified against each
adapter's current capability list at implementation time):

- **Claude reviewer:** `Read`, `Glob`, `Grep`, plus `submit_diff_review`. No
  `Bash` for v1 (the diff is in the prompt; if a reviewer needs `git log` of
  a specific file, that's a v2 enhancement). No `Edit`, no `Write`, no
  `Task`. Enforced by `claude --allowedTools <subset>` at spawn — a
  real allowlist primitive in the CLI today.

**Codex asymmetry — symmetric ship, asymmetric enforcement.** Codex's CLI
(`codex app-server`) has **no per-spawn tool-restriction flag** today. The
worker-side MCP guard rejects ShipIt's *own* MCP tools
(`submit_review_comments` from a reviewer; `submit_diff_review` from a
primary) but does NOT prevent Codex's built-in `file_write` / `file_edit` /
`shell` tools from firing — those are CLI built-ins, not MCP. For Codex
*as the reviewer*, the read-only guarantee therefore degrades to:

- **Strong system prompt** that explicitly forbids edits, commits, and
  shell-based mutations.
- **Worker MCP guard** on the two ShipIt tools (intact).
- **No CLI-level write-tool block.** A misbehaving Codex reviewer *could*
  call `file_edit` and the worker would not prevent it.

**V1 decision: ship symmetric with prompt-only enforcement for Codex.** A
Codex reviewer in a Claude-pinned session is allowed in v1, with the
asymmetry surfaced in user-facing copy on the `/review-with codex`
affordance — verbatim suggestion: *"Codex review is advisory. Codex may,
against instructions, attempt to edit files; commits and pushes are still
blocked by the no-post-turn-flow rule."* This is the right call given the
dogfood population: most users who care about cross-agent review have both
authed, and shipping Claude-only would cut the feature in half for Codex-
pinned users specifically. Tighten to symmetric CLI-level enforcement in
v2 once Codex grows the primitive, or earlier if a misbehaving reviewer
becomes a real failure mode.

The "no sub-subagents from a reviewer" rule is enforced by the allowlist
itself (omitting `Task` for Claude). For Codex, `spawn_agent` falls into the
same prompt-only bucket.

### 5. `submit_diff_review`: a sibling, not a reuse, of `submit_review_comments`

Docs/125's `submit_review_comments` MCP tool gates the write-back on
`runner.activeReviewFilePath` — a single file path set by the modal opening
that file. Cross-agent review writes against a *set* of files (the diff), so
reusing that tool would either require generalizing the allow-list to a set
(touching docs/125's WS-reconnect-safe allow-list lifecycle) or accepting an
allow-list bypass for cross-agent.

Add a parallel tool *and* a parallel orchestrator route — concretely sibling,
not dispatch-on-tool-name on one route:

- **MCP tool name:** `submit_diff_review`.
- **Registration:** added to the existing `mcp-review-bridge.ts` as a second
  exposed tool alongside `submit_review_comments`. Same Unix socket / HTTP
  bridge plumbing, same lifecycle. Both Claude (per-run `mcpConfigPath`) and
  Codex (`ensureCodexReviewMcpConfig` appending to `~/.codex/config.toml`)
  pick up the new tool with no protocol change.
- **Payload:** `{ comments: [{ filePath, anchor, body, severity }, ...] }`.
  Anchors follow docs/125's anchoring rules.
- **Orchestrator route:** `POST /review-submit-diff` (sibling of docs/125's
  `/review-submit`). Bridge forwards to worker which forwards to
  orchestrator, mirroring docs/125's three-hop relay exactly.
- **Authorization:** valid only when `runner.activeInvocation === "reviewer"`
  and the caller's `agentId` matches `runner.reviewer.reviewerAgentId`. Both
  fields are server-side; the agent cannot spoof them. The docs/125
  `/review-submit` route adds a symmetric guard rejecting calls when
  `activeInvocation === "reviewer"`.
- **Persisted comments:** `source: "ai"`, `reviewerAgentId` recorded on each
  comment so the unified review surface (docs/112) can attribute them.

Two routes, two tools, no shared mutable state — keeps docs/125's
WS-reconnect-safe allow-list lifecycle untouched.

### 6. UX: slash command only

`/review-with <agent>` is the single entry point for v1.

- **Slash command registry** (docs/132) gains `/review-with`. Tab completion
  enumerates agents that are (a) authed and (b) not the pinned agent. If no
  agent qualifies, the command is hidden.
- **AgentRegistry refresh.** The registry caches per-agent auth state from
  boot. Before offering `/review-with` in the completion list, the composer
  triggers `AgentRegistry.refreshAuth(otherAgentId)` (or relies on a periodic
  refresh that already exists — verify). Stale "Codex is signed in" claims
  that resolve to a 401 at spawn time should be a rare race, not a routine
  failure.
- **No split-button in the file-preview modal.** The previous draft proposed
  one; the reviewer correctly flagged it as a creeping per-action agent
  picker that quietly duplicates the session-level pin's purpose, and the
  docs/125 carve-out for that button rested on draft-state composition which
  doesn't apply here. Removed.
- **Turn-0 behavior.** `/review-with` is rejected before the session is
  pinned. There is no diff to review and no coherent primary identity for the
  reviewer's output to render against. Naturally surfaced by the completion
  filter (a session that hasn't pinned has no other-agent-to-pin-against
  yet), but the server also enforces it.

### 7. Default review scope: branch diff vs. base

The previous draft suggested defaulting to uncommitted + most-recent commit,
"matching docs/125." That comparison is wrong: docs/125 reviews a single open
file. Cross-agent review's value proposition is "second opinion on the work
I'm about to ship," which is the branch diff against its base. Default to
that.

- **Default:** `scope: "branch"` — diff of `HEAD` vs. `mergeBase(HEAD, baseBranch)`.
- **Opt-in:** `/review-with codex uncommitted` for working-copy-only review.
- **Token cap.** Diffs larger than the per-review token cap (§3) are
  truncated with a note. The reviewer gets the first N tokens of the diff
  plus a list of omitted file paths. (Future work: chunked review.)

## Usage attribution

`UsageManager` already keys cost by agent. Cross-agent review records cost
against `reviewerAgentId`, not the runner's pinned `agentId`. The existing
usage UI must surface the breakdown so the user can see which agent spent
what. No new column — just a separate row per agent in the existing
per-session usage view.

## Local / dogfood mode

Docs/138 notes that in `RUNTIME_MODE=local`, credential provisioning is a
no-op because the agent runs in-process and reads credentials straight from
the host. Cross-agent review in local mode therefore inherits both agents'
creds for free; the lazy-provisioning and wipe steps short-circuit
(`provisionReviewerCredentials` becomes a no-op in local mode, mirroring
docs/138's existing pattern). The rest of the design — queueing, tool
allowlist, `submit_diff_review` — applies identically. Document this in the
shipped plan.

## Touchpoints

- **`session-credentials.ts`** — add `provisionReviewerCredentials()` and
  `removeReviewerCredentials()` (lazy + scoped + reversible per §1). Delete
  the activation-time top-up from the previous draft.
- **`AgentRegistry`** — confirm `refreshAuth(agentId)` exists; if it doesn't,
  add it. The slash-command completion path calls it before listing.
  Additionally, `AgentRegistry` becomes an `EventEmitter` (it isn't today —
  this is a new public API) and emits `sign-out` (`agentId`) from the
  existing sign-out HTTP routes. `services/cross-agent-review.ts` subscribes
  to that event for the sign-out-propagation sweep (§1).
- **`AgentRunParams` / `ProxyAgentProcess` / worker `/agent/start` / each
  adapter** — add an optional `allowedTools?: string[]` parameter and thread
  it end-to-end into the CLI spawn args (Claude `--allowedTools`, Codex
  equivalent). This is **new plumbing**, not a reuse of existing capability
  data — `AgentCapabilities.toolNames` is a static advertisement, not a
  per-spawn restriction. The worker and orchestrator additionally enforce
  ShipIt's own MCP tools (`submit_diff_review` vs `submit_review_comments`)
  via the runner-state checks in §5.
- **`ContainerSessionRunner.drainSse(): Promise<void>`** — new method on the
  runner (NOT on `ProxyAgentProcess`; the SSE stream is owned by the runner,
  the proxy is a thin event-relay). Resolves once the SSE handler has had a
  short quiescence window with no in-flight events. `runCrossAgentReview`
  awaits this before swapping `runner._agent` back. Without it, late SSE
  events emit on the restored primary proxy and corrupt primary
  accumulators (§2).
- **New `services/cross-agent-review.ts`** — `runCrossAgentReview()`.
  Provisions creds; spawns reviewer via `ProxyAgentProcess`; constructs
  `ReviewerSession`; swaps `runner._agent` for the duration; wires events
  into the reviewer accumulator; awaits SSE drain; restores `_agent`; wipes
  creds in `finally`. Does not touch the primary turn or pinning.
- **`ContainerSessionRunner`** — adds `reviewer: ReviewerSession | null`,
  `activeInvocation: "primary" | "reviewer" | null`, and `reviewQueue`.
  Changes the dispose guard from `_isRunning && !force` to
  `(activeInvocation !== null || reviewQueue.length > 0) && !force` so
  reviewer-only execution and queued reviews pin the runner alive against
  idle eviction (§3).
- **New WS message `start_review_with`** — `ws-client-messages.ts` +
  `ws-server-messages.ts` (queued/started/done/error events) + handler in
  `ws-handlers/cross-agent-review.ts`. See the `add-endpoint` skill.
- **Slash command registry** — register `/review-with`. Completion filters by
  auth state + not-pinned-agent + session-is-pinned.
- **New MCP tool `submit_diff_review`** + new orchestrator route
  **`POST /review-submit-diff`** — sibling tool/route to docs/125's
  `submit_review_comments` / `/review-submit`. Registered in the existing
  `mcp-review-bridge.ts` (single bridge, two exposed tools). Distinct
  authorization rule: requires `runner.activeInvocation === "reviewer"`.
  The docs/125 route gains a symmetric guard rejecting reviewer-source
  calls. No shared mutable state with docs/125's allow-list lifecycle.
- **`UsageManager`** — confirm cost recording accepts a `reviewerAgentId`
  parameter distinct from the runner's `agentId`. Likely a small plumbing
  change.
- **Chat history rendering** — new message-group kinds
  `cross-agent-review` and `cross-agent-review-error`; queued-state bubble
  while a job is pending in the queue.
- **Integration tests** — `integration_tests/cross-agent-review.test.ts`
  covering:
  - Tool allowlist enforcement (reviewer spawned with `--allowedTools`
    excluding `Edit`/`Write`, and worker MCP guard rejects
    `submit_review_comments` from a reviewer invocation).
  - Authorization: a reviewer invocation cannot call
    `submit_review_comments`; a primary invocation cannot call
    `submit_diff_review`.
  - Queue ordering: primary mid-turn + reviewer-enqueue + primary-enqueue
    drains in FIFO.
  - Lazy provisioning + wipe: `.codex` does not exist in the per-session
    credentials dir before or after a `/review-with codex` run on a
    Claude-pinned session.
  - SSE-drain race: a late `agent_log` arriving after `agent_done` is
    consumed by the reviewer accumulator, not the (restored) primary's.
  - Crash path: reviewer process killed mid-review → error message in chat,
    `reviewer` is `null`, queue continues, creds wiped.
  - Cancel path: user-issued stop while reviewer is active → interrupt,
    creds wiped, queue drained or cancelled per UX decision.
  - Dispose guard: idle eviction does not kill a container with a queued or
    active reviewer.
  - Sign-out propagation: signing out of the reviewer agent wipes its
    subtree from sessions where it was provisioned for review.
  - Cost cap: synthetic 10K-token reviewer output truncated at the cap, note
    appended to the chat group.
  - No-post-turn-side-effects: no auto-commit, no auto-push, no PR card.
  - Local mode: review runs, provisioning helpers no-op.

## Security regression: named explicitly

For users who have authenticated *both* Claude and Codex, this feature
introduces windows during which a session container holds both agents'
credentials. The window is bounded — opened by `provisionReviewerCredentials`
immediately before reviewer spawn, closed by `removeReviewerCredentials` in
`finally` — but it exists.

Specifically: during that window, a compromise of *either* agent CLI's
process inside the container could exfiltrate *both* agents' tokens. Without
this feature, that compromise can exfiltrate one. The blast radius of a
single agent-CLI supply-chain compromise *doubles* for dual-authed users
during the review window.

The mitigation is the lazy + scoped + wiped design itself — the window
exists only on explicit user action and only for the duration of one review.
Users who never invoke `/review-with` see zero change from docs/138. Users
who do are making an informed tradeoff for the feature's value.

A fuller mitigation (separating credential storage per agent into distinct
on-disk locations the reviewer cannot read even while running, e.g. via an
egress broker) is the same broker work docs/138 explicitly punted as "out of
scope" — that decision still holds and is not re-opened here.

## Resolved decisions

The three product decisions the design surfaced have been made and are
baked into the sections above. Recorded here for traceability:

1. **Codex-as-reviewer in v1: ship symmetric with prompt-only
   enforcement.** See §4. User-facing copy on `/review-with codex` names
   the asymmetry. Tighten to CLI-level enforcement when Codex grows the
   primitive.
2. **Stop button cancels the current invocation only, preserves the
   queue.** See §3 queue table. Matches today's "cancel the current turn"
   semantics; queued work is the user's, not the agent's, and we don't
   discard it on a stop.
3. **No Bash for the Claude reviewer in v1.** See §4. The diff is in the
   prompt; `git log`-style read-only shell is a v2 enhancement if users
   hit the limit.

## Out of scope

- A general "co-pilot two agents on every turn" mode — see Non-goals.
- Cross-agent *editing*. Out of scope, by design.
- Concurrent (non-serialized) primary and reviewer execution — would require
  a second agent slot in the worker, SSE event tagging, and a second PTY.
  Not worth it for v1.
- Egress-broker mitigation of the dual-cred window — same out-of-scope as
  docs/138's matching "out of scope" item.
- Chunked / multi-pass review for diffs larger than the token cap. Truncate
  for v1, revisit if users hit the cap often.
