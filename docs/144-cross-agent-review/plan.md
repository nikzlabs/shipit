---
description: Globally-gated `shipit agent` CLI primitive that lets the primary agent spawn any other registered agent with any prompt and get its output back as text — synchronously, inline in the same turn. Review is the first consumer.
issue: https://linear.app/shipit-ai/issue/SHI-37
---

# 144 — Sub-agent spawning (cross-agent delegation)

## Summary

Today a session is locked to a single agent for life (docs/138). That gives
us clean credential isolation, predictable commit attribution, and a
coherent post-turn flow — but it also means a user who codes with Claude
cannot get a second opinion from Codex (or hand a self-contained sub-task to
a different model) without spinning up a separate session, re-cloning,
re-explaining context, and round-tripping the result themselves.

This doc proposes keeping the primary-agent pin exactly as it is, and adding
a **generic, one-shot sub-agent primitive**: the primary agent can spawn
*any* registered agent with *any* prompt and get that agent's final output
back **as text**, synchronously, within the same turn. The spawned agent
never becomes the session's agent — it runs as a parallel subprocess,
returns its text, and goes away.

The primary invokes it through a **`shipit agent` CLI command**, the same
brokered-shim surface as `shipit issue` and `shipit session create`. The
primary does not need to know how to drive `claude` vs `codex`, which flags
each takes, or how to parse their output — it runs one command and reads
text from stdout. The CLI brokers to the orchestrator, which spawns the
sub-agent subprocess in the session worker and streams the result back.

**Review is the first consumer of this primitive, not the primitive
itself.** "Get a second opinion from Codex on this diff" is just *spawn the
codex agent with a review-shaped prompt that includes the diff, and read
its text back.* Nothing about the core primitive is review-specific. Other
consumers (delegate a self-contained refactor, ask a different model to
explain a subsystem, generate test fixtures) compose the same way.

The whole feature is gated behind a single global setting (`enableSubAgents`,
default off). Sessions belonging to users who haven't enabled it behave
exactly like docs/138 today — no CLI subcommand wired, no credentials
provisioned, no behavior change.

### v0 scope and the read-only decision

**v0 deliberately ships without a hard read-only sandbox.** The spawned
agent runs **full-capability** — it can read, write, and run shell, exactly
like a normal agent in its container. When the caller wants the sub-agent to
*only* review (or otherwise not mutate the tree), that intent is expressed
**in the prompt**, not enforced by a tool allowlist or filesystem sandbox.

This is a conscious tradeoff: **utility first.** A hard read-only gate
(per-spawn tool allowlist, read-only FS mount, or throwaway-worktree
isolation) is real plumbing, is impossible to enforce uniformly today
(Codex's CLI has no per-spawn tool-restriction flag — see "Future work"),
and would block the feature's broader purpose, which is that a sub-agent may
legitimately do more than review. The accepted consequence: a sub-agent's
writes land in the **shared session workspace** and are committed under the
**primary's** turn (post-turn flow attributes them to the pinned agent, per
docs/138). For v0 that is fine — file writes stay attributed to the pinned
agent either way, and the user opted into the feature.

Hard isolation (so a "read-only" spawn genuinely cannot write, and a
write-capable spawn lands in an isolated worktree whose diff the primary
chooses to apply) is documented as **future work**, not built in v0.

## Motivation

Different model families have different strengths on different code. Users
already consult a second model manually — they paste a diff into another
tool and ask "what did I miss?" — and the principle (§1, §2 of CLAUDE.md) is
that the workflow should happen inside ShipIt instead of routing them out.

But review is only the most obvious case. The deeper point: a session is
pinned to one agent for good reasons, yet a pinned session should still be
able to *consult* or *delegate to* another agent for a bounded, one-shot
sub-task without surrendering the pin. Designing the primitive narrowly
around review would bake in a rigid system that we'd have to re-open the
moment the first non-review use case shows up. So the primitive is generic;
review is layered on top as a prompt + (optional) output renderer.

The current pin (docs/138) is the right default: it makes the session
legible. This primitive doesn't change the pin — it adds a "spawn a helper"
affordance the pinned agent drives.

## Non-goals

- **Per-turn agent switching.** Alternating agents turn-by-turn breaks
  commit attribution, post-turn auto-push, the chat history's mental model,
  and the guarantees docs/138 was built to provide. Pin one. The other is a
  spawned helper, not a co-driver.
- **A hard read-only sandbox in v0.** See "v0 scope" above and "Future
  work" below. v0 shapes sub-agent behavior by prompt, not by enforcement.
- **A second persistent agent slot on the worker.** The existing
  `/agent/start` slot stays single-occupant. The sub-agent runs through a
  *different* worker endpoint (`/agent/spawn`) that spawns a plain
  subprocess, outside the slot machinery, and exits when done.
- **Multi-level recursion.** A spawned sub-agent is not meant to spawn
  another sub-agent; depth is capped at 1 by a best-effort guard (§3), with
  the per-turn cap as the forgery-resistant backstop. Deep agent trees /
  orchestration graphs are out of scope.
