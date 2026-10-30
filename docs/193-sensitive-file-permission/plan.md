---
issue: planning#114
description: Surface an agent-agnostic approve/deny card when an agent's edit to a sensitive file (or escalated action) is gated, so the user can grant it.
---

# 193 — Sensitive-file permission prompt (planning#114)

Requirements: [requirements.md](requirements.md). They cover the 2026-10-12
incident and planning#711; the first design below is older than the requirements
rule.

## Context

ShipIt runs every agent CLI headless. Each backend has a built-in permission gate
for sensitive actions — Claude classifies files like `.npmrc` / `.env` as
sensitive and prompts before editing them (even when `Write`/`Edit` are
allowlisted); Codex's app-server can raise a blocking approval request for an
escalated command or file change. Headless, there is no human at the prompt, so:

- **Claude** auto-**denied** the gated edit (`"Claude requested permissions to
  edit <path> which is a sensitive file"`), and **no approve/deny UI ever
  appeared** — an approved, benign change became unwriteable. The agent couldn't
  route around it either (Write, then `cat >`, then `printf >>` all re-gated).
- **Codex** silently **auto-approved** every escalation — the opposite failure:
  the user never saw the gate at all. A later implementation routed every
  native approval RPC through the broker, but Codex can emit those RPCs for
  ordinary commands and workspace changes even under `approvalPolicy: "never"`,
  causing repeated approval cards after worker recreation. ShipIt now uses the
  v1/v2 payload's explicit extra-access fields (`reason`, `grantRoot`, network
  context, or policy amendments) as the broker boundary; requests without such
  evidence are immediately accepted inside the isolated worker container.

The gate is correct in intent; the defect was the missing grant affordance. This
feature adds one — an **agent-agnostic** approve/deny (+ remember) card that any
backend plugs into, so a gated action becomes a real, user-answerable prompt
rather than a dead-end or a silent bypass.

## How it works

A worker-owned **`PermissionBroker`** is the single locus. It holds pending
requests, the per-session "remember" allow-set, broadcasts the canonical
request/resolved events, and resolves uniformly — regardless of which agent
raised the request.

```
Claude:  CLI gate ──(--permission-prompt-tool)──▶ mcp-permission-bridge
                                                       │ POST /request → { requestId }   (returns immediately)
                                                       │ POST /await   (bounded long poll, repeats until answered)
Codex:   app-server requestApproval ──(injected requestPermission)──▶ PermissionBroker.request() (direct await)
                                                       ▼
                                            PermissionBroker.openRequest() / poll()
                                              │ broadcast agent_permission_request (SSE agent_event)
                                              ▼
                          orchestrator agent-listeners → emitChatCard → PermissionRequestCard (persisted, pending)
                                              │ also → sseBroadcast session_attention (cross-session sidebar signal, Thread C)
                                              │
                              user clicks Approve/Deny(+remember) → resolve_permission (WS)
                                              ▼
        ProxyAgentProcess.resolvePermission → /agent/permission/resolve → PermissionBroker.resolve()
                                              │ unblocks the bridge's next poll / the awaited RPC → action proceeds/denied
                                              ▼ broadcast agent_permission_resolved
                          agent-listeners → updatePermissionCard + permission_resolved (WS) → terminal card
```

### Resilient long poll + idempotency (Thread B)

The Claude bridge originally held ONE HTTP fetch open for the entire wait. When
the user took their time — or stepped away to another session entirely — that
fetch tripped undici's headers/body timeout and surfaced as `"fetch failed"`.
The bridge then failed closed, the CLI denied the edit, and the model retried,
**stacking a fresh permission card each loop**. Fix:

- **`openRequest()` + `poll()` replace a single blocking `request()` HTTP call.**
  `POST /agent-ops/permission/request` registers and returns `{ requestId }` (or
  `{ behavior }` for a pre-approved action) immediately; `POST
  /agent-ops/permission/await` holds for a BOUNDED window (≤25 s) and returns
  `{ behavior }` once answered or `{ pending: true }` to poll again. Short holds
  mean a slow user never trips a client timeout; a brief worker unreachability
  is a quick failed poll the bridge retries with exponential backoff rather than
  a hard failure. It only fails closed on a real 4xx/5xx rejection or sustained
  unreachability.
- **Idempotency on `toolUseId`.** A still-pending request for the same gated
  call re-attaches to the one card (no second broadcast), so a retried/duplicated
  open can't stack a duplicate. A genuine model retry carries a new `toolUseId`
  and correctly gets its own card.
- **Codex is unchanged.** Its app-server approval RPC is a one-shot native
  blocking channel, so its adapter still calls `broker.request()` and awaits the
  decision directly (no HTTP timeout to ride over).

### Cross-session attention signal (Thread C)

A session blocked awaiting a permission answer is invisible to a user focused on
another session. The orchestrator now tracks the outstanding requestIds per
runner (`SessionRunner.awaitingPermissionIds`) and broadcasts a global SSE
`session_attention` event (live toggle + connect snapshot). The client feeds it
into the existing `computeAttentionReason` derivation as the highest-priority
reason ("Needs your approval to continue" — it outranks the `isAgentRunning`
short-circuit because the agent IS held inside the gated call), so the sidebar
border, tooltip, and `useAttentionNotifications` all light up from one place.
This is the smallest useful slice of the larger unbuilt docs/060 notification
center.

### Card copy is generic, not a reason ShipIt doesn't know (Thread D)

ShipIt has **no sensitive-file matcher of its own** — the classification is
entirely the backend CLI's. The card therefore says "needs your approval" rather
than the old hard-coded "which is a protected file", which mislabeled
plan-mode-gated or otherwise-gated ordinary files as "protected."

Key properties:

- **The turn stays alive** while a request is pending (the CLI/app-server is
  blocked inside the tool call), so — unlike AskUserQuestion — there's no
  interrupt/resume. Approving lets the agent's *next write* succeed directly.
- **No prompt spam.** Claude's `--permission-prompt-tool` only fires for
  "ask"-tier calls; allowlisted working-dir edits still auto-approve. Codex only
  routes native requests to the broker when their payload explicitly requests
  extra filesystem, network, or execution-policy access; routine v1/v2 command
  and workspace-change requests receive the native allow decision directly.
