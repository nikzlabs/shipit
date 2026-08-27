---
issue: planning#315
title: Telling a queued message from a delivered one
description: Whether the user can tell their message was queued, and — when it queued behind a turn ShipIt started rather than one they did — that the wait isn't their doing.
---

# 251 — Telling a queued message from a delivered one: requirements

Status: **closed, nothing built — deliberately.** The human's answer on 2026-08-04 was "do nothing" (see [Resolved questions](#resolved-questions)). Requirement 2 is knowingly unmet. There is no `plan.md` and there should not be one unless this is reopened. What this document is worth keeping for is the [verified current behavior](#current-behavior-verified) below — it is the record of what ShipIt already does here, which is more than the work was proposed on the assumption of.

This feature exists because of an incident on PR #1981 ("Gate submit acks on actual delivery"): an operator submitted an action card and it could not be determined afterwards whether the click was dropped in the browser or enqueued behind a turn the operator never started. #1981 fixed the browser half — a `send` on a non-OPEN socket silently no-oped and the card acked anyway. The other half — "it was enqueued, and I couldn't tell" — was deliberately left out of that PR, and is what this document scopes.

The work was proposed on the premise that a queued message is today *indistinguishable* from a delivered one. **That premise is false**, which is why this document leads with what already exists.

## Current behavior (verified)

Verified by reading the source on 2026-08-04, not inherited from the proposal.

**A queued message is already visible, to every viewer.**

1. When a message arrives while a turn is running and can't be steered into it, the runner enqueues it and broadcasts `message_queued` (`session-runner.ts:387`, via `emitMessage`, so all attached viewers see it — not just the sending socket).
2. The client moves the optimistic bubble out of the transcript and stashes it for re-insertion when the message is dequeued (`client/hooks/message-handlers/message-queued.ts`).
3. A card above the composer shows "N message(s) queued", each item's position badge and truncated text, a per-item cancel, and "Clear all" (`client/components/QueueIndicator.tsx`, rendered from `App.tsx:1899`).

**A system turn is already visible too, at least at first.**

4. Turns ShipIt starts on its own — a merge wake-turn (`merge-watch.ts` → `wake-session.ts`), a child-to-parent report delivery (`services/session-report.ts`), rebase conflict resolution (`services/rebase-driver.ts`), CI auto-fix (`app-lifecycle.ts`, `services/github-ci-fix.ts`) — are dispatched with `systemTurn: true` and carry an activity label: "Resuming after your PR merged…", "Resuming after child PR merged…", "Reassessing after child PR closed…", "Resolving conflicts...", "Fixing CI…".
5. That label reaches the client twice: on the `system_user_message` echo and on the `session_agent_started` SSE, and both set the status-bar label (`message-handlers/system-user-message.ts`, `hooks/useServerEvents.ts:107`).
6. The system turn's prompt is also appended to the transcript as a user-role bubble and persisted, so it survives a reload.
7. While a system turn is in flight, live steering is suppressed on purpose (`shouldSteerMessage`, `dispatch-steering.ts`; docs/146), so a user message that would otherwise be injected mid-turn is queued instead. **This suppression is by design and is not in scope to change.**

**What is *not* conveyed today.**

8. The queue card says only how many messages are waiting. It says nothing about what they are waiting behind, and reads identically whether the user queued behind a turn they started (expected — they typed while the agent was working) or behind one ShipIt started.
9. The system-turn activity label is transient: the running turn's first thinking/tool event overwrites it with the ordinary per-tool label ("Thinking...", "Editing foo.ts") (`message-handlers/agent-event.ts:96-102`). Within seconds of a system turn starting, the status bar is indistinguishable from a user turn's.
10. A viewer who attaches *after* a system turn started (session switch, page reload, a second tab) never receives its label at all — `session_agent_started` fired before they were listening, and nothing in the attach path restores it.
11. The client has no notion of a system turn: no flag for it crosses the wire in any message. The only cross-session provenance that renders is `messageOrigin` ("From child session · <title>"), which a merge wake or CI-fix does not carry — so their prompt bubble looks like something the user typed.

## Requirements

Both of these are stated at the level the user experiences. Requirement 1 is met today; it is recorded because it is the thing that must not regress.

1. When the user sends a message and it is queued rather than handed to the running agent, they can tell that it was queued, without waiting for it to run.

2. **Not met, by decision.** When a message is queued behind a turn the user did not start, they can tell the wait is not the consequence of something they did.

Requirement 2 was the whole of this feature. Items 4–6 already convey a good deal of it, and on 2026-08-04 the human decided the remainder was not worth closing. The gap it leaves is precisely items 8–10: the queue card names no cause, the system-turn label is overwritten within seconds, and a viewer who attached mid-turn never sees it. If this is reopened, that is the list to start from.

## Open questions

_None — the feature was closed before any were answered on their merits. The three that shaped how it would be built (name the reason vs. a generic marker; client-only vs. carrying the reason from the server; whether to also mark system-initiated prompt bubbles as not written by the user) are moot while requirement 2 stays unmet, and are recorded in the git history of this file rather than restated here._

## Resolved questions

- 2026-08-04 — Is this worth building at all, given `QueueIndicator` already exists and a system turn already announces itself when it starts? Chosen: **do nothing**. Requirement 2 is left unmet on purpose and marked as such; the remaining questions were not reached. The recommendation on the table was a client-only change (hold the system-turn label for the whole turn and show it on the queue card); it was declined along with the larger server-side option.