- **A slash command.** The primary agent recognizes the user saying "review
  with codex" / "ask claude to draft the migration" and runs the `shipit
  agent` command itself. A `/spawn` command would duplicate the
  natural-language path with a parallel command surface, contrary to
  CLAUDE.md §5.
- **Replacing the existing intra-agent review (docs/125).** That stays. When
  the user wants the *primary* to review (cheaper, same context), they still
  get it. Spawning a different agent is opt-in for when they want another
  model's eyes or hands.

## Current architectural constraints

Confirmed by reading the code, not extrapolated:

- **Per-session credential isolation (docs/138).** A Claude session's
  container never has `.codex` on disk, and a Codex session never has
  `.claude`. `provisionAgentCredentials()` (`session-credentials.ts`) is
  *write-once* on first turn, copying only the pinned agent's subtree. A
  cross-provider spawn is the only thing that puts the other agent's creds
  on disk, and only transiently (§4).
- **Provider-account routing (docs/150/153).** Credentials are no longer a
  single flat root per agent. `providerAccountManager.selectRouteForTurn(agentId)`
  resolves the active account; `provisionProviderAccountCredentials(credentialsRoot,
  sessionId, agentId, accountId)` copies from
  `providerAccountCredentialRoot(...)`. The flat root holds legacy-alias
  symlinks and is **not** the freshest source for a multi-account user. The
  sub-agent's creds must be provisioned from its *resolved account root*, not
  the flat root (§4).
- **One agent process per worker slot.** `session-worker.ts` returns 409 on
  a second `/agent/start` while `this.agent` is non-null. The sub-agent
  therefore cannot share the slot — it spawns as a parallel subprocess
  through a new endpoint that doesn't touch `this.agent`.
- **One agent slot per runner, SSE has no agent identifier.**
  `ContainerSessionRunner` has a single `_agent: ProxyAgentProcess | null`
  and the SSE event handler routes everything onto that field. Critical
  consequence: the sub-agent must NOT emit events into that SSE stream, or it
  will corrupt the primary's accumulators. The subprocess approach (§3)
  sidesteps this by returning the sub-agent's output synchronously over HTTP,
  not over SSE.
- **`set_agent` is locked after pinning.** `index.ts` rejects a switch to a
  different agent once `agentPinned` is set. This stays — spawning a
  sub-agent does not change the pin.
- **`shipit` is a brokered shim, not the raw CLI.** Existing subcommands
  (`shipit issue`, `shipit session create`) run inside the container and POST
  to the **session worker** on localhost (`http://127.0.0.1:9100/agent-ops/*`);
  the shim itself carries **no** session id. The worker's `/agent-ops/*`
  broker (`agent-ops-routes.ts` → `orchestrator-client.ts`) injects the
  **trusted `SESSION_ID`** env — set on the container by
  `container-lifecycle.ts:buildEnv`, and the env name is `SESSION_ID`, not
  `SHIPIT_SESSION_ID` — and relays to the orchestrator's session-scoped
  routes. That worker broker is the security chokepoint: it is what prevents
  the agent from naming a *different* session. `shipit agent` is a new
  subcommand on that same surface — which is why it needs no MCP bridge and
  no per-call nonce: the worker broker is already an authenticated,
  session-scoped channel.

## Design

Eight pieces. The first two are the new surface (CLI command + orchestrator
brokering); the rest is how each load-bearing concern (credentials, output,
caps, recursion, attribution, mode) settles under it.

### 1. Global setting: `enableSubAgents`

A single user-level setting in the existing settings store, default
**false**. Surfaced in the settings panel under a heading like "Multi-agent
sessions" with copy explaining: *"Allow the agent in a session to spawn
another agent for a one-shot sub-task (e.g. a second-opinion review). The
spawned agent runs with full tool access and its work is committed under
your session's agent. Enabling this means a session container can briefly
hold credentials for both agents."*

When the setting is **off** (default):

- The `shipit agent` subcommand returns an error: *"Sub-agents are disabled.
  Enable them in Settings → Multi-agent sessions."* — so a primary that
  tries it gets a clear, actionable tool result rather than a silent failure.
- No credentials beyond the pinned agent's subtree are ever provisioned.
- No behavior change vs today for the user.

When the setting is **on**:

- `shipit agent run` works, subject to the authorization checks in §3.
- Credential provisioning fires lazily on the first cross-provider spawn (§4).

The setting is checked at the orchestrator on **every** `shipit agent`
invocation (not cached at session boot), so toggling it off mid-session
takes effect on the next spawn attempt.

### 2. The `shipit agent` CLI command

The primary's entire interface to the primitive. It abstracts away which
underlying CLI runs and how it's invoked.

```
shipit agent run --agent <agentId> --prompt-file -
```

- **`--agent <agentId>`** — the agent to spawn (`claude`, `codex`, …). May
  be the *same* provider as the primary (a fresh-context helper) or a
  *different* one (cross-agent). Same-provider spawns need no extra
  credentials; cross-provider spawns trigger §4.
