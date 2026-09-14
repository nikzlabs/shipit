---
issue: planning#550
title: Session status card — design
description: One agent tool, one session-record column, one pinned element above the composer, and a ShipIt-started follow-up turn when a turn ends without an update.
---

# Session status card — design

Requirements: [requirements.md](requirements.md). Remaining work:
[checklist.md](checklist.md).

## Shape

Four pieces, each one already has a precedent in the codebase:

| Piece | Precedent |
|---|---|
| Agent tool `session_status` | `propose_actions` (`src/server/session/mcp-tools/propose-actions.ts`) |
| Session-record column `session_status`, broadcast with `session_list` | `agent_goal` (docs/154, `services/agent-goal.ts`) |
| Pinned element above the composer | `GoalChip` in `App.tsx` |
| ShipIt-started follow-up turn on idle | `wakeSessionWithTurn` (`wake-session.ts`) and the `idle` listeners in `runner-registry-factory.ts` |

Nothing goes into the transcript, so none of the persisted-card machinery
(`emitChatCard`, `CARD_MESSAGE_FIELDS`, history rehydration) is involved.

## The tool (req 4, 5)

`session_status` — id and name both `session_status`, in
`src/server/session/mcp-tools/session-status.ts`, added to the
`SHIPIT_MCP_TOOLS` list of all five harness adapters (Claude, Codex, OpenCode,
Grok, Antigravity), so it is the same tool everywhere.

Arguments, all plain text, validated in
`src/server/shared/session-status-validation.ts` (the
`propose-actions-validation.ts` pattern, shared by the tool and the route):

| Field | Limit | Meaning |
|---|---|---|
| `standing` | required, ≤ 240 chars | What the session is about and where it stands. The whole session, not the last turn. |
| `next` | required, ≤ 240 chars | The intended next step. "Nothing" is a valid value. |
| `needsYou` | optional, ≤ 240 chars | What the user must do by hand. Empty when nothing. |
| `done` | optional boolean | The session's task is finished (req 1: "whether the work is done"). |

The limits are the concision (req 2): the agent cannot write a paragraph.

Call path: tool → worker `POST /agent-ops/session-status` (a `relay` line in
`agent-ops-routes.ts`) → orchestrator
`POST /api/sessions/:sessionId/session-status` (`containerAccessible: true`,
in a new `api-routes-session-status.ts`). The route validates, persists,
broadcasts, marks the current turn as updated (below), and answers with one
line telling the agent the status is on screen and it can end its turn.

## Storage and transport (req 10)

- `sessions.session_status` column, JSON:
  `{ standing, next, needsYou?, done?, updatedAt }`. Migration via
  `addSessionColumnIfMissing` (`database.ts`), like `agent_goal`.
- `SessionInfo.sessionStatus?: SessionStatus` (`domain-types/session.ts`),
  read in `sessions.ts` `toRow`/`fromRow`, written by
  `SessionManager.setSessionStatus`.
- `services/session-status.ts` `recordSessionStatus(deps, sessionId, status)`:
  write, then `sseBroadcast("session_list", …)`, exactly `recordAgentGoal`.

Because the value rides `SessionInfo`, every viewer, a reload, a session
switch and an orchestrator restart show the same card with no extra request.
`clearAgentSessionId` (conversation reset) clears `agent_goal` and leaves this
column alone: the status is about the session, and a new thread does not
change what the session is about. A fork (`forkSession`) is a new row and
starts with no status; its first turn is nudged into writing one.

## Turn-end accounting (req 11–13)

Three flags on `TurnAccumulator` (`turn-accumulator.ts`), reset where the
accumulator is reset at turn start (`session-runner.ts:452`):

- `statusUpdated` — set by the session-status route.
- `questionAsked` — set where the turn is interrupted for a question
  (`agent-listeners.ts:616`, `isWellFormedAskUserQuestion`). That path is
  harness-neutral already: Claude's native `AskUserQuestion` and the MCP
  `ask` tool both arrive there, because the worker turns the MCP call into an
  `AskUserQuestion` tool_use event (`session-worker.ts`, `registerAskEndpoint`).
  `ExitPlanMode` (plan approval) sets it too: the turn ends waiting for the user.
- `actionsProposed` — set by the propose-actions route.

The flags are read on the orchestrator's own evidence — its routes were hit,
its interrupt fired — never by matching tool names in the event stream, which
differ per harness.

A pure function `decideStatusNudge(turn)` in `services/session-status.ts`
returns `"nudge" | "no"`; it says **no** when any flag is set (req 13), when
the turn was interrupted or did not end with `agent_result` (a user interrupt
means the user is present; a crash has its own recovery), when the turn was
`silent` (compaction), or when the turn was itself the nudge.

## The nudge (req 12)

Registered in `runner-registry-factory.ts` `onRunnerCreated`, next to the goal
refresh:

```ts
runner.on("idle", () => void nudgeSessionStatusIfMissing(deps, runner));
```

`idle` is the right hook, verified at `turn-executor.ts` (`signalIdleIfIdle`
is the last post-turn step, after drain and commit) and stated by CLAUDE.md
invariant 1: it fires only when no queued turn took over, so "the queue is
empty" comes for free — a queued user message is a turn of its own, and the
card is checked again when that turn ends.

