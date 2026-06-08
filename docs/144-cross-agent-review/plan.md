---
description: Globally-gated MCP tool that lets the primary agent ask the other agent for a one-shot, read-only review of the current branch diff — surfaced inline through the same chat history.
---

# 144 — Cross-agent review

## Summary

Today a session is locked to a single agent for life (docs/138). That gives
us clean credential isolation, predictable commit attribution, and a
coherent post-turn flow — but it also means a user who codes with Claude
cannot get a second opinion from Codex (or vice versa) without spinning up
a separate session, re-cloning, re-explaining context, and round-tripping
the result themselves.

This doc proposes keeping the primary-agent pin exactly as it is, and
adding a **chat-driven, one-shot, read-only review** primitive that
invokes the *other* agent against the current branch diff. The reviewing
agent never becomes the session's agent. It can't edit files, can't
commit, can't take over the runner, and its credentials are wiped from the
container the moment the review finishes.

Mechanism: a new MCP tool `request_cross_agent_review`, exposed to the
**primary** agent. The primary calls it the same way it calls `Read` or
`Bash`; the worker spawns the reviewer CLI as a subprocess outside its
agent slot; the reviewer runs to completion and returns its comments
synchronously as the tool result; the primary continues its turn with the
review in hand. The user invokes the feature by saying it ("review with
Codex", "get a second opinion on this from Claude") — chat is the input
surface (CLAUDE.md §5), the primary is the actor.

The whole feature is gated behind a single global setting
(`enableCrossAgentReview`, default off). Sessions belonging to users who
haven't enabled it behave exactly like docs/138 today — no tool exposed,
no credentials provisioned, no behavior change.

The primitive composes with docs/125 (chat-native AI review) — same
review surface for comments — but uses a **separate** MCP tool
(`submit_diff_review`) because docs/125's `submit_review_comments` is
allow-listed per single open file, and cross-agent review writes against
a *set* of files.

## Motivation

Different model families have different strengths on different code.
Users already do this manually — they paste a diff into a second tool and
ask "what did I miss?" — and the principle (§1, §2) is that the workflow
should happen inside ShipIt instead of routing them out.

The current pin (docs/138) is the right default: it makes the session
legible. But it shouldn't preclude a structured "ask the other one"
affordance, which is what good engineering teams do informally every day.

## Non-goals

- **Per-turn agent switching.** Alternating agents turn-by-turn breaks
  commit attribution, post-turn auto-push, the chat history's mental
  model, and the guarantees docs/138 was built to provide. Pin one. The
  other is a tool, not a co-driver.
- **Cross-agent editing.** The reviewing agent is read-only. If the user
  wants the review's suggestions applied, the *primary* agent applies
  them in a follow-up turn. This keeps every file write attributed to the
  pinned agent.
- **Multi-agent orchestration / "agent A then agent B then agent A".**
  Out of scope. The primitive is a single review pass, model-invocable,
  single result.
- **A second agent slot on the worker.** The existing `/agent/start` slot
  stays single-occupant. The reviewer runs through a *different* worker
  endpoint (`/review/start`) that spawns a plain subprocess, outside the
  slot machinery.
- **A slash command for review.** The primary agent recognizes the user
  saying "review with codex" and calls the MCP tool itself. Adding a
  `/review-with` command would duplicate the natural-language path with
  a parallel command surface, contrary to §5.
- **Replacing the existing intra-agent review (docs/125).** That stays.
  When the user wants the *primary* to review (cheaper, same context),
  they still get it. Cross-agent is opt-in for when they want a
  different model's eyes.

## Current architectural constraints

Confirmed by reading the code, not extrapolated:

- **Per-session credential isolation (docs/138).** A Claude session's
  container never has `.codex` on disk, and a Codex session never has
  `.claude`. `provisionAgentCredentials()` (`session-credentials.ts`) is
  *write-once* on first turn, copying only the pinned agent's subtree.
- **One agent process per worker slot.** `session-worker.ts` returns 409
  on a second `/agent/start` while `this.agent` is non-null. The
  reviewer therefore cannot share the slot — it spawns as a parallel
  subprocess through a new endpoint that doesn't touch `this.agent`.
- **One agent slot per runner, SSE has no agent identifier.**
  `ContainerSessionRunner` has a single `_agent: ProxyAgentProcess | null`
  and the SSE event handler routes everything onto that field. Critical
  consequence for this design: the reviewer must NOT emit events into
  that SSE stream, or it will corrupt the primary's accumulators. The
  worker subprocess approach (§3) sidesteps this entirely by returning
  the reviewer's output synchronously over HTTP, not over SSE.
- **`set_agent` is locked after pinning.** `index.ts` rejects a switch to
  a different agent once `agentPinned` is set. This stays.
- **First-turn agent resolution.** The agent is chosen from
  `ctx.activeAgentId()` and `runner._agentId` + `agentPinned` are set
  then; subsequent turns always use the pinned agent.

## Design

Seven pieces. The first two are the new architectural ideas; the rest is
how each load-bearing concern (credentials, write-back, allowlist, cost,
scope, mode handling) settles under that architecture.

### 1. Global setting: `enableCrossAgentReview`

A single user-level setting in the existing settings store, default
**false**. Surfaced in the settings panel under a heading like
"Multi-agent sessions" with copy explaining: *"Allow the primary agent in
a session to consult the other agent for a one-shot, read-only review.
Enabling this means a session container can briefly hold credentials for
both agents during a review."*

When the setting is **off** (default):

- The `request_cross_agent_review` MCP tool is **not registered** on the
  bridge for any session. The primary cannot call it because it doesn't
  exist.
- `provisionReviewerCredentials` is never invoked. The per-session
  credentials dir holds only the pinned agent's subtree, exactly as
  docs/138 specifies.
- No behavior change vs today for the user.

When the setting is **on**:

- The MCP tool is registered. The primary can call it (subject to the
  authorization rules in §2).
- Credential provisioning fires lazily on the first invocation (§4).

The setting is checked at tool-registration time (per session, when the
bridge is set up) AND on every tool invocation. The invocation check is
the load-bearing one: MCP tool lists are fetched once per CLI process
boot, so toggling the setting off mid-session does NOT retroactively
hide the tool from a streaming primary CLI that already booted. The
registration check is best-effort for fresh sessions; the invocation
check is what makes mid-session toggle-off safe. Off mid-session = tool
calls return an error result to the primary: *"Cross-agent review is
disabled for this user."*

### 2. The `request_cross_agent_review` MCP tool

A new tool registered on the existing `mcp-review-bridge.ts`, exposed to
the **primary** agent.

- **Tool name:** `request_cross_agent_review`.
- **Input:** `{ reviewerAgentId: AgentId, scope?: "branch" | "uncommitted", focus?: string }`. `focus` is a free-text hint the primary
  can pass to direct the reviewer's attention (e.g. "focus on
  concurrency safety in the new queue code").
- **Output (tool result):** `{ status: "completed", reviewerAgentId, comments: [...], summary: string }` on success, or
  `{ status: "error", message }` on failure. The primary CLI's inference
  loop resumes with this as the tool result, so the primary can act on
  the review in the same turn.
- **Authorization, server-side:**
  1. Global setting `enableCrossAgentReview` is on.
  2. `reviewerAgentId` is registered, authed
     (`AgentRegistry.getAuthStatus(reviewerAgentId).authenticated`), and
     **different from** `runner._agentId`.
  3. The caller is the primary, not a reviewer. Each CLI spawn gets its
     own bridge subprocess (the bridge is spawned by the CLI's MCP
     transport via stdio, see docs/125), and bridges POST to the worker
     with no shared state. To disambiguate primary vs reviewer at the
     worker, the orchestrator passes a per-spawn `REVIEW_ID` nonce as
     an env var to the reviewer's bridge subprocess; the bridge
     forwards it as an HTTP header on every tool POST. A header-less
     POST is the primary; a `REVIEW_ID`-tagged POST is a reviewer.
     `request_cross_agent_review` therefore rejects any call carrying a
     `REVIEW_ID` header — primaries don't have one (see §3).
  4. Per-turn cap (§7) not yet exceeded.
  5. The session is pinned (`agent_pinned === true`). Pre-pin sessions
     have no primary identity, no diff worth reviewing.
- **Side effects:** synchronously dispatches to the orchestrator's
  `runCrossAgentReview`, which runs the reviewer subprocess (§3), waits
  for it, and returns the result. The primary CLI is paused on this tool
  call for the duration — typical 30-120s for a branch-diff review.

The user-facing invocation is natural language: the user says "review
this with Codex" and the primary picks it up. No slash command, no UI
button.

### 3. Worker subprocess execution model

The reviewer cannot use `/agent/start` (single-slot 409). Instead the
worker exposes a parallel endpoint:

- **`POST /review/start`** on the session worker. Body: `{ reviewerAgentId, allowedTools, prompt, reviewId }`. Returns
  synchronously when the subprocess exits: `{ status, comments, summary, durationMs, costUsd, truncated }`.
- The handler **reuses the existing per-agent adapter**
  (`ClaudeAdapter` / `CodexAdapter`) — it must, because Codex's
  `app-server` requires JSON-RPC handshake and event parsing that lives
  in the adapter. The `/agent/start` slot machinery
  (`wireAgentEvents()`, SSE broadcast) is the entanglement we avoid;
  the adapter itself is the reusable primitive. New code: the handler
  instantiates a fresh adapter, wires its events into a **local result
  accumulator** instead of the broadcast SSE, runs the adapter to
  completion, returns the accumulated comments + summary. The slot
  (`this.agent`) is untouched. This is a meaningful new code path, not
  a drop-in reuse — naming it honestly so the implementer scopes
  correctly.
- **Per-review identity (`REVIEW_ID`).** The orchestrator generates a
  fresh UUID for each `runCrossAgentReview` call and passes it to the
  worker as `reviewId`. The worker passes it as an env var
  (`SHIPIT_REVIEW_ID=<uuid>`) to the reviewer CLI subprocess, which
  inherits it to its MCP bridge subprocess. The bridge forwards it as
  an HTTP header (`X-Shipit-Review-Id`) on every tool POST it sends to
  the worker. The worker routes incoming `submit_diff_review` POSTs to
  the per-review buffer keyed on `REVIEW_ID`. **This is how multi-
  session safety works**: two sessions running reviews simultaneously
  have distinct UUIDs and distinct buffers.
- **Primary/reviewer disambiguation.** Primary CLI invocations
  (`/agent/start`) inherit no `SHIPIT_REVIEW_ID`. The bridge forwards
  no header. The worker treats header-less POSTs as primary; tagged
  POSTs as reviewer. Used by §2's authorization predicate and §6's
  `submit_diff_review` guard.
- **Registry-membership check.** The worker maintains a set of
  `REVIEW_ID`s currently in flight (added when `/review/start` opens a
  per-review buffer, removed when the subprocess exits). Inbound POSTs
  carrying `X-Shipit-Review-Id` are accepted only when the value is in
  that set. Without this check, a misbehaving primary with `Bash`
  access could `curl -H "X-Shipit-Review-Id: <guess>"` against the
  worker and impersonate a reviewer. The registry lookup is the same
  one used to demux POSTs into per-`REVIEW_ID` buffers, so the check
  is free.
- **Output capture.** Reviewer's structured comments arrive via
  `submit_diff_review` MCP calls during subprocess lifetime,
  accumulated by `REVIEW_ID`. The reviewer's free-text final assistant
  message is captured from the adapter's event stream as the `summary`
  field.
- **Concurrency.** Two CLI processes alive concurrently in the worker
  during the review window: the primary (paused on the tool result)
  and the reviewer (active). Peak memory cost ≈ +500MB-1GB RSS for
  typical Claude/Codex runs. **Container sizing must be confirmed
  against this floor before shipping** — see Touchpoints. If current
  per-session limits don't accommodate it, raise them or document the
  requirement.
- **Primary-side blocking duration.** Reviews typically take 30-120s.
  This is well outside the latency profile of `Read`/`Bash`. MCP SDKs
  in some versions impose ~60s default tool-call timeouts; **the
  worker image's pinned CLI versions must be verified to tolerate a
  ~5min ceiling** (matches the wall-clock cost cap in §7) and the
  ceiling adjusted if the SDK won't budge. Document the actual ceiling
  in user-facing copy on the global setting.
- **User-visible progress during the wait.** The primary CLI shows
  "thinking…" while paused on the tool call; ShipIt's chat UI doesn't
  receive intermediate reviewer output (the reviewer's `submit_diff_review`
  posts go to the per-review buffer, not into chat). To avoid 2 minutes
  of silence, the orchestrator emits a single small status chip into
  the chat when `/review/start` is dispatched: *"Asking Codex to
  review… (typically 30-120s)"*. The chip is replaced by the result
  chip (§7) when the tool returns. Status only, not a control surface
  — consistent with §5.
- **No SSE involvement.** The reviewer's output flows through the
  synchronous HTTP response, not the SSE channel that feeds the
  runner's `_agent`. Therefore: no `_agent` swap, no drain, no
  `activeInvocation` flag, no `reviewer: ReviewerSession` field on the
  runner, no reviewer queue. The whole machinery from earlier drafts
  dissolves under synchronous-tool semantics.
- **Crash handling.** Subprocess exits non-zero → `/review/start`
  returns `{ status: "error", message }`. Orchestrator returns the
  same shape as the tool result; the primary sees the error and can
  react. Credentials wipe fires in `finally` regardless.
- **Cancel handling.** If the user cancels the primary's turn while
  the reviewer subprocess is running, the orchestrator forwards
  `/review/cancel` (with `reviewId`) to the worker, which SIGTERMs
  the subprocess. The reviewer exit triggers the wipe; the primary's
  tool call returns `{ status: "error", message: "cancelled" }`.
  Cancellation is symmetric: cancelling the primary cancels the
  reviewer that's running on its behalf. **Tool-call timeout edge
  case:** if the primary CLI's MCP SDK times out its own tool call
  before `/review/start` returns, the orchestrator MUST still SIGTERM
  the subprocess and wipe creds. The orchestrator tracks the in-flight
  review independent of the tool RPC; the RPC timing out is just one
  of the termination signals it watches for.

### 4. Lazy, scoped, post-review-wiped cross-agent credentials

Carries over from earlier drafts of this doc unchanged in essentials,
strengthened by the global gate:

- **Lazy.** The other agent's subtree is provisioned *only* on a
  `request_cross_agent_review` invocation, which only fires if the
  global setting is on AND the primary has chosen to call the tool.
  Pre-invocation, per-session credential isolation holds exactly as
  docs/138 specifies.
- **Just-in-time, just-before-spawn.** `runCrossAgentReview` calls
  `provisionReviewerCredentials(credentialsRoot, sessionId, reviewerAgentId)`
  synchronously before `/review/start`. The function copies *only*
  `AGENT_CREDENTIAL_PATHS[reviewerAgentId]` plus a refresh of the
  token-sync files; it must never touch
  `AGENT_CREDENTIAL_PATHS[pinnedAgentId]` (would clobber the CLI's
  in-place writes per docs/138 §"write-once").
- **Wiped on review completion.** `removeReviewerCredentials(credentialsRoot, sessionId, reviewerAgentId)` runs in a `finally`
  after the review subprocess exits (success, failure, crash, or
  cancel). Deletes only the reviewer's subtree.
- **Token-sync-back before wipe.** If the reviewer CLI rotated its
  OAuth refresh token during the review (docs/142 — Claude and Codex
  both have rotating refresh tokens), the new token lives in the
  per-session subtree. `runCrossAgentReview` runs
  `syncAgentTokenBack(reviewerAgentId)` to the orchestrator's
  source-of-truth credentials **before** invoking the wipe — otherwise
  the next session that lazily provisions the reviewer starts from a
  stale refresh token and 401s. Mirrors docs/142's per-turn token-back
  sync for primary agents, just scoped to the review window.
- **Wipe is best-effort.** Even with the token-sync-back step, the
  reviewer CLI may still be flushing other writes to its subtree at
  the instant we `rm -rf` it. Tolerable: any interrupted write is the
  reviewer's *own* transient state, and the next
  `provisionReviewerCredentials` re-copies cleanly from
  source-of-truth. The pinned agent's subtree is never touched by
  either path.
- **Sign-out propagation.** When the user signs out of an agent
  (`AgentRegistry` emits a sign-out for `agentX`), the orchestrator
  runs `removeReviewerCredentials` for every session where `agentX`
  is *not* the pinned agent — sweeping any in-flight cross-agent
  creds that would otherwise outlive the user's authorization.
- **Codex review MCP config provisioning.** For a Codex reviewer in a
  Claude-pinned session, the per-session `.codex/config.toml` needs
  the `[mcp_servers.shipit-review]` block (same registration docs/125
  wrote via `ensureCodexReviewMcpConfig`) so the reviewer can call
  `submit_diff_review`. Under docs/138's symlink scheme `~/.codex/` in
  the container resolves into the per-session credentials subtree, so
  the append lands inside the wipe scope: added in the same step as
  `provisionReviewerCredentials`, removed along with the rest of
  `.codex/` on review completion.

### 5. Tool-allowlist enforcement of read-only

System prompt instructions are necessary but not sufficient. The
reviewer CLI is spawned with an *explicit per-spawn allowlist*. This
parameter **does not exist today** for the reviewer's invocation path
(`/agent/start` accepts agent-specific params, but `/review/start` is
new), and Claude's existing flag (`--allowedTools`) is hard-coded by
permission mode. The feature requires:

1. The `/review/start` worker endpoint accepts `allowedTools: string[]`.
2. The endpoint forwards it as `--allowedTools` (Claude) or the Codex
   equivalent (see §6) when spawning the subprocess.
3. The orchestrator-side worker MCP guard rejects `submit_review_comments`
   (the docs/125 single-file tool) when the POST carries a
   `X-Shipit-Review-Id` header (i.e. is from a reviewer subprocess —
   see §3). The docs/125 path gains the symmetric guard rejecting
   `submit_diff_review` from header-less (primary) POSTs. The per-spawn
   `REVIEW_ID` nonce mechanism (§3) is what makes this decidable —
   there is no "MCP connection" state at the worker layer; every
   bridge POST is an independent HTTP request.

Read-only subset per agent (verified against each adapter's current
capability list at implementation time):

- **Claude reviewer:** `Read`, `Glob`, `Grep`, plus `submit_diff_review`.
  No `Bash` for v1 (the diff is in the prompt; if a reviewer needs
  `git log` of a specific file, that's a v2 enhancement). No `Edit`, no
  `Write`, no `Task`. Enforced by `claude --allowedTools <subset>` at
  spawn — a real allowlist primitive in the CLI today.

**Codex asymmetry — symmetric ship, asymmetric enforcement.** Codex's
CLI (`codex app-server`) has **no per-spawn tool-restriction flag**
today. The worker-side MCP guard rejects ShipIt's *own* MCP tools but
does NOT prevent Codex's built-in `file_write` / `file_edit` / `shell`
tools from firing — those are CLI built-ins, not MCP. For Codex *as
the reviewer*, the read-only guarantee therefore degrades to:

- **Strong system prompt** that explicitly forbids edits, commits, and
  shell-based mutations.
- **Worker MCP guard** on the two ShipIt tools (intact).
- **No CLI-level write-tool block.** A misbehaving Codex reviewer
  *could* call `file_edit` and the worker would not prevent it.

**V1 decision (carried over): ship symmetric with prompt-only
enforcement for Codex.** User-facing copy on the global setting (§1)
and on the tool's surfaced result names the asymmetry: *"Codex review
is advisory. Codex may, against instructions, attempt to edit files;
commits and pushes are still blocked because the reviewer subprocess
runs outside the primary turn's post-turn flow."* Tighten to symmetric
CLI-level enforcement when Codex grows the primitive.

The "no sub-subagents from a reviewer" rule is enforced by the
allowlist itself (omitting `Task` for Claude). For Codex,
`spawn_agent` falls into the same prompt-only bucket.

### 6. `submit_diff_review`: the reviewer's write-back tool

Docs/125's `submit_review_comments` is allow-listed per a single open
file (`runner.activeReviewFilePath`). Cross-agent review writes against
a *set* of files. Add a sibling MCP tool, not a generalization of the
existing one:

- **MCP tool name:** `submit_diff_review`.
- **Payload:** `{ comments: [{ filePath, anchor, body, severity }, ...], summary?: string }`.
  Anchors follow docs/125's anchoring rules. `summary` is an optional
  overall takeaway the reviewer can attach.
- **Registration:** added to the existing `mcp-review-bridge.ts` as a
  second exposed tool alongside `submit_review_comments`. The bridge
  is a stateless HTTP transport (every tool call POSTs to the worker
  with no shared state) — the bridge itself doesn't authorize;
  authorization happens at the worker by inspecting the
  `X-Shipit-Review-Id` header that reviewer-spawned bridges carry and
  primary-spawned bridges don't (§3).
- **Authorization:** valid only when the POST carries a
  `X-Shipit-Review-Id` header matching an in-flight review buffer.
  Primary POSTs (header-less) calling `submit_diff_review` get a tool
  error.
- **Capture, not relay.** Unlike docs/125's three-hop relay (bridge →
  worker → orchestrator HTTP), `submit_diff_review` POSTs are
  intercepted at the worker, routed into the per-review buffer keyed
  on `REVIEW_ID`, and returned to the orchestrator as part of
  `/review/start`'s synchronous response. There is no orchestrator
  HTTP route for it. One less hop than docs/125's path, and no
  broadcast plumbing — the synchronous response is the only consumer.
- **Persisted comments:** the orchestrator persists them through the
  existing review-store path (docs/125) with `source: "ai"`,
  `reviewerAgentId` recorded so the unified review surface (docs/112)
  can attribute them. Persistence happens *after* `runCrossAgentReview`
  returns, so the primary's tool result and the persisted comments are
  derived from the same captured payload.

### 7. Per-turn cap, cost cap, attribution

- **Per-turn cap.** The runner tracks `crossAgentReviewsThisTurn`,
  incremented on each `request_cross_agent_review` invocation, reset
  at primary-turn start. Hard cap of **1 per turn** in v1. A second
  call in the same turn returns an error result without invoking the
  reviewer. This prevents a misbehaving primary from chaining reviews
  (loop or runaway-cost scenario). **Spam across turns is not a
  separate concern**: a user typing "review with codex" repeatedly is
  bounded by normal turn rate and their own intent — same shape as
  any other multi-turn-repeated tool use.
- **Cost cap.** Wall-clock cap on the reviewer subprocess (initial:
  5 min); output-token cap via the reviewer CLI's natural settings
  (initial: 8K). Hitting either truncates with the result flagged
  `truncated: true` and a note in the tool result the primary can
  surface.
- **Usage attribution.** `UsageManager` records the reviewer's cost
  against `reviewerAgentId`, not the runner's pinned `agentId`. The
  existing per-session usage UI surfaces the breakdown as a separate
  row per agent.
- **Visible attribution in chat.** The primary's chat message that
  results from the tool call is naturally attributed to the primary
  (it's the primary speaking). The orchestrator additionally emits a
  small inline chip on that message — "Consulted Codex for review"
  with timing/cost — so the user sees the consult happened. This is
  status, not a control surface; consistent with §5.

### 8. Default review scope

The primary chooses `scope` when calling the tool. Defaults if omitted:

- **Default:** `scope: "branch"` — diff of `HEAD` vs
  `mergeBase(HEAD, baseBranch)`. Matches "second opinion on the work
  I'm about to ship."
- **Opt-in:** `scope: "uncommitted"` for working-copy-only review.
- **Token cap.** Diffs larger than the per-review token cap (§7) are
  truncated; the reviewer gets the first N tokens plus a list of
  omitted file paths. Future work: chunked review.

### 9. Local / dogfood mode

In `RUNTIME_MODE=local`, credential provisioning is a no-op (docs/138)
because the agent runs in-process. Cross-agent review in local mode:

- Provisioning helpers (`provisionReviewerCredentials` /
  `removeReviewerCredentials`) short-circuit, mirroring docs/138's
  pattern.
- The "spawn reviewer as subprocess" path is similar to local mode's
  primary-agent flow (in-process spawn rather than container
  subprocess).
- Per-turn cap, allowlist, cost cap, and the `submit_diff_review` tool
  all behave identically.
- The global setting still gates the feature.

## Usage attribution

(Folded into §7.)

## Touchpoints

- **Global settings (`SettingsManager` / settings store)** — add
  `enableCrossAgentReview: boolean` (default false). UI in the settings
  panel under "Multi-agent sessions" with the copy from §1. Server
  reads it on bridge setup and on every tool invocation.
- **`mcp-review-bridge.ts`** — declare `request_cross_agent_review` and
  `submit_diff_review` alongside the existing `submit_review_comments`
  in the bridge's tool catalogue. The bridge stays a stateless HTTP
  transport (every tool call POSTs to the worker with no shared state);
  the only behavior change is that the bridge reads
  `SHIPIT_REVIEW_ID` from its environment and forwards it as
  `X-Shipit-Review-Id` on every POST when present. Authorization stays
  at the worker (header inspection) and orchestrator (header relay),
  not in the bridge.
- **`session-credentials.ts`** — add `provisionReviewerCredentials()`
  and `removeReviewerCredentials()` (lazy + scoped + reversible per §4).
  Also add a reviewer-scoped variant of `syncAgentTokenBack` invoked
  from `runCrossAgentReview` before the wipe (per §4).
- **`AgentRegistry`** — confirm `refreshAuth(agentId)` exists; add if
  not. Additionally, `AgentRegistry` becomes an `EventEmitter` (it
  isn't today — this is a new public API) and emits `sign-out`
  (`agentId`) from the existing sign-out HTTP routes.
  `services/cross-agent-review.ts` subscribes for the sign-out sweep.
- **`session-worker.ts`** — new `POST /review/start` and
  `POST /review/cancel` endpoints. The handler instantiates the
  appropriate per-agent adapter (`ClaudeAdapter` / `CodexAdapter`)
  fresh — NOT through the `/agent/start` slot — and wires its events
  into a **local result accumulator** rather than the broadcast SSE.
  The slot (`this.agent`) is untouched. Worker memory holds two CLI
  processes during a review window (primary in the slot + reviewer in
  the parallel path). Worker also adds a `submit_diff_review`
  HTTP route that demuxes incoming POSTs on `X-Shipit-Review-Id` into
  the per-`REVIEW_ID` accumulator. **This is a meaningful new code
  path, not a drop-in adapter reuse** — naming it honestly so the
  implementer scopes correctly.
- **Worker memory headroom** — confirm container sizing tolerates a
  +500MB-1GB peak RSS during a review window before shipping. If
  current per-session limits don't, raise them or document the
  requirement. Block-shipping concern, not a write-now concern.
- **Primary MCP tool-call timeout** — the worker image's pinned CLI
  versions (`docker/agent-cli/package-lock.json`) must be verified to
  tolerate a ~5min tool-call ceiling (matches §7 wall-clock cap). Some
  MCP SDK versions default to ~60s; if the pinned versions can't be
  configured up, adjust §7's cap down to match what the SDK tolerates.
  Document the actual ceiling in user-facing copy on the global
  setting.
- **`AgentRunParams` (reviewer-side) / each adapter** — pass an
  `allowedTools?: string[]` parameter from `/review/start` through to
  the CLI spawn args (Claude: `--allowedTools`; Codex: prompt-only per
  §5).
- **New `services/cross-agent-review.ts`** — `runCrossAgentReview({ sessionId, reviewerAgentId, scope, focus })`. Checks the global
  setting; generates `REVIEW_ID` UUID; provisions creds; calls worker
  `/review/start` with the nonce; on completion, runs reviewer token-
  sync-back, persists resulting comments through the docs/125 review
  store, wipes creds in `finally`; returns `{ status, comments, summary, ... }`. Independently tracks each in-flight review so it
  can SIGTERM the worker subprocess if the primary's MCP tool-call
  times out before `/review/start` returns (§3 cancel-handling).
- **`ContainerSessionRunner`** — adds `crossAgentReviewsThisTurn:
  number` (per-turn counter, reset at primary-turn start). No
  reviewer-related slot or queue or SSE machinery; the runner is
  otherwise unchanged.
- **`UsageManager`** — accept a `reviewerAgentId` parameter distinct
  from the runner's `agentId` when recording reviewer costs.
- **Chat history rendering** — small chip on primary messages that
  resulted from a `request_cross_agent_review` tool call: "Consulted
  Codex for review" plus timing/cost. The review's comments persist
  through the docs/125 review surface; no new message-group kind
  needed since the primary's voice naturally carries the result.
- **Integration tests** — `integration_tests/cross-agent-review.test.ts`
  covering:
  - Global setting off → tool is not registered, primary cannot call
    it, no creds provisioned.
  - Global setting on, happy path: primary calls tool, reviewer
    subprocess runs, comments captured, tool result returned, primary
    continues turn with review in hand, creds wiped after.
  - Authorization: primary (header-less POST) cannot call
    `submit_diff_review`; reviewer (header-tagged POST) cannot call
    `submit_review_comments` or `request_cross_agent_review`.
  - Multi-session `REVIEW_ID` isolation: two sessions running reviews
    simultaneously produce two distinct per-`REVIEW_ID` buffers; cross-
    contamination is rejected.
  - Token-sync-back: reviewer rotates its OAuth token mid-review →
    source-of-truth `auth.json` is updated before wipe; the next
    session's lazy provision starts from the fresh token.
  - Primary MCP tool-call timeout: orchestrator-tracked review survives
    a primary RPC timeout; subprocess is SIGTERMed and creds wiped
    even though the primary already gave up on the tool call.
  - Tool allowlist: reviewer spawned with `--allowedTools` excluding
    write tools (Claude); Codex reviewer prompt-only (asymmetry test
    documents the gap).
  - Lazy provisioning + wipe: `.codex` does not exist in the
    per-session credentials dir before or after a review on a
    Claude-pinned session.
  - Per-turn cap: second `request_cross_agent_review` call in same
    primary turn returns error without spawning a subprocess.
  - Crash path: reviewer subprocess killed mid-review → primary sees
    `status: "error"`, creds wiped.
  - Cancel path: user cancels primary turn during reviewer
    subprocess → reviewer SIGTERMed, creds wiped, primary's tool call
    returns cancellation error.
  - Sign-out propagation: signing out of the other agent wipes its
    subtree from sessions where it was provisioned for review.
  - Cost cap: synthetic 10K-token reviewer output truncated, result
    flagged `truncated: true`.
  - Two-CLI memory: primary process and reviewer process alive
    concurrently during the review window.
  - Local mode: review runs in-process, provisioning helpers no-op.

## Security framing

Three layers of gating:

1. **Global setting (§1).** The user must explicitly enable
   `enableCrossAgentReview`. Default off. Users who never enable it see
   docs/138's invariant intact, word-for-word, forever.
2. **Lazy + scoped credential provisioning (§4).** Even for users who
   enable the setting, the cross-agent credential window opens only
   during the lifetime of an active reviewer subprocess. Outside that
   window, the per-session credentials dir holds only the pinned
   agent's subtree.
3. **Tool-call gating (§2 + §7).** Inside an enabled session, the
   primary can only open the window via a `request_cross_agent_review`
   MCP call; the per-turn cap (1/turn) bounds how often that can
   happen.

The honest regression for users who enable the feature: during the
window between `provisionReviewerCredentials` and
`removeReviewerCredentials` (typically 30-120 seconds per review), a
supply-chain compromise of *either* agent CLI inside the container
could exfiltrate *both* agents' tokens. Without the feature, that
compromise can exfiltrate one. The blast radius of a single agent-CLI
supply-chain compromise *doubles* during the review window for users
who opted in. The global setting is the user's informed consent.

A fuller mitigation (egress broker with scoped ephemeral tokens) is
the same broker work docs/138 explicitly punted as out of scope. That
decision still holds.

## Resolved decisions

Traceability for product decisions made during the design rounds:

1. **Codex-as-reviewer in v1: ship symmetric with prompt-only
   enforcement.** See §5. User-facing copy on the global setting and
   tool result names the asymmetry. Tighten to CLI-level enforcement
   when Codex grows the primitive.
2. **Per-turn cap = 1 review per primary turn.** See §7. Prevents
   loops and runaway cost without needing a more elaborate consent
   model.
3. **No Bash for the Claude reviewer in v1.** See §5. `git log`-style
   read-only shell is a v2 enhancement if users hit the limit.
4. **No slash command.** See Non-goals. The user invokes by natural
   language; the primary calls the MCP tool. Chat is the input
   surface (§5).
5. **No per-session consent flag.** Subsumed by the global setting
   (§1) plus the per-turn cap (§7). Adding a per-session flag would
   block the user's own request when off, which is bad UX. The global
   setting is the user's "I want this feature at all" gate; the
   per-turn cap is the runaway-cost guard.
6. **Synchronous tool semantics, not fire-and-forget.** §3 and §2.
   The primary CLI is paused on the tool result for the duration of
   the review; the reviewer's output returns as the tool result; the
   primary continues its turn naturally with the review in hand. No
   "inject into next turn" mechanism needed.
7. **Cancel = symmetric.** §3. Cancelling the primary's turn during
   a reviewer subprocess cancels the reviewer. No queue, so no
   "preserve the queue" question to answer.

## Out of scope

- A general "co-pilot two agents on every turn" mode — see Non-goals.
- Cross-agent *editing*. Out of scope, by design.
- A second agent slot on the worker. The subprocess approach (§3)
  sidesteps the need.
- Egress-broker mitigation of the dual-cred window — same out-of-scope
  as docs/138's matching item.
- Chunked / multi-pass review for diffs larger than the token cap.
  Truncate for v1, revisit if users hit the cap often.
- Slash commands or buttons for review. The primary handles the
  natural-language invocation.