- **`--prompt-file -`** — the prompt is read from **stdin** (heredoc style,
  consistent with `shipit issue comment --body-file -`). The caller puts
  *all* context it wants the sub-agent to have into this prompt: the task,
  any diff (`git diff`), file references, focus hints. There is no separate
  `scope`/`diff` parameter — the prompt is the single context channel, which
  is what makes the primitive generic rather than review-shaped.
- **Output:** the sub-agent's **final assistant message**, written to
  **stdout** as plain text. Exit code `0` on success; non-zero with a
  message on stderr for errors (disabled, unknown agent, cap exceeded,
  crash, timeout, cancel).
- **Blocking:** the command blocks until the sub-agent exits — typically
  30–120s for a review-sized task. The primary's CLI sees it as a
  long-running shell command (it already tolerates long `Bash` calls), so no
  MCP-tool-timeout concern applies the way it would for an MCP tool. The
  primary continues its turn with the text in hand.

The user-facing invocation stays natural language: "review this with Codex",
"ask Claude to draft the migration script". The primary recognizes the
intent, assembles the prompt, runs `shipit agent run`, and acts on the text.
No slash command, no UI button (CLAUDE.md §5).

`shipit agent` is **agent-facing platform behavior**, so when this ships it
needs a doc in `src/server/shipit-docs/` (e.g. `agent.md`) describing the
command, baked into the worker image at `/shipit-docs/`. (Not added now —
shipit-docs describe *shipped* behavior.)

### 3. Worker broker + subprocess execution model

`shipit agent` brokers through the **session worker** like every other
`shipit` subcommand; the worker injects the trusted `SESSION_ID` and relays
to the orchestrator, which owns the lifecycle and the guards. No MCP bridge,
no per-call nonce — the worker broker is already the authenticated,
session-scoped channel the old `REVIEW_ID` mechanism was reconstructing.

Flow:

1. **Shim → worker broker.** The shim POSTs `{ agentId, prompt, depth }` to
   the worker on localhost (`POST http://127.0.0.1:9100/agent-ops/agent/spawn`).
   The shim carries **no** session id — it reads its own inherited
   `SHIPIT_AGENT_DEPTH` env (absent ⇒ `0`, i.e. a primary) and forwards it as
   `depth`; that is the **only** way the recursion guard downstream can see
   the caller's depth, since the orchestrator runs in a different process and
   never sees the calling subprocess's env.
2. **Worker broker → orchestrator.** `agent-ops-routes.ts` injects the
   trusted `SESSION_ID` (the agent cannot name a different session) and
   relays to the orchestrator's session-scoped route
   (`POST /api/sessions/:id/agent/spawn`), forwarding `agentId`, `prompt`,
   and `depth`.
3. **Orchestrator authorization** (`services/sub-agent.ts`):
   - `enableSubAgents` is on (§1).
   - `agentId` is registered and authed
     (`agentRegistry.get(agentId)?.authConfigured === true`; call
     `agentRegistry.refreshAuth(agentId)` first to re-probe).
   - The session is pinned (`agent_pinned === true`) — a pre-pin session has
     no primary identity.
   - **Recursion depth (best-effort).** The forwarded `depth` is `0`. A
     non-zero `depth` means the caller is itself a spawned sub-agent and the
     call is rejected (*"Sub-agents cannot spawn further sub-agents."*). This
     is the generic replacement for the old "reviewers can't review" rule and
     stops a *well-behaved* sub-agent from recursing. It is **not** a
     forgery-resistant boundary: `depth` rides in the request body, and a v0
     full-capability sub-agent with shell access can override its inherited
     `SHIPIT_AGENT_DEPTH` (e.g. `SHIPIT_AGENT_DEPTH=0 shipit agent run …`) or
     POST the localhost worker directly with `{"depth":0}`. The worker can't
     close this in v0 — it's a single long-lived process, so it has no trusted
     view of an arbitrary calling subprocess's env (unlike `SESSION_ID`, which
     it injects). The actual forgery-resistant bound on total fan-out is the
     **per-turn cap (§5)**, which the next check enforces: it lives on the
     runner keyed by the worker-injected `SESSION_ID`, so *every* spawn in the
     session's turn — including any a sub-agent forges its way into —
     decrements the same budget. Worktree isolation (Future work) is what
     would let a later version make depth itself enforceable.
   - Per-turn cap (§5) not yet exceeded.
4. **Credential provisioning (§4)** runs synchronously for a cross-provider
   spawn, before the subprocess starts.
5. **Orchestrator → worker spawn.** `POST /agent/spawn` on the session
   worker. Body: `{ agentId, prompt, spawnId }`. The handler **reuses the
   existing per-agent adapter** (`ClaudeAdapter` / `CodexAdapter`) — it must,
   because Codex's `app-server` requires JSON-RPC handshake and event parsing
   that lives in the adapter. It instantiates a **fresh** adapter, **stamps
   `SHIPIT_AGENT_DEPTH = <caller depth> + 1` on the subprocess env** (so the
   sub-agent's own `shipit agent` calls forward a non-zero depth and are
   rejected at step 3), wires the adapter's events into a **local result
   accumulator** instead of the broadcast SSE, runs to completion, and
   returns the accumulated final text synchronously. The slot (`this.agent`)
   is untouched. **This is a meaningful new code path, not a drop-in reuse**
   — naming it honestly so the implementer scopes correctly. (`spawnId` is an
   orchestrator-internal handle for tracking and cancellation, not an
   authorization token.)