The nudge is `wakeSessionWithTurn(deps, session, { text: NUDGE_PROMPT,
activity: "Updating the session status" })`. It is a regular dispatched turn:
the prompt is echoed as the turn's user row (`system_user_message`), the
agent's reply follows, the post-turn flow runs as for any turn. That is the
transparency req 12 asks for. The prompt opens with `[ShipIt]`, the prefix
ShipIt already uses for lines it writes into the conversation (bug-report
resolutions), and says: the last turn ended without a session status update;
call `session_status` now with the three fields; do nothing else.

**One nudge per turn.** The dispatch sets `runner.statusNudgePending`; the
turn-start reset consumes it into the accumulator's `isStatusNudge` flag.
`decideStatusNudge` says no for a turn that was the nudge, so an agent that
ignores the nudge is not asked twice. The card then shows "not updated in the
last turn" in small tertiary text: the one honest marker, shown only after the
nudge failed, never as a substitute for the nudge.

Turns that are never nudged: interrupted turns, crashed turns, `silent`
turns, and turns in a session whose agent has no `session_status` tool (none
today; the gate is the tool list, so a future harness without it degrades to
"no card" rather than to an endless nudge).

Rejected on the way:

- **Claude Stop hook** (`docker/agent-hooks/stop-pr-check.sh`, docs/129) —
  Claude only; the user chose one universal mechanism at the ShipIt level.
- **`pendingAgentNotice` on the next user turn** — cheaper, but the card stays
  stale until the user acts, which req 11 rules out.
- **Deriving the card from `runner.turnSummary` or a small-model call** — the
  last message is already on screen (requirements, resolved 2026-09-14), and a
  summarizer is not the agent's own knowledge of the session.

## Client (req 6–9)

`SessionStatusCard` (`src/client/components/SessionStatusCard.tsx`), rendered
in `App.tsx` in the column that already holds `GoalChip`, between the message
list and the composer. Reads `currentSession.sessionStatus`; renders nothing
until the session has one.

Layout, `text-xs`, semantic tokens only, no new theme values:

```
◎ Where it stands   Billing service: routes and tests done; PR #212 open.   [Done ✓]
  Next              Merge after review; then wire the webhook.
  Needs you         Add the Stripe test key in Settings → Secrets.
```

- `Needs you` is omitted when empty. `done` shows a `CheckCircleIcon` and the
  word "Done" at the row's end.
- No button, no collapse: the limits keep it short (req 2), and the composer
  is the control.
- It does not appear on the sidebar row (req 7) and is not an input to
  `computeAttentionReason` (req 9). The field is on `SessionInfo`, so the
  sidebar *could* read it; it must not.
- Question and follow-up-actions cards are transcript rows at the end of the
  message list, so they sit above this element and remain the last thing in
  the conversation (req 8).
- The small "not updated in the last turn" marker appears only when the
  status' turn is older than the last finished non-nudge turn; see above.

## Prompt (req 5)

A "Session status" section in `src/server/orchestrator/prompts/skeleton.md`,
after "Proposing optional follow-up actions". It says what the three fields
are, that the status describes the session and not the turn, that it is the
last act of a turn, and that a turn ending in a question or `propose_actions`
needs no update. Static text, rendered once at module load — the
prompt-cache contract in the `prompt-architecture` skill holds. Tests assert
the section is composed in, not its wording.

## Tests

- `session-status-validation.test.ts` — limits, required fields, trimming.
- `api-routes-session-status.test.ts` — validate → persist → `session_list`
  broadcast → accumulator flag set; 409 when the runner is not active.
- `services/session-status.test.ts` — `decideStatusNudge` table: updated /
  question / actions / interrupted / silent / nudge-itself → no; plain turn →
  nudge.
- Integration (`integration_tests/session-status-nudge.test.ts`, FakeClaude):
  a turn without the tool → exactly one dispatched follow-up turn whose user
  row starts with `[ShipIt]`; the follow-up calls the tool → card persisted;
  a follow-up that also skips it → no third turn, marker shown. A turn that
  asks a question → no follow-up.
- `SessionStatusCard.test.tsx` — three rows, hidden `Needs you` when empty,
  `Done` glyph, stale marker.
- `agent-instructions.test.ts` — the section is present in every variant.

## Key files

- `src/server/session/mcp-tools/session-status.ts` — the tool.
- `src/server/session/agent-ops-routes.ts` — worker relay.
- `src/server/orchestrator/api-routes-session-status.ts` — persist, broadcast, flag.
- `src/server/orchestrator/services/session-status.ts` — `recordSessionStatus`, `decideStatusNudge`, `nudgeSessionStatusIfMissing`.
- `src/server/orchestrator/turn-accumulator.ts`, `session-runner.ts` — per-turn flags and their reset.
- `src/server/orchestrator/ws-handlers/agent-listeners.ts` — `questionAsked` at the interrupt.
- `src/server/orchestrator/runner-registry-factory.ts` — the `idle` listener.
- `src/server/orchestrator/sessions.ts`, `src/server/shared/database.ts`, `src/server/shared/types/domain-types/session.ts` — column and type.
- `src/server/shared/session-status-validation.ts` — limits.
- `src/server/orchestrator/prompts/skeleton.md` — the instruction.
- `src/client/components/SessionStatusCard.tsx`, `src/client/App.tsx` — the element.