- **ShipIt-handled interrupt tools are never gated.** `AskUserQuestion` and
  `ExitPlanMode` are control-class tools ShipIt resolves via its own
  interrupt/resume flow (question card / PlanApproval card), but the Claude CLI
  still routes them through `--permission-prompt-tool`. The broker auto-allows
  them (`HANDLED_INTERRUPT_TOOLS` in `permission-broker.ts`) with no card — the
  CLI then emits the `tool_use` and the normal interrupt flow renders the right
  card. Without this, a dead-end approve/deny card appeared in place of the
  question/plan card.
- **Remember** is a per-session, per-path allow-set in the broker: an approved
  "remember" auto-allows later requests for the same file with no card.
- **No ShipIt-imposed deadline, but no card outlives the agent's wait.** A
  permission decision is the user's, so the broker has **no timeout** — a
  pending prompt stays answerable for as long as the backend holds the call open.
  The backend can stop waiting on its own, though, and then the card becomes
  **Denied** and the session stops asking for attention: the worker settles the
  request as deny and broadcasts `agent_permission_resolved`, which the
  orchestrator handles like a user's Deny, except that a call that ended before
  anyone answered also gets a reason line (req 8). Three signals, one per way the
  wait ends:
  - **The gated call gets a result** (`PermissionBroker.endToolUse`, called by
    `agent-controller.ts` for every `tool_result` id). This is the Claude
    timeout: the CLI ends an MCP call that sends no response or progress for
    `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` (30 min for stdio), emits an error
    `tool_result` for the gated `tool_use`, and **never sends
    `notifications/cancelled`** — verified against Claude Code 2.1.284 with a
    never-answering `--permission-prompt-tool`. The bridge therefore kept
    polling, and the card stayed Approve/Deny forever, holding the session in
    "Needs your approval". Stop takes the same path: a streaming-mode interrupt
    also yields the gated call's `tool_result` (verified the same way).
  - **Codex clears its own request** (`serverRequest/resolved` for a JSON-RPC id
    still awaiting the broker). The Codex handler aborts the `signal` it passed
    in `PermissionRequestInput`, and does not answer a request Codex already
    dropped.
  - **The agent process exits** (`clearPending`, on `done`/`error`).

  A request the user already answered is never re-announced. The broker is
  shared by successive agent processes, so an exit clears it only while the
  exiting process still holds the slot; a kill clears it at the kill, before a
  replacement can open a request that a late exit event would otherwise deny.
  **The orchestrator denies what the worker cannot.** A dead worker cannot
  broadcast, and a worker still on an image from before this rule stays silent
  on exit. So `permission-cards.ts` `denyAbandonedPermissionCards` gives every
  id still in `runner.awaitingPermissionIds` the same transition as a user's
  Deny, at each place the orchestrator learns the agent is gone: the agent
  process's exit (`turn-executor.ts`, a `postTurnStep` so the commit cannot be
  skipped) and error (`agent-listeners.ts`), both only while that process still
  holds the runner's agent slot; a turn the worker reports as having no agent
  (`turn_abandoned`, wired in `runner-registry-factory.ts`, which also finalizes
  that turn's rows — nothing else does, and the next turn's `replaceInProgress`
  would delete the denied card with them); and a container exit
  (`handleContainerExited`, before the partial turn is saved). Each call is
  guarded so a failed write cannot skip the commit or the queue release that
  follows it. A runner
  disposed with `preserveAgent` at shutdown is deliberately not a trigger: its
  worker lives on for restart adoption. Every transition — the user's answer,
  the worker's deny, this backstop — goes through `settlePermissionCard`, which
  uses `persistCardTransition`, so a card settled after its turn finished is
  patched in its row instead of rewriting that finished turn as in-progress.

  **Saved cards are checked against the worker when a runner first reaches it.**
  The backstop knows a request only through the in-memory
  `awaitingPermissionIds`, which an orchestrator restart empties, and a new
  container holds none of its predecessor's requests. So `/agent/status` reports
  `pendingPermissionIds` (the broker's unanswered requests), and
  `ContainerSessionRunner` `reconcileSavedPermissionCards` uses the status reading
  that turn adoption already made — one reading, so adoption and this check
  cannot disagree — before the first SSE connect, so no card can be saved while it
  runs. A runner whose container is still being created uses an empty list: that
  container has never held a request. Then `reconcilePermissionCards` compares
  the list with the session's saved pending cards (`pendingPermissionRequestIds`):
  a card the worker still waits on goes back into `awaitingPermissionIds` and
  re-sends the attention signal, so the backstop covers a worker that dies later;
  every other card is denied through `settlePermissionCard`. Without an agent in
  the runner (no turn was adopted), nothing can relay the user's answer or the
  worker's result, so every saved card is denied. A denied card in the rows of a
  turn that ended during the restart stays in history because those rows are
  finalized when the worker reports the turn ended or the session gets a new
  container (docs/240-turn-survives-orchestrator-restart, section 5).
  The check is skipped when the status probe fails or the worker image predates
  the field; the next runner or container checks again.

  Cards left pending by builds before this rule are denied once by a database
  migration (`STALE_PERMISSION_CARD_MIGRATION`) — only those older than Claude's
  30-minute idle timeout, since a session worker outlives an orchestrator
  restart and a younger card may still be answerable.
- **Fail-safe.** The Claude bridge fails *closed* (a broker/transport error → a
  deny envelope, never an unconfirmed proceed). Codex falls back to its historical
  auto-accept only when no broker is wired or the broker path throws (never hangs
  a turn).
- **Persisted** like every transcript card (docs/188 contract): the card and its
  approved/denied terminal state survive a reconnect, switch, and reload. A
  still-pending card comes back actionable after a reload — the worker holds the
  request, so the user can answer it later.
  - **Mid-turn resolution must patch the recorded card, not just the DB row.**
    Unlike bug-report (docs/164) / issue-write (docs/177) cards — which resolve
    *after* their proposing turn finalizes, so a DB-only `updateXCard` is safe —
    the permission card resolves *while the agent is still blocked mid-turn*. Its
    proposing row is still `in_progress=1`, so the next `replaceInProgress`
    rebuild re-inserts from the turn's `recordedCards` (still holding the pending
    snapshot) and **clobbers a DB-only `updatePermissionCard` patch back to
    pending** — the card reverted to its Approve/Deny variant on the next
    switch/reload. Fix: `settlePermissionCard` patches the *recorded card* in
    place and rewrites the in-progress turn (`persistCardTransition`,
    `chat-card-persistence.ts`), so every rebuild and the final end-of-turn
    persist carry the terminal phase; it falls back to the DB-row
    `updatePermissionCard` when the turn no longer owns in-progress rows or the
    card isn't in its recorded set. This mirrors the `emitOrReplaceChatCard`
    rationale used by docs/203's mid-turn re-review.
  - **A mid-turn card must also advance the turn-event replay cursor (the
    "pending card vanishes on switch" bug, planning#114).** `emitChatCard` persists a
    snapshot of the turn-so-far the instant the card fires — but a gated tool's
    `agent_assistant` event sits *unpersisted* in the turn-event buffer
    (`lastPersistedBufferIndex` only advanced at tool-result / agent_result
    boundaries). So the snapshot sat **ahead** of the buffer cursor. On a session
    switch / WS reconnect, the orchestrator replays `buffer.slice(cursor)` *on
    top of* that snapshot; the buffered pre-card `agent_assistant` then merges
    into the card's carrier message — which `loadSessionHistory` marked
    `streaming: true` (in-progress → streaming) — and the client's streaming
    merge (`agent-event.ts`) rebuilds the message from a fixed field set,
    **dropping `permissionPrompt`**. The card showed only after the agent
    *stopped* (interrupt clears the buffer). Fix (two layers): `emitChatCard`
    advances `lastPersistedBufferIndex` past the buffer after persisting — the
    same thing the tool-result boundary does — so no buffered event overlaps the
    snapshot; and the client never treats a card-carrying message as a merge
    target (it falls to close-and-append, which preserves the card via `...m`).
    This protects **every** mid-turn card, not just permission.

## A write outside the workspace, and a call that waits with no answer

On 2026-10-12 an agent moved a scratch directory to `/persist`, left a symlink to
it in the workspace, and started 8 background subagents. The first write of each
subagent through the symlink raised a card. No user was connected, the main agent
got no result and no notice, and the oldest call waited 20.5 minutes.

### What the Claude CLI gates (measured)

Claude Code 2.1.293, started with ShipIt's own flags and
`/etc/shipit/managed-settings.json`, with a `--permission-prompt-tool` that records
each request. `link` is a symlink in `/workspace`. The main agent and a background
`Agent` subagent gave the same result in every row that both ran (the first
seven; the main agent alone ran the others).

| Call | Target of `link` | Request before the fix | With the fix |
|---|---|---|---|
| Write `link/f` | `/persist/d` | yes | no |
| Edit `link/f` | `/persist/d` | yes | no |
| Bash `echo x > link/f`, `cat > link/f <<EOF` | `/persist/d` | yes | no |
| Read `link/f` | `/persist/d` | no | no |
| Write, Edit `/persist/d/f` (real path) | — | no | no |
| Bash `echo x > /persist/d/f`, `cp -r`, `mv` to `/persist/d` | — | no | no |
| Write to an ordinary workspace file | — | no | no |
| Bash `cp`, `mkdir -p`, `touch`, `sed -i`, `tee`, `mv` to `link/…` | `/persist/d` | yes | no |
| Bash `python3 -c "open('link/f','w')"`, `cd link && echo z > f` | `/persist/d` | no | no |
| Write `link/f`, Bash `echo x > link/f` | `/tmp/d` | not run | yes |
| Write `/tmp/d/f` (real path) | — | not run | no |

So the symlink is the trigger, and `/persist` is not. A file tool, or a shell
command whose target the CLI reads from the command text, asks when the path goes
through a workspace symlink to a place outside the CLI's working directory. The
same write by the real path does not ask, and neither does a command whose target
the CLI cannot read (the two rows with `python3` and `cd`). This explains the two
observations of the incident: `mv` and `cp -r` to `/persist` named the real path,
and the subagent's `cat > file <<EOF` named a path through the symlink. The bare
`Write`, `Edit` and `Bash` entries of `--allowedTools` cover a real path anywhere;
they do not cover the target of a symlink, and `Edit(**)` in the managed settings
is relative to the working directory.

### `/persist` agrees with the gate (req 1)

`docker/agent-hooks/managed-settings.json` allows `Edit(//persist/**)`, the real
path. Only `Edit(path)` rules are path-matched, and that one rule covers Write and
NotebookEdit as well (docs/097-explicit-session-agent-permissions, "How the CLI
reads a path rule"). With it no call in the table asks for a `/persist` target,
and a symlink to another outside place still asks, so the rule opens `/persist`
and nothing else. Measured again with Claude Code 2.1.300 on 2026-10-28, with
the ignored `Write(//persist/**)` and `NotebookEdit(//persist/**)` rules removed:
Write, Edit and a shell write through a symlink into `/persist`, NotebookEdit by
the real path and through the symlink, and Glob outside the working directory
all ran with no request; a symlink to `/var/tmp` still asked. ShipIt recommends `/persist` for
scratch work, and a link from the workspace to it is the natural way to keep a
path stable, so the write is allowed and is not documented as one that asks.

Two other ways were measured and not used:

- `--add-dir /persist` also removes the requests, but the CLI then loads skills
  from `/persist/.claude/skills` (a probe skill there appeared in the CLI's
  `init` event). `/persist` is written by the agent, never reviewed in a pull
  request, and kept across container restarts, so it must not become a source of
  agent instructions.
- `permissions.additionalDirectories: ["/persist"]` in the settings also removes
  the requests and did not load the probe skill. It makes `/persist` a working
  directory, which is more than a write permission and can gain more meaning in a
  later CLI version. The path rules say exactly what is granted.

The rule that stays — a symlink from the workspace to another outside place asks
— is in `/shipit-docs/environment.md`, "Writes that wait for the user's
approval", with the sensitive-file case.

**Other harnesses.** Read from their start settings, not run (a Claude session
holds no credentials for them): Codex starts with `sandbox_mode="danger-full-access"`
and `approval_policy="never"`, and only a request with explicit extra-access
fields reaches the broker; OpenCode runs with `--auto` and has no approval path;
Grok runs with `--always-approve` by default; Antigravity skips permissions. None
of them can raise a card for a `/persist` write with these settings. Not known:
what Grok's `guarded` mode and OpenCode do with a path outside the working
directory.

### The main agent learns that a subagent's call waits (req 2, req 3)

**What a request carries.** The CLI calls the permission tool with `tool_name`,
`input` and `tool_use_id` (and `_meta["claudecode/toolUseId"]`, the same id). It
carries no id of a parent call and no agent id. The event stream does: the
`assistant` event that holds the gated `tool_use` has `parent_tool_use_id`, the
id of the `Agent` call that the subagent runs under. So the worker joins the two.
`SubagentCallTracker` (`permission-broker.ts`) keeps the open tool calls of the
agent process: the main agent's own, and each subagent call with its `Agent`
call. `AgentController` feeds it from `agent_assistant` and `agent_tool_result`,
and the permission endpoint asks it for the request's `toolUseId`. The answer goes
out on `agent_permission_request` as `subagent`:

- absent: the main agent's own call.
- `foreground`: the `Agent` call is still open, so the main agent waits inside it.
- `background`: the `Agent` call returned before the subagent's call. A
  background `Agent` call returns when it starts its subagent.

**The line.** For a `background` request, `watchPermissionWait`
(`permission-wait-notice.ts`) starts a timer. After `PERMISSION_WAIT_NOTICE_MS`
(2 minutes) it steers one `[ShipIt]` line into the running turn, by the dispatch
that the session inbox uses (`whenBusy: "steer-or-refuse"`, best effort). The
line lists every background request that still waits and that the agent was not
told of, says how long the oldest has waited, the time it was written, and
whether a user has the session open. A request is in one line only.
`runner.awaitingPermissionIds` is the only record of what still waits, so every
way a request ends (`settlePermissionCard`) also ends its part in the line.

**The join can lose a race, so the endpoint waits for the stream.** The stream
showed the gated call 14 to 16 ms before the request reached the permission tool
(two runs, small input). A call with a large input is written to two pipes at the
same time, so its request can reach the worker first. `whenOpened` holds the
endpoint until the stream shows the call, for at most 250 ms; after that the
request counts as the main agent's and gets no line.

Measured with the CLI: a line written to the CLI's input while a background
subagent waited was read by the main agent at its next tool boundary, 3 seconds
later; the main agent stopped the subagent with `TaskStop`, the gated call got an
error result, and that is the result `endToolUse` turns into a denied card.

**Limits, each on purpose.**

- **A call of the main agent, or of a foreground subagent, gets no line.** The
  main agent is inside that call and reads nothing until it returns, so the line
  would arrive after the request ended. Only the bound proposed below can help
  there.
- **The orchestrator starts no turn for the line.** A session whose turn ended
  while its subagents work has no turn to steer. A dispatch there starts a turn,
  and a new turn can replace the resident process together with the subagents
  (docs/328-session-message-inbox, "Guards on the started turn"). The timer looks
  again every `PERMISSION_WAIT_RETRY_MS`, so the next turn that runs gets the
  line. In the incident the main agent's turn was running. One case is not the
  orchestrator's to prevent: a line that reaches the worker just after the turn
  ended is given to the resident CLI, which answers it in a turn of its own on
  the same process (`/agent/message` in `agent-controller.ts`, the late steer of
  docs/140-live-steering). The subagents stay; measured with the CLI.
- **The line needs live steering.** With the setting off no turn takes a steer,
  and the agent gets no line.
- **The line is sent at most one time.** When the worker does not take it (it
  does not answer), the line is dropped and not sent again. It informs; nothing
  depends on it, so it has no delivery record like the inbox has.
- **After an orchestrator restart there is no line** for a request from before
  it: the timers are in memory, and the saved card does not record `subagent`.
- **A subagent of a subagent** is not followed up to the main agent's call.
- A user who is present changes nothing: the card stays answerable, and the line
  only informs the agent (req 4).

### Proposal, not built: a bound for a card that nobody can answer (req 5)

The line gives the agent a choice, but an agent that waits inside the gated
call, and a session with no running turn, still wait for the harness's own
timeout (30 minutes for the Claude CLI). A bound would cover both. Proposed: when
a request has waited **10 minutes** and no viewer was attached to the session at
any time in those 10 minutes, the orchestrator answers it as denied, with a
message that says nobody was connected, and the caller gets that message as the
call's result. 10 minutes is a third of the harness's timeout and far longer than
a reconnect.

Why it is not in this change:

- **It makes a server decision depend on whether a browser is connected.** The
  transport rule says that a WebSocket's lifecycle must not drive server
  behavior. A periodic check that reads viewer presence, as the idle enforcer
  does for container reclaim (docs/284), is not a lifecycle handler, and 10
  continuous minutes is not a blip. It is still the first time that viewer
  presence would change what an agent's call returns, so a human must accept it.
- The card needs a state of its own ("expired — nobody was connected"). Today a
  card denied by the harness and one denied by the user read the same, and the
  CLI's result text says "The user doesn't want to proceed" for a wait that no
  user ended. That text comes from the CLI; a ShipIt deny can carry its own.
- req 4 must hold: a user who opens the session before the bound keeps unlimited
  time.

The owner decided on 2026-10-29 not to build it, and to add no card state: a
card that nobody answered keeps **Denied** and gets a reason line (req 8;
requirements.md, "Resolved questions").

## A wait that nobody answers (planning#711)

In 529 sessions from 2026-09-23 to 2026-10-28, 26 calls in 15 sessions waited
for an approval that nobody gave, until the CLI's 30-minute timeout. The user
away from the screen got no alert, and the agent got only the CLI's error text.

### What still asks (measured)

Claude Code 2.1.300, ShipIt's flags and the repository's
`docker/agent-hooks/managed-settings.json`, with a probe
`--permission-prompt-tool` that records each request:

| Call | Request | With an allow rule for the path |
|---|---|---|
| Write `.claude/skills/x/SKILL.md` | yes | yes (`Edit(//<repo>/.claude/**)`, `Edit(.claude/**)`, `Edit(/.claude/**)`) |
| Edit `.claude/skills/x/SKILL.md`; Write `.claude/skills/x/SKILL.md` through `.claude/skills` → `../.agents/skills` | yes | — |
| Write, Edit, Bash `rm -rf` of `.agents/skills/x`, with `.claude/skills` → `../.agents/skills` | no | — |
| Bash `mkdir -p .claude && ln -s ../.agents/skills .claude/skills`; `mv .claude/skills .agents/skills` | yes | — |
| Bash `rm -rf` of `.claude/skills/x`, or of a `.claude` folder in `/tmp` | yes | — |
| Bash `rm -rf <dir>/.git` | yes | yes (`Bash(rm -rf:*)`, `Edit(//<dir>/**)`) |
| Bash `rm -f .gitconfig`, `rm -f ~/.gitconfig`, `rm -f /tmp/…/.gitconfig`, `echo x >> .bashrc` | yes | yes (`Edit(.gitconfig)`, `Edit(**/.gitconfig)`) |
| Bash `rm -rf` of an ordinary folder in `/tmp`, `/persist` or the working folder; also depth 1, two paths, a glob, a variable, `cd … &&`, `..`, `rm -r`, `--permission-mode auto` | no | — |
| Bash `git config --global …`, also after `cd`, with `HOME` changed, with `GIT_CONFIG_GLOBAL` unset, and in auto mode; `git config --file ~/.gitconfig …`, `git config --file /tmp/…`, `git -C <dir> config …` | no | — |
| Bash `git rm -r --cached .claude/skills/x` | no | — |
| Bash `cat ~/.gitconfig` | no | — |

So the CLI asks for a write or a delete whose target it can read when the target
has a `.claude` segment, is a `.git` folder (measured with `rm -rf` only) or is a
file it treats as sensitive, and no allow rule that was tried removes the
request. Two causes that planning#711 inferred did not
reproduce: `git config --global` and `git rm --cached .claude/…` do not ask, and
an ordinary `rm -rf` does not ask. The recorded cases most likely named a `.git`
or `.claude` path or a sensitive file; the transcripts are not in this
container, so that is not checked. A session container also sets
`GIT_CONFIG_GLOBAL=/credentials/.gitconfig`, so `git config --global` does not
touch `~/.gitconfig`.

Nothing in ShipIt's settings can change this, apart from Auto mode (req 9,
below), so `/shipit-docs/environment.md`
("Writes that wait for the user's approval") lists what asks and the forms that
do not, and `/shipit-docs/skills.md` tells the agent to write Claude skills at
`.agents/skills/` behind a `.claude/skills` symlink, as this repository has done
since `c15fa77c2`.

The timeout result, measured with a probe tool that never answers:
`MCP server "probe" tool "permission_prompt" sent no response or progress for
30s; aborting. If this server is configured in your MCP settings, set a
per-server "timeout" (ms) …; otherwise set CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT (ms)
globally (0 disables).` `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT=20000` gave 30 s. The
CLI sends no `notifications/cancelled`.

### The alert (req 6)

`agent_permission_request` calls `deliverVoiceNote` with the source
`"permission"` and a headline from `derivePermissionHeadline`: the kind of call
("to run a command", "to change a file") and the choice, never a path. The voice
note router does the rest as for a question or a plan: a voice note card in
native mode, a webhook post in external mode, both in both.

The note goes out when the session **starts** to wait — when
`runner.awaitingPermissionIds` was empty — not for each card. That is the same
edge on which the sidebar mark turns on and `useAttentionNotifications` chimes,
so the three alerts agree. On 2026-10-12, 8 background subagents opened a card
each; one note per card would have played 8 headlines and posted
8 webhooks for one thing the user must do. A card that opens while another
waits adds no alert; one that opens after every card is answered starts a new
wait and a new note.

### The agent's notice (req 7)

The broker's deny already tells why the wait ended, internally: `endToolUse`
(the gated call got its result), an aborted `signal` (Codex withdrew the
request, for example when its turn is interrupted) or `clearPending` (the agent
process exited). In the first two the agent stopped waiting while it still
runs, so those add `callEnded: { summary }` to `agent_permission_resolved`; an
exit adds nothing, because the turn that would read the line is gone with the
process. The orchestrator settles the card as before and
then parks `buildUnansweredPermissionNotice` with
`sessionManager.appendPendingAgentNotice`, so the next turn starts with a
`[ShipIt]` line that names the call, says that nobody answered and nobody denied
it, and that it did not run.

- **A user's Stop gets no notice.** A one-shot CLI's interrupt also gives the
  gated call a result, and Codex withdraws its request on an interrupt, so the
  orchestrator skips the notice when `stoppedByUser(runner)`. A streaming Stop
  kills the process, which is `clearPending`.
- **The text names the Claude timeout only as a condition** ("if its result
  said that the MCP tool `permission_prompt` sent no response"), because the
  same flag also comes from `TaskStop` and from Codex.
- **Two calls with the same summary give one line.**
  `appendPendingAgentNotice` drops a notice that is already parked word for
  word; the agent still learns that this call did not run.
- **A subagent that the main agent stopped gets the notice.** `TaskStop` gives
  the subagent's gated call a result too. The line is true there (nobody
  answered, the call did not run), and the main agent already knows it.
- **The card keeps "Denied"** and gets a reason line, below (req 8).
- **A worker on an older image** sends no `callEnded`, so no notice.
- The text is inline in `permission-wait-notice.ts`, like the one-line notices
  in `gpu-container-start.ts` and `abandoned-rebase-sweep.ts`.

### The card's reason line (req 8)

The condition of the notice decides the line: `callEnded`, and not
`stoppedByUser(runner)`. `agent-listeners.ts` then passes `unanswered` to
`settlePermissionCard`, which puts it in the same patch as `phase: "denied"`. So
it is in the persisted card (`PersistedPermissionRequest.unanswered`, inside the
`permission_prompt` JSON, so no new column) and in `permission_resolved`, and a
reload, a session switch and a reconnect show it. `PermissionRequestCard` shows
it under "Denied · <call>": "Nobody answered in 30 min".

- **The duration is measured, never assumed.** The broker records when it
  opened the request (`performance.now()`, so a clock change cannot alter the
  wait), and `expire` adds `waitedMs` to `callEnded`. The
  orchestrator does not write the CLI's 30 minutes: a Codex withdrawal can come
  at any time, and an environment can change the CLI's timeout. The worker
  outlives an orchestrator restart, so the measurement does too.
- **No measurement, no duration.** A worker on the image of #3292 sends
  `callEnded` with no `waitedMs`; that card, and one that waited less than a
  second, reads "Nobody answered before the call ended".
- **A user's Deny or Stop gives no line**, and neither do an agent exit and the
  orchestrator's own denies (`denyAbandonedPermissionCards`,
  `reconcilePermissionCards`): none carries `callEnded`.