6. **Worker → orchestrator → worker broker → shim stdout.** The text flows
   back up the synchronous chain and out the CLI's stdout.

- **No SSE involvement.** The sub-agent's output flows through the
  synchronous HTTP response, not the SSE channel that feeds the runner's
  `_agent`. Therefore: no `_agent` swap, no drain, no `activeInvocation`
  flag, no sub-agent field on the runner, no queue.
- **Concurrency.** Two CLI processes alive concurrently during the spawn
  window: the primary (blocked on the `shipit agent` shell call) and the
  sub-agent (active). Peak memory cost ≈ +500MB–1GB RSS for typical
  Claude/Codex runs. **Container sizing must be confirmed against this floor
  before shipping** — see Touchpoints.
- **Multi-session isolation is free.** Each `shipit agent` call is its own
  request/response with its own subprocess and its own synchronous result.
  Two sessions spawning simultaneously share nothing — there's no per-review
  buffer to key, which is the other thing the old `REVIEW_ID` mechanism was
  for.
- **Crash handling.** Subprocess exits non-zero → the orchestrator returns
  an error; the CLI exits non-zero with the message; the primary sees it and
  can react. Credential wipe (§4) fires in `finally` regardless.
- **Cancel handling.** If the user cancels the primary's turn while the
  sub-agent subprocess is running, the orchestrator SIGTERMs the subprocess
  (`POST /agent/cancel` with `spawnId`); the sub-agent exit triggers the
  wipe; the `shipit agent` command exits non-zero ("cancelled"). Cancelling
  the primary cancels the sub-agent running on its behalf.

### 4. Lazy, scoped, post-spawn-wiped cross-agent credentials

Only relevant for a **cross-provider** spawn (a same-provider spawn reuses
the pinned agent's already-present credentials and provisions nothing).

- **Lazy.** The other agent's subtree is provisioned *only* on a
  cross-provider `shipit agent` invocation, which only fires if the setting
  is on AND the primary chose to spawn. Pre-invocation, docs/138 isolation
  holds exactly.
- **Just-in-time, just-before-spawn, account-correct.** `runSubAgent`
  resolves the sub-agent's provider-account route first —
  `providerAccountManager.selectRouteForTurn(subAgentId)`, exactly as the
  primary turn path does (`session-agent-env.ts`) — then provisions from
  *that account's* root, not the flat credentials root. When the route is
  `{ kind: "account", id: accountId }` it copies from
  `providerAccountCredentialRoot(credentialsRoot, subAgentId, accountId)` via
  `provisionProviderAccountCredentials(credentialsRoot, sessionId, subAgentId,
  accountId)`; only the legacy no-account fallback copies from the flat
  `credentialsRoot`. Post-docs/150/153 the flat root holds legacy-alias
  symlinks into the provider-account subtrees and is **not** the freshest
  source for a multi-account user — provisioning from it would start the
  sub-agent CLI on stale credentials and 401. The copy pulls *only* the
  sub-agent's subtree (`AGENT_CREDENTIAL_PATHS[subAgentId]` plus a refresh of
  the token-sync files); it must never touch `AGENT_CREDENTIAL_PATHS[pinnedAgentId]`
  (would clobber the CLI's in-place writes per docs/138 §"write-once").
  Record the resolved `accountId` — the wipe and token-sync-back below must
  target the same account root.
- **Token-sync-back before wipe.** If the sub-agent CLI rotated its OAuth
  refresh token during the run (docs/142 — Claude and Codex both rotate
  refresh tokens), the new token lives in the per-session subtree.
  `runSubAgent` runs `syncAgentTokenBack(subAgentId)` to the orchestrator's
  source-of-truth credentials — the **same account root** resolved at
  provision time (`providerAccountCredentialRoot(...)` for an account route,
  the flat root only for the legacy fallback), not unconditionally the flat
  root — **before** invoking the wipe. Otherwise the next session that lazily
  provisions this agent starts from a stale refresh token and 401s.
- **Wiped on completion.** `removeSubAgentCredentials(credentialsRoot,
  sessionId, subAgentId)` runs in a `finally` after the subprocess exits
  (success, failure, crash, or cancel). Deletes only the sub-agent's subtree.
- **Wipe is best-effort.** The sub-agent CLI may still be flushing writes to
  its subtree at the instant we `rm -rf` it. Tolerable: any interrupted write
  is the sub-agent's *own* transient state, and the next provision re-copies
  cleanly from source-of-truth. The pinned agent's subtree is never touched.
- **Sign-out propagation.** When the user signs out of an agent
  (`AgentRegistry` emits a sign-out for `agentX`), the orchestrator runs
  `removeSubAgentCredentials` for every session where `agentX` is *not* the
  pinned agent — sweeping any in-flight cross-agent creds that would
  otherwise outlive the user's authorization.

### 5. Caps, cost, attribution

- **Per-turn cap (the real fan-out bound).** The runner tracks
  `subAgentSpawnsThisTurn`, incremented on each spawn reaching
  `services/sub-agent.ts`, reset at primary-turn start. Modest hard cap in v0
  (**3 per turn**) — enough for "review with both other models" or a couple
  of delegations, low enough to bound a misbehaving-primary loop. A call past
  the cap returns an error without spawning. This is the **forgery-resistant**
  bound (§3): the counter is keyed by the worker-injected `SESSION_ID`, which
  a sub-agent cannot spoof, so every spawn in the turn — primary's or any a
  sub-agent forges past the best-effort depth guard — decrements the same
  budget. Spam across turns is not a separate concern: bounded by normal turn
  rate and the user's intent.
- **Cost / wall-clock cap.** Wall-clock cap on each subprocess (initial:
  5 min); output-token cap via the sub-agent CLI's natural settings (initial:
  8K). Hitting either truncates, with the result flagged truncated and a note
  the primary can surface.
