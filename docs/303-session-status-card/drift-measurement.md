---
title: Status card drift, measured on production
description: How often the agent updates the session status card, measured over 650 turns; which turn shapes never update it, and which calls say nothing about manual steps or offers.
---

# Status card drift, measured on production

The session status card (docs/303-session-status-card) asks the agent to end each
turn with a `session_status` call. Reports from use said the agent forgets — the
whole card, or the manual steps and offers inside it. This report measures how
often that happens, and which turns it happens on.

## Method

The counts come from the production ShipIt database, read on 2026-09-20. The
database file was copied read only into a throw-away container, queried there,
and the query scripts were deleted. No production data was changed.

Scope: every session that holds a status card, and every turn in those sessions
from 2026-09-16, the day the feature reached production. That is 83 cards and
650 turns.

Definitions used by every number below:

- A **turn** starts at a user message and ends at the next one.
- A turn **called** if any assistant message in it used the `session_status` tool.
- **Turn shapes**: a **nudge** turn is one that ShipIt started with the stale-card
  prompt; a **question/plan** turn used `AskUserQuestion` or `ExitPlanMode`, and
  is exempt from the call by design (req 13); a **work** turn used at least one
  other tool; a **text-only** turn used no tool at all.

Nothing in this report identifies a session, a repository or a message. Only
counts were taken out of the database.

## What was measured

### 1. One work turn in four ends with no update

| Turn shape | Turns | Called | Rate |
|---|---|---|---|
| Work | 495 | 373 | 75% |
| Text-only | 46 | 0 | 0% (see the correction below) |
| Question / plan (exempt) | 28 | 2 | 7% |
| Nudge | 81 | 81 | **100%** |

Across 27 sessions with five or more work turns, the median call rate is 79%.
The range is 0% to 100%, so the failure is not concentrated in one session.

### 2. The text-only class — CORRECTED 2026-09-20

**This finding as first written was wrong in two ways. Both were found by the
session that implemented the fix (PR #2930), and the text is kept here with the
correction beside it, because the report was cited as evidence.**

It first said: a text-only turn never updates the card, not once in 46 turns,
and gets no nudge either; why the nudge misses them is not established.

**Correction 1. The 0% is true by definition, not by discovery.** This report
defines a text-only turn as one that used no tool, and `session_status` is a
tool. A turn with no tool call cannot contain a tool call. The rate could not
have come out at anything but 0%, so it measures nothing. What is real in the
row is only the count: 46 turns ended with no update.

**Correction 2. A plain text-only turn IS nudged.** The implementing session
cloned `main`, reproduced the case, and found that no gate reads the turn's tool
use. So these 46 turns are not one class with one cause. Three separate shapes
produce them, each reproduced: a **steer** (which, under this report's own
definition of a turn, splits a turn and leaves its first half with no tool); a
**user stop**; and a resident agent holding **background work**, where the
dispatch was refused with no log line at all. A user-typed `/compact` is a
fourth shape and is exempt by design.

My guess on record — `wasInterrupted` or `successorPending` — was half right,
and would have been trusted if the fix had not been told to reproduce it first.

### 3. Making the card visible did not improve compliance

Production has run the build that puts the card in the turn prompt (req 35)
since 2026-09-18, 19:04. Work turns before that deploy: 341 of 448 called (76%).
After it: 32 of 47 called (68%). The sample after the deploy is small, and it
shows no improvement.

### 4. The nudge always works, and it fires on half the misses

All 81 nudged turns made the call. But there were 168 misses (work and text-only
turns with no call), and only 81 nudges — 48%. This count is unaffected by the
correction to finding 2: a steer splits one turn into two under the definition
used here, so a few of the 168 are halves of the same turn.

The gates exist because the nudge costs a full agent turn. The gates remove the
nudge; they do not remove the miss. A card missed on a steered turn is never
asked for again.

### 5. Two calls in five say nothing about manual steps or offers

Of 594 calls, 241 (41%) carried neither `needsYou` nor `actions`. The commonest
shape is `lastTurn` + `status`, 133 calls. Because every field except `lastTurn`
is a delta, and because any call clears the stale mark, such a call leaves the
manual steps and the offers untouched while the card reports itself current.

Caveat on this figure: 26 of the 241 were recorded in a form that does not name
its fields, so the true share is between 36% and 41%.

A forgotten manual step is therefore **not detectable**. The stale mark records
that the tool was called, not that the card is true.

### 6. The drift this leaves on the cards

Of the 83 cards now held: 15 carry open manual steps and 12 carry offers. Two
offers are marked taken and are still listed. The oldest offer has been on a
card for 4 days.

## What the measurements support

The agent obeys an instruction that arrives in the turn prompt, and does not
obey the same rule in the system prompt. Finding 4 is the evidence: the same
agent that missed the turn complies every time the nudge text arrives. Finding 3
shows that showing the card is not enough on its own — the card was visible and
the rate did not move. The instruction, not the data, is what is missing.

Three changes follow from this, and none of them refuses a call:

**A. Make the nudge free, then let it fire on every miss.** Deliver the nudge
text in the next turn's prompt, beside the card block, instead of spending a
turn on it. Then remove the gates that exist only because of that cost. Keep the
exemptions that stand on their own: a question or plan turn, a crash, a
compaction. This turns 48% coverage into full coverage, and removes 81 turns
from a five-day period.

**B. Close the card block with the instruction.** The block opens with
"Reconcile it before the turn ends." Put the instruction at the end instead, in
the words the nudge uses.

**C. Show the age of each manual step and each offer in the block.** For
example, "offered 9 turns ago, not reviewed since". The agent then sees its own
drift. This is the only proposal that addresses finding 5, and it adds no rule
that can reject a call.

A stronger step is available if drift continues: stop the freshness mark from
claiming more than the call said. A call that omits `needsYou` while manual
steps are open would keep the card current, but would mark the manual steps as
unreviewed. That is not a refusal. It was not built, because the user ruled on
2026-09-16 that ShipIt should show the card and do nothing more.

## What was built from this, and how to score it

Reqs 38, 39 and 40 (PR #2930, merged 2026-09-20) implement A, B and C. The ask
now rides the next turn's prompt and costs no turn, so the gates that rationed
it are gone; the instruction closes the block; each manual step and each offer
carries its age in turns.

## Repeating this measurement

The same counts can be taken again after any change, from the same database and
the same definitions. **Do not repeat the text-only call rate** — correction 2
above explains why that number can only ever read 0%. The three numbers that
matter are the **work-turn call rate** (75% here), the **share of misses that
receive an ask** (48% here, and A should take it to full coverage), and the
**share of calls that carry neither `needsYou` nor `actions`** (36–41% here,
which is what C is meant to move).

Note that the second number changes shape after PR #2930: the ask no longer
arrives as a turn of its own, so it cannot be counted by looking for an injected
message. Count it from the card's `nudgePending` and `turnSeq` instead.