- **A turn that ended while the orchestrator was down loses the line.** On
  reconnect to a worker with no active turn, `container-session-runner.ts`
  skips the stream (`fastForwardLastSeenSeq`), so that turn's `callEnded` never
  arrives, and `reconcilePermissionCards` denies the saved card with no reason.
  The req 7 notice is lost the same way. A turn still running at the restart is
  adopted and its events are replayed, so it keeps both.
- The text is the client's (`unansweredReason`), from the stored data, with
  `formatIdleDuration`, the formatter of the health strip's idle time.

## Claude in Auto mode asks for nothing (req 9)

ShipIt's Auto mode starts the Claude CLI in its own `default` mode with
ShipIt's tool allowlist. In that mode the CLI still asks for every call in
"What still asks" and for a symlink out of the working folder, and each ask
became a card. The other harnesses never ask in their auto modes ("Other
harnesses" above).

So `/agent-ops/permission/request` answers `{ behavior: "allow" }` at once, with
no card, when `AgentController.approvesEveryCall` is true: the resident agent
is Claude and its mode is Auto (`undefined` or `"auto"`). The mode is the start
params' mode, then each `/agent/permission-mode` change and each mode the CLI
reports (`reportedPermissionMode`: an init's mode, a main-thread
`EnterPlanMode`), so it follows a plan-mode entry and a Guarded turn that the
CLI ran as `default`. Plan and Guarded keep the card. When Auto takes effect
while a card from another mode still waits — the user steers in Auto mode — the
worker allows every unanswered request (`notePermissionMode`), so no call stays
held. The endpoint reads the mode after its wait for the stream
(`subagentCaller`), with no `await` between that check and the card, so a
change to Auto during the wait cannot leave a card behind.

A late request from a process that was already replaced gets the answer for the
new process's mode, because the bridge sends no process identity. This is not
guarded: `/agent/start` refuses while a process holds the slot, and the kill
signals the old CLI's whole tree, MCP bridge included (`killProcessTree`), so
the answer reaches at most a process that is ending. The kill does not wait for
the exit.

A request that waits in `subagentCaller` across a kill opens a card after
`clearPending`, with no process behind it, in every mode. That race is older
than req 9. In Auto mode the next process's first mode report allows it, so the
card reads Approved.

What still holds in Auto mode: a deny rule resolves before the CLI calls the
permission tool, so the managed settings' deny list still refuses, and the
`PreToolUse` branch hook still runs.

Measured on 2026-10-30 with Claude Code 2.1.300 and Haiku, through a
`SessionWorker` built from source with the real `ClaudeAdapter`, ShipIt's flags
and the shipit bridge. The prompt was to Write `.claude/probe-<nonce>.txt`; the
CLI's init reported `default` in each run.

| Run | Endpoint calls (reply) | Cards | File written |
|---|---|---|---|
| `approvesEveryCall` forced false (the behaviour before this change); the probe denied the card | 1 (`requestId`) | 1 | no |
| As built | 1 (`allow`) | 0 | yes |
| As built, with `--settings` denying `Edit(//<ws>/.claude/**)` | 0 | 0 | no |

Two other ways were not used:

- **`--permission-mode bypassPermissions` for Auto.** It changes the CLI's own
  mode, which restart adoption and the init check read
  (`cliPermissionModeToApplied` knows only `plan`, `auto` and `default`), and
  what the CLI still protects in that mode was not measured.
- **No `--permission-prompt-tool` in Auto.** A headless CLI then denies every
  ask, which is the defect this feature started from.

Not affected: Codex raises its requests through `setPermissionRequester`, not
this endpoint; a one-shot agent from `shipit agent run` gets no permission tool,
so its CLI denies what it would ask and no card appears; local mode has no
worker.

## Agent-agnostic seam

The canonical core is agent-neutral; each adapter only translates its native
mechanism to/from it:

| Piece | Shared (agent-neutral) | Claude | Codex |
|---|---|---|---|
| Raise a request | `PermissionBroker.request` | `mcp-permission-bridge` → `/agent-ops/permission/request` | `setPermissionRequester` injected → `handleServerRequest` |
| Surface the card | `agent_permission_request` event → `emitChatCard` → `PermissionRequestCard` | (same) | (same) |
| Resolve | `resolve_permission` WS → `/agent/permission/resolve` → `broker.resolve` | bridge's next `/await` poll returns the allow/deny envelope | JSON-RPC `{decision:"accept"\|"reject"}` |
| Persist | `permissionPrompt` `PersistedMessage` field + card store | (same) | (same) |

A future backend implements `setPermissionRequester` (or bridges to
`/agent-ops/permission/request`) and gets the card for free.

## What the card shows, and what the card must not break

Two things the live production build got wrong, both fixed after the fact.

**The gated call is readable in full.** The card's `summary` is a clipped
one-liner (`describePermissionRequest`, ~100 chars), and for a `sed -i` the
clip lands exactly on the target path — the part that explains why the backend
gated the call, leaving the user approving something they can't read. The
broker now also emits `details`: the raw `command` when there is one (both
backends supply it), otherwise the pretty-printed tool input, bounded by
`PERMISSION_DETAILS_CHARS` (4 000) so a `Write`'s file body can't push
megabytes through the WS card and the persisted `permission_prompt` blob. It
rides the existing card payload end to end (event → `emitChatCard` →
`PersistedPermissionRequest` → permission store) and renders behind a collapsed
disclosure on the **pending** card only — once resolved, the tool's own
transcript row carries the full command and its output.

`details` is omitted whenever there is nothing left to disclose, which is *most*
requests — a toggle expanding to what the card already shows is noise, and
persisted noise at that. Two cases, both the common shape rather than an edge:
the collapsed summary already contains the whole body unclipped (`Bash: ls` over
`ls`), or the input's only content is the path the card renders on its own line
(`apply_patch` with a bare `file_path`). An exact `details !== summary` check
caught neither, since the summary is prefixed with the tool name.

Still NOT asserted: a *reason*. The CLI
supplies only `{tool_name, input, tool_use_id}`, so the generic copy stands
(Thread D).

**A card must not orphan the gated tool's result.** The card is appended as its
own `role: "assistant"` message, so it sits between the message holding the
gated `tool_use` and that tool's later `tool_result`. The client's
`agent_tool_result` branch used to attach results to `prev[prev.length - 1]`
blindly, while `buildVisualElements` pairs a tool with its result strictly
WITHIN one message — so the result landed on the card, the tool row resolved
`result === undefined`, and once streaming ended `isInspectable` was false: no
`onClick`, no "Show output", the command and output reachable only by reloading
the page (the server's `attachToolResultsToGroup` was always correct, which is
why a reload repaired it). Results now route to the message whose `toolUse`
holds the matching id, falling back to the last assistant message — skipping
terminal card carriers, the same `isTerminalTranscriptEntry` predicate the
streaming-text merge branch uses. The two branches disagreeing was the bug; any
mid-turn card in that position reproduced it, not just this one.

## Key files

**Worker / agent-agnostic core**
- `src/server/session/permission-broker.ts` — the broker. `openRequest()`/`poll()` (long poll + `toolUseId` idempotency), `request()` (Codex direct-await, withdrawn by its `signal`), `resolve()`, and the abandoned-request deny: `endToolUse()`/`clearPending()`; `callEnded.waitedMs` is the measured wait (req 8). Also `SubagentCallTracker`, which says whose call a `toolUseId` is.
- `src/server/session/agent-controller.ts` — `wireAgentEvents` ends the request for every `tool_result` id, and clears pending requests when the agent exits. `/agent/status` reports the broker's `unansweredIds` as `pendingPermissionIds`. It feeds `SubagentCallTracker`, and `subagentCaller()` answers the permission endpoint. `approvesEveryCall` is true for Claude in Auto mode, and `notePermissionMode` allows the requests that still wait when Auto applies (req 9).
- `docker/agent-hooks/managed-settings.json` — the Claude CLI's permission rules, with the `Edit(//persist/**)` allow rule.
- `src/server/session/mcp-permission-bridge.ts` — Claude's `--permission-prompt-tool`. `createPermissionBridgeServer()` factory; open + bounded `/await` poll loop with retry/backoff (Thread B).
- `src/server/session/session-worker.ts` — broker construction, `/agent-ops/permission/request` (now non-blocking) + `/agent-ops/permission/await` (Thread B) + `/agent/permission/resolve`, `permissionBridgePaths`, Codex requester injection, reject-all on teardown.
- `src/server/session/agents/claude/{adapter,process}.ts` — register `shipit-permission`; pass `--permission-prompt-tool`.
- `src/server/session/agents/codex/adapter.ts` — `setPermissionRequester` + `resolveApproval` routing (replaces unconditional auto-accept); `buildCodexPermissionInput`. `codex-event-handler.ts` withdraws a request on `serverRequest/resolved`.
- `src/server/shared/types/agent-types.ts` — `AgentPermissionRequestEvent`, `AgentPermissionResolvedEvent`, `PermissionDecision`, `PermissionRequester`, `AgentMcpPermissionBridge`, `AgentProcess.{resolvePermission,setPermissionRequester}`.

**Orchestrator**
- `src/server/orchestrator/proxy-agent-process.ts` + `container-session-runner.ts` — `resolvePermission` → `/agent/permission/resolve`.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `agent_permission_request` → emitChatCard + `session_attention` (Thread C); `agent_permission_resolved` → `settlePermissionCard`; an agent `error` denies the cards its process left.
- `src/server/orchestrator/permission-cards.ts` — `settlePermissionCard` (patch the recorded card mid-turn via `persistCardTransition`, else the DB row; `permission_resolved`; clear attention with the last id) and `denyAbandonedPermissionCards`, called from `turn-executor.ts` (exit), `runner-registry-factory.ts` (`turn_abandoned`) and `startup-tasks.ts` (`handleContainerExited`); `reconcilePermissionCards`, called from `container-session-runner.ts` `reconcileSavedPermissionCards`.
- `src/server/orchestrator/permission-wait-notice.ts` + `prompts/permission-wait-notice.md` — the `[ShipIt]` line for a background subagent's request that waits; armed by `agent-listeners.ts` on `agent_permission_request`. Also `buildUnansweredPermissionNotice`, the next turn's line for a call that ended before anyone answered (req 7).
- `src/server/orchestrator/ws-handlers/agent-voice-handler.ts` — `derivePermissionHeadline`, the headline of the `"permission"` voice note that `agent-listeners.ts` sends when the session starts to wait (req 6).
- `src/server/orchestrator/chat-card-persistence.ts` — `updateRecordedCard` (patch a recorded card in place for a transition that lands within its own turn, without re-emitting it); `emitChatCard` advances `lastPersistedBufferIndex` past the buffer after persisting (the switch/reconnect overlap fix that kept a pending card from vanishing).
- `src/client/hooks/message-handlers/agent-event.ts` — the streaming-assistant merge excludes card-carrying messages (`CARD_MESSAGE_FIELDS`) as merge targets, so a replayed event can't rebuild a card message and drop its card field; `agent_tool_result` routes each result to the message whose `toolUse` holds the id (`indexOfToolUse` / `fallbackResultTarget`), so a card between a call and its result can't orphan the tool row.
- `src/server/orchestrator/{session-runner,container-session-runner}.ts` — `awaitingPermissionIds` per-runner set (Thread C).
- `src/server/orchestrator/index.ts` — `session_attention` connect snapshot.
- `src/server/orchestrator/ws-handlers/send-message.ts` — `handleAnswerQuestion` forwards the session's permission mode so a clarifying answer stays in plan mode (Thread A).
- `src/server/orchestrator/ws-handlers/permission-handlers.ts` — `handleResolvePermission` (new); dispatch in `index.ts`.
- `src/server/orchestrator/chat-history.ts` + `src/server/shared/database.ts` — `permissionPrompt` field/column + migration + `updatePermissionCard` + `pendingPermissionRequestIds`.
- WS types: `ws-client-messages.ts` (`WsResolvePermission`), `ws-server-messages.ts` (`WsPermissionRequestCard`, `WsPermissionResolved`).

**Client**
- `src/client/stores/permission-store.ts`, `src/client/components/PermissionRequestCard.tsx` — card store + render (generic copy, Thread D; `details` disclosure on the pending card; the reason line of a card that nobody answered, req 8).
- `src/client/hooks/message-handlers/{permission-request-card,permission-resolved}.ts` + registration.
- `src/client/components/MessageList.tsx` (render + `onResolvePermission`), `visual-elements.ts` (`CARD_MESSAGE_FIELDS`), `utils/session-data.ts` (rehydrate), `App.tsx` (send `resolve_permission`; forward permission mode on `answer_question`, Thread A).
- `src/client/hooks/useServerEvents.ts` (`session_attention` listener), `stores/session-store.ts` (`awaitingPermissionSessions`), `hooks/{useAttentionInfo,useAttentionNotifications}.ts` (Thread C).

## Degraded modes

- **Local mode** (dogfood) has no worker/broker, so the Claude bridge POST fails
  → deny. Sensitive-file edits there remain a dead-end (dev-only, already
  degraded per docs/118). Production (container) is the path that matters.
- The Codex deny enum is confirmed against `codex app-server generate-json-schema`
  (planning#114): v2 deny is `"decline"` (deny + continue the turn; `"cancel"` would
  also interrupt — not our semantics) and v1 deny is `"denied"`. An earlier
  inferred value `"reject"` was stale — the schema defines no such variant — and
  is fixed in `codex-event-handler.ts`. Allow (`accept`/`approved`) is confirmed
  by existing tests.

## Tests

- `permission-broker.test.ts` — request/resolve/remember/no-timeout/unknown-id; plus `openRequest`/`poll` long-poll, `toolUseId` idempotency, post-resolution poll consumption (Thread B); the abandoned-request deny from `endToolUse`, `clearPending` and an aborted `signal`, and that none re-announces an answered request.
- `agent-controller.test.ts` — a gated call's `tool_result` (the Claude idle-timeout shape) and an agent exit each broadcast the deny; `/agent/status` reports the unanswered ids.
- `codex/adapter.test.ts` — `serverRequest/resolved` aborts the pending request and sends no response.
- `database.test.ts` — the migration denies legacy pending cards and leaves answered cards and unreadable JSON alone.
- `permission-cards.test.ts` — mid-turn vs. finished-turn persistence, attention cleared only with the last id, the abandoned-card deny, and the reconcile against the worker's live ids.
- `restart-turn-adoption.test.ts` (integration) — after a restart, a saved card the adopted worker still waits on stays pending and needs attention, an older one is denied, and a card no adopted turn can relay, or one from a replaced container, is denied.
- `agent-listeners.test.ts` — an agent error denies its cards; a replaced process's late error does not; the worker's deny settles the card.
- `turn-crash-commit.test.ts` — an exit with a pending card denies it and still commits; `runner-registry-factory.test.ts` — `turn_abandoned`; `container-exit-logging.test.ts` — a container exit denies the card and saves the turn with it denied.
- `mcp-permission-bridge.test.ts` — open→poll→allow envelope, inline pre-approval, `pending` loop, transient-failure retry, sustained-failure fail-closed, 4xx no-retry (Thread B).
- `session-worker.test.ts` (integration) — open returns requestId + await-then-resolve round-trip, and duplicate-open idempotency (Thread B); Claude in Auto mode gets `allow` with no card, asks again after the CLI reports `plan`, and a card still waiting when the CLI reports `default` is allowed (req 9).
- `ask-user-question.test.ts` (integration) — answering a question in plan mode re-pins plan mode on resume (Thread A).
- `useAttentionInfo.test.ts` — `awaitingPermission` is the highest-priority reason and outranks `isAgentRunning` (Thread C).
- `chat-history.test.ts` — round-trip + `updatePermissionCard` + the `EVERY_OPTIONAL_FIELD_MESSAGE` / `CARD_MESSAGE_FIELDS` guards.
- `process.test.ts` — `--permission-prompt-tool` presence/absence.
- `claude/mcp-writer.test.ts` — `shipit-permission` registration.
- `codex/adapter.test.ts` — requester routing (allow→accept, deny→reject), `buildCodexPermissionInput`, auto-accept fallback preserved.
- `visual-elements.test.ts` — empty-text carrier render guard.
- `agent-event.test.ts` — a tool result routes to the message that issued the call: the gated tool pairs with its result **live, with no reload**, when a permission card lands in between; per-caller routing across several open messages; the no-match fallback, which skips a terminal card row.
- `PermissionRequestCard.test.tsx` — the `details` disclosure is collapsed by default, expands to the full command, and is absent when the broker had nothing beyond the summary.
- `permission-broker.test.ts` — `describePermissionDetails` (raw command whole, JSON fallback, `PERMISSION_DETAILS_CHARS` bound) and the broadcast carrying `details` alongside the clipped `summary`.
- `permission-broker.test.ts` — `SubagentCallTracker` (main, foreground, background, a closed call, `whenOpened`), and the request event carrying `subagent`. `agent-controller.test.ts` — the same three callers from the event order the Claude CLI emits, a request that arrives before its stream event, and a replaced process's late events. `session-worker.test.ts` (integration) — the endpoint marks a background subagent's request, also one that arrives before its stream event, and leaves the main agent's unmarked.
- `permission-wait-notice.test.ts` — the line goes into the running turn after the delay and one time; it lists every request that waits; an answered request is not told; a later request gets a line of its own; no turn is started for an idle session and the next turn gets the line; a turn that cannot take a steer gets nothing queued; a dispatch that throws is tried again; the turn's permission mode stays. `agent-listeners.test.ts` — only a `background` request arms the line, and an answer ends it.
- `agent-listeners.test.ts` — one `"permission"` voice note when the session starts to wait and none for a card that joins it; a deny with `callEnded` parks the notice, a plain deny and a user's Stop do not. `agent-voice-handler.test.ts` — `derivePermissionHeadline` for Claude's and Codex's tool names. `permission-broker.test.ts` and `agent-controller.test.ts` — the deny from a call's result and from a Codex withdrawal carries `callEnded`, an exit's does not. `voice-note-router.test.ts` — a `"permission"` note keeps its kind on the card and posts the webhook.
- Req 8: `permission-broker.test.ts` — `callEnded.waitedMs` is the time from open to the call's end. `agent-listeners.test.ts` — `callEnded` puts `unanswered` (with or without `waitedMs`) on the card; a plain deny and a user's Stop do not. `permission-cards.test.ts` — the reason reaches the row, the recorded card and `permission_resolved`. `chat-history.test.ts` — it survives a reload. `PermissionRequestCard.test.tsx` — "Denied" with "Nobody answered in 30 min", the line with no duration, and no line after a Deny or a Stop.
- `managed-settings.test.ts` — the `Edit(//persist/**)` allow rule, and no allow rule the CLI ignores. The test reads the file; what the CLI does with the rules is the measurement above, which no test repeats.