- **Recursion cap.** Depth 1 (§3) — a best-effort guard that stops a
  well-behaved sub-agent from recursing; not forgery-resistant in v0 (the
  per-turn cap above is what bounds an adversarial sub-agent's fan-out).
- **Usage attribution.** `UsageManager` records the sub-agent's cost against
  `subAgentId`, not the runner's pinned `agentId`. The per-session usage UI
  surfaces the breakdown as a separate row per agent.
- **Visible attribution in chat.** The primary's resulting chat message is
  naturally attributed to the primary (it's the primary speaking). The
  orchestrator additionally emits a small inline card — "Consulted Codex" /
  "Delegated to Claude" with timing/cost — anchored where the consult happened,
  so the user sees the spawn happened. Status, not a control surface
  (CLAUDE.md §5). Persisted, not emit-only (§7).

### 6. Output is text; review is an optional renderer

The primitive returns the sub-agent's **final assistant message** as text.
That is the whole contract. The primary reads it and does whatever the task
needs — summarize it, act on it, paste suggestions into its own work.

Structured review (the inline review card from docs/125) is now an *optional
layer on top*, not part of the primitive:

- For a review-shaped spawn, the prompt asks the sub-agent to produce its
  findings as text (file + line + comment). The primary relays them into the
  existing review surface, or simply summarizes them in chat.
- If we later want the sub-agent to emit *structured* comments that render
  directly as a review card, we can give it the docs/125 `submit_review_comments`
  MCP tool in the spawn and capture those posts — but that's a review-consumer
  enhancement, **not** a requirement of the spawn primitive, and is out of v0
  scope. The old `submit_diff_review` tool and its bridge/nonce plumbing are
  dropped from this design entirely.

### 7. Chat surfacing

Two distinct surfaces — split along the transient/transcript line CLAUDE.md
draws:

- **The in-flight spinner (transient).** A single "Asking Codex… (typically
  30–120s)" spinner shows at the bottom of the transcript as live activity
  while the `shipit agent` call is in flight. Emit-only (`sub_agent_spawn` WS +
  the `subAgentSpawns` store), correctly disappears on reload — it is live
  activity, not transcript content. Cleared when the terminal card lands.
- **The "Consulted Codex · 47s" card (persisted transcript content).** The
  terminal record of a completed spawn IS transcript content — the user expects
  it to stay *where the consultation happened* and survive a session switch and
  a full reload (the previous emit-only chip floated to the bottom and vanished
  on switch — the recurring ephemeral-card bug class). So it follows CLAUDE.md's
  side-channel-card contract: emitted via `emitChatCard` (live WS
  `sub_agent_consult_card` + in-band record anchored at the spawn's group index +
  immediate persist), a typed `SubAgentConsultCard` on `PersistedMessage`
  (`subAgentConsult`) with its DB column + `toRow`/`fromRow` + migration, listed
  in `CARD_MESSAGE_FIELDS`, and covered by the round-trip + render guard tests.
  Static payload (no client store) — rendered straight from the message field
  and idempotent by `cardId`. Rendered for **every** terminal status
  (success / error / timeout / cancel), since a cancelled or failed consult is
  still a fact the transcript should keep. **Why anchored-inline works live:**
  during the spawn the primary is blocked on the `shipit agent` Bash call, so no
  assistant content streams in those 30–120s — appending the card at the current
  end of the transcript lands it right after the triggering tool call, and the
  persisted `afterGroupIndex` keeps it there on reload.

### 8. Local / dogfood mode

In `RUNTIME_MODE=local`, agents run in-process and credential provisioning is
a no-op (docs/138). Sub-agent spawning in local mode:

- Provisioning helpers (`provisionSubAgentCredentials` /
  `removeSubAgentCredentials`) short-circuit, mirroring docs/138.
- The "spawn sub-agent as subprocess" path mirrors local mode's primary-agent
  flow (in-process spawn rather than container subprocess).
- Setting gate, per-turn cap, cost cap, recursion cap, and the `shipit agent`
  command all behave identically.

## Touchpoints

- **Global settings (`SettingsManager` / settings store)** — add
  `enableSubAgents: boolean` (default false). UI under "Multi-agent
  sessions" with the §1 copy. Orchestrator reads it on every spawn.
- **`shipit` CLI** — new `agent run --agent <id> --prompt-file -` subcommand
  on the shim: read prompt from stdin, read the inherited `SHIPIT_AGENT_DEPTH`
  env (default `0`), POST `{ agentId, prompt, depth }` to the **worker** on
  localhost (`/agent-ops/agent/spawn`), stream stdout from the response, map
  error shapes to non-zero exits. The shim sends no session id.
- **`agent-ops-routes.ts` (worker broker)** — new `/agent-ops/agent/spawn`
  route that injects the trusted `SESSION_ID` (via `orchestrator-client.ts`)
  and relays `{ agentId, prompt, depth }` to the orchestrator's session-scoped
  route, exactly like the other agent-ops subcommands.
- **New orchestrator route** — `POST /api/sessions/:id/agent/spawn`,
  delegating to `services/sub-agent.ts`. Receives the worker-injected session
  id in the path and the forwarded `depth` in the body.
- **New `services/sub-agent.ts`** — `runSubAgent({ sessionId, subAgentId,
  prompt })`. Checks the setting + auth + pin + recursion depth + per-turn
  cap; resolves the sub-agent's provider-account route; provisions creds (§4)
  for a cross-provider spawn; calls worker `/agent/spawn`; on completion runs
  token-sync-back and wipes creds in `finally`; returns `{ status, text,
  truncated, durationMs, costUsd }`. Tracks each in-flight spawn so it can
  SIGTERM the subprocess on cancel/timeout.
- **`session-worker.ts`** — new `POST /agent/spawn` and `POST /agent/cancel`
  endpoints. The handler instantiates the appropriate per-agent adapter
  (`ClaudeAdapter` / `CodexAdapter`) fresh — NOT through the `/agent/start`
  slot — wires events into a **local result accumulator** rather than the
  broadcast SSE, stamps `SHIPIT_AGENT_DEPTH` on the subprocess env. The slot
  (`this.agent`) is untouched. Worker memory holds two CLI processes during a
  spawn window. **This is a meaningful new code path, not a drop-in adapter
  reuse.**
- **`session-credentials.ts`** — add `provisionSubAgentCredentials()` and
  `removeSubAgentCredentials()` (lazy + scoped + reversible + account-correct
  per §4), plus a sub-agent-scoped variant of `syncAgentTokenBack` invoked
  before the wipe. Reuse `provisionProviderAccountCredentials` /
  `providerAccountCredentialRoot` (docs/150/153).
- **`AgentRegistry`** — `refreshAuth(agentId)` and `get(id)?.authConfigured`
  already exist (verified). `AgentRegistry` becomes an `EventEmitter` (new
  public API) and emits `sign-out` (`agentId`) from the sign-out HTTP routes;
  `services/sub-agent.ts` subscribes for the sign-out sweep.
- **Recursion-depth env (`SHIPIT_AGENT_DEPTH`)** — the worker stamps it
  (`= caller depth + 1`) on every spawned subprocess (§3 step 5); the
  `shipit agent` shim reads its inherited value and forwards it as `depth`;
  the orchestrator's authorization check rejects any non-zero `depth`. This is
  a **best-effort** guard against accidental recursion only — `depth` is
  caller-supplied and a shell-capable sub-agent can spoof it (§3); the
  forgery-resistant fan-out bound is the per-turn cap, not this env.
- **Worker memory headroom** — confirm container sizing tolerates a
  +500MB–1GB peak RSS during a spawn window before shipping. Block-shipping
  concern, not a write-now concern.
- **`ContainerSessionRunner`** — add `subAgentSpawnsThisTurn: number`
  (per-turn counter, reset at primary-turn start). No sub-agent slot, queue,
  or SSE machinery.
- **`UsageManager`** — accept a `subAgentId` parameter distinct from the
  runner's `agentId` when recording sub-agent costs.
- **Chat surfacing** — the transient in-flight spinner (`sub_agent_spawn` +
  `subAgentSpawns` store) PLUS the persisted terminal "Consulted Codex" card
  (`sub_agent_consult_card` via `emitChatCard`, `SubAgentConsultCard` on
  `PersistedMessage`, DB column + migration, `CARD_MESSAGE_FIELDS`) (§7).
- **`src/server/shipit-docs/`** — add an agent-facing `agent.md` describing
  `shipit agent run` **when the feature ships** (not before).
- **Integration tests** — `integration_tests/sub-agent.test.ts` covering:
  - Setting off → `shipit agent` returns the disabled error, no creds
    provisioned.
  - Setting on, happy path (cross-provider): primary spawns sub-agent,
    subprocess runs, final text returned on stdout, primary continues turn,
    creds wiped after.
  - Same-provider spawn: no extra credentials provisioned, runs and returns
    text.
  - Account-correct provisioning: multi-account user → sub-agent creds copied
    from the resolved account root, not the flat root.
  - Token-sync-back: sub-agent rotates its OAuth token mid-run → the resolved
    account root's `auth.json` updated before wipe; next session's lazy
    provision starts fresh.
  - Recursion cap (best-effort): a spawned sub-agent whose shim forwards a
    non-zero `depth` is rejected. Companion test documents the known v0 gap —
    a sub-agent that spoofs `depth: 0` is *not* rejected by the depth guard
    and is instead bounded only by the shared per-turn cap.
  - Per-turn cap: 4th spawn in one primary turn returns error without
    spawning.
  - Cost cap: synthetic over-limit output truncated, result flagged.
  - Crash path: subprocess killed → primary sees error, creds wiped.
  - Cancel path: user cancels primary turn during sub-agent → subprocess
    SIGTERMed, creds wiped, command exits non-zero.
  - Sign-out propagation: signing out of the other agent wipes its subtree
    from sessions where it was provisioned for a spawn.
  - Two-CLI memory: primary and sub-agent processes alive concurrently.
  - Local mode: spawn runs in-process, provisioning helpers no-op.

## Security framing

Two layers of gating, plus one honestly-named v0 regression.

1. **Global setting (§1).** The user must explicitly enable `enableSubAgents`.
   Default off. Users who never enable it see docs/138's invariant intact,
   word-for-word, forever.
2. **Lazy + scoped credential provisioning (§4).** Even for users who enable
   the setting, the cross-agent credential window opens only during the
   lifetime of an active *cross-provider* sub-agent subprocess, and a
   same-provider spawn opens no window at all. Outside that window the
   per-session credentials dir holds only the pinned agent's subtree.

**The v0 regression, named honestly:**

- **No write sandbox.** A spawned sub-agent runs full-capability and shares
  the session workspace, so it *can* edit files and run shell. This is the
  conscious "utility first" tradeoff (see "v0 scope"). The mitigations: the
  feature is opt-in (gate), file writes are still committed under the pinned
  agent (attribution holds), and a sub-agent can't push or alter the pin (it
  runs outside the primary's post-turn flow and never becomes the runner's
  agent). The hard sandbox is future work.
- **Doubled cred blast radius during a cross-provider window.** Between
  provision and wipe (typically 30–120s), a supply-chain compromise of
  *either* agent CLI in the container could exfiltrate *both* agents' tokens;
  without the feature it could exfiltrate one. The global setting is the
  user's informed consent. A fuller mitigation (egress broker with scoped
  ephemeral tokens) is the same broker work docs/138 punted as out of scope.
  That decision still holds.

## Future work

- **Hard read-only / write isolation.** Give a spawn a `mode`:
  - `read-only` — genuinely cannot mutate the tree (per-spawn tool allowlist
    where the CLI supports it, or a read-only FS view), for safe second
    opinions.
  - `isolated` — runs in a throwaway `git worktree`; writes land there and the
    primitive returns a **diff** the primary chooses to apply, keeping
    canonical-tree writes primary-attributed. This is the platform's existing
    `isolation: 'worktree'` pattern and the clean way to let a sub-agent
    *do work* without clobbering the shared tree.
  Worktree isolation also closes the enforcement gap that blocks an
  allowlist-only approach today: **Codex's CLI has no per-spawn
  tool-restriction flag**, so an allowlist can't make a Codex sub-agent
  read-only — but a throwaway worktree sandboxes its writes regardless of
  which tools fire.
- **Structured review cards.** Wire the docs/125 `submit_review_comments`
  tool into a review-shaped spawn so findings render as an inline review card
  (§6), following CLAUDE.md's side-channel-card persistence contract.
- **Streaming sub-agent progress.** v0 is silent for the spawn duration
  (just the chip). A future version could stream the sub-agent's intermediate
  output into a collapsible chat region.

## Resolved decisions

Traceability for the product decisions made during design:

1. **Generic primitive, not a review tool.** The primary spawns *any* agent
   with *any* prompt and gets *text* back; review is the first consumer.
   Designing narrowly around review would bake in a rigid system we'd reopen
   on the first non-review use case.
2. **CLI surface (`shipit agent`), not an MCP tool.** The primary invokes via
   the brokered `shipit` shim so it needs no knowledge of the underlying
   CLI's flags, and the design needs no MCP bridge or per-call nonce — the
   shim is already an authenticated per-session channel.
3. **v0 has no hard read-only sandbox; behavior is prompt-shaped.** Utility
   first. Full-capability sub-agent, writes committed under the pinned agent.
   Hard isolation (read-only / worktree modes) is future work.
4. **Output is text.** Structured review cards are an optional renderer on
   top, not part of the primitive.
5. **Recursion capped at depth 1 (best-effort).** A spawned sub-agent is
   blocked from spawning another via a body-carried `depth` guard that stops
   well-behaved recursion; it is not forgery-resistant in v0 (a
   shell-capable sub-agent can spoof `depth`). The per-turn cap (§5), keyed
   by the worker-injected session id, is the forgery-resistant bound on total
   fan-out.
6. **Per-turn cap = 3 spawns.** Bounds runaway loops; generous enough for
   "ask both other models" or a couple of delegations.
7. **Synchronous, not fire-and-forget.** The `shipit agent` command blocks on
   the result; the primary continues its turn with the text in hand. No
   "inject into next turn" mechanism needed.
8. **Cancel = symmetric.** Cancelling the primary's turn cancels the
   sub-agent running on its behalf. No queue, so no "preserve the queue"
   question.

## Implementation status (v0)

v0 is implemented end-to-end behind the `enableSubAgents` global setting
(default off). Key files:

- **Setting (`enableSubAgents`)** — `credential-store.ts`
  (`get/setEnableSubAgents`), `services/settings.ts` + `services/types.ts`
  (`GlobalSettings`), `api-routes-bootstrap.ts` (`PUT /api/settings`), client
  `settings-store.ts` / `Settings.tsx` (`MultiAgentSettings`) /
  `session-data.ts` / `App.tsx` / `message-handlers/global-settings.ts`.
- **CLI surface** — `agent-shim/shipit.ts` (`shipit agent run`,
  `inheritedAgentDepth`, `dispatchAgent`). Reads the prompt from stdin, forwards
  the inherited `SHIPIT_AGENT_DEPTH`, prints the sub-agent's text on stdout.
- **Worker broker** — `agent-ops-routes.ts` (`POST /agent-ops/agent/spawn`,
  unbounded timeout) → orchestrator session-scoped route.
- **Orchestrator route + service** — `api-routes-agent.ts`
  (`POST /api/sessions/:id/agent/spawn`) → `services/sub-agent.ts` (`runSubAgent`
  with the setting/auth/pin/recursion/per-turn-cap gates, lazy account-correct
  credential provisioning, usage attribution, the spawn chip, and token-sync-back
  + wipe in `finally`; `sweepSubAgentCredentialsOnSignOut`).
- **Worker spawn execution** — `session-worker.ts` (`POST /agent/spawn` +
  `/agent/cancel`, a fresh adapter outside the slot, `SHIPIT_AGENT_DEPTH`
  stamping, `cancelAllSpawns` on interrupt/kill), sharing the adapter-run core
  with local mode via `shared/sub-agent-run.ts` (`runAgentToCompletion`).
- **Runner wiring** — `session-runner.ts` (interface + in-process
  `SessionRunner.spawnSubAgent`, `subAgentSpawnsThisTurn` reset in
  `resetRunnerTurnState`), `container-session-runner.ts`
  (`ContainerSessionRunner.spawnSubAgent` → worker).
- **Credentials** — `session-credentials.ts`
  (`provisionSubAgentCredentials` / `removeSubAgentCredentials`, scoped to the
  sub-agent subtree; token-sync-back reuses the existing `syncAgentTokenBack` /
  `syncProviderAccountTokenBack`).
- **Registry sign-out** — `shared/agent-registry.ts` (now an `EventEmitter`,
  emits `sign-out` on a configured→not-configured edge), wired in
  `app-lifecycle.ts`.
- **Usage attribution** — `usage.ts` + a `sub_agent_id` column migration in
  `shared/database.ts`.
- **Chat surfacing** — transient spinner: `ws-server-messages.ts`
  (`WsSubAgentSpawn`, narrowed to the in-flight announcement), client
  `session-store.ts` (`subAgentSpawns` + `removeSubAgentSpawn`),
  `message-handlers/sub-agent-spawn.ts`, `MessageList.tsx`
  (`SubAgentSpawnChipRow`). Persisted terminal card:
  `domain-types.ts` (`SubAgentConsultCard`), `ws-server-messages.ts`
  (`WsSubAgentConsultCard`), `services/sub-agent.ts` (emits via `emitChatCard`,
  all terminal statuses + a throw-path error card), `chat-history.ts` +
  `database.ts` migration (`sub_agent_consult` column), `visual-elements.ts`
  (`CARD_MESSAGE_FIELDS`), client `message-handlers/sub-agent-consult-card.ts`,
  `MessageList.tsx` (`SubAgentConsultCardRow`).
- **Agent-facing doc** — `src/server/shipit-docs/agent.md`.

Tests: `shared/sub-agent-run.test.ts`, `services/sub-agent.test.ts`,
`session-credentials.test.ts` (sub-agent block), `shared/agent-registry-signout.test.ts`,
`agent-shim/shipit.test.ts` (`agent run` block), client
`message-handlers/sub-agent-spawn.test.ts`.

Deferred from the plan's full test list (the v0 behavior is covered at the
unit/service level above rather than through a Docker-backed integration run):
the two-CLI-memory floor confirmation and the live token-rotation-mid-run
assertion. See `checklist.md`.

## Out of scope
