---
issue: planning#674
title: Ops session — read another session's transcript
description: An ops session can read the transcript of any session on the host. This reverses the boundary that docs/255-ops-session-inventory req 8 set.
---

# 326 — Ops session reads a session's transcript

The design that implements these requirements is in [`plan.md`](./plan.md).

Source: the operator said this in an ops session on 2026-10-10. The ops session
(`a807067a-e1f8-4236-8e7e-0288a64c6b40`) sent it in the incident packet that
started this work:

> the ops session should be able to read transcript of any session.

The packet says that this sentence is the whole requirement, and that the
packet's other recommendations come from the ops agent, not from the operator.

## Why the operator asked

The ops session investigated why a merge notification did not resume a session.
The host logs showed which session ShipIt woke. They did not show whether that
session's own `shipit session notify-on-merge --self` call was accepted and
later replaced, or refused with a 409. That answer is only in the session's
chat: a merge-watch card, or a failed tool result. The ops agent could not read
it, and sent the operator to the UI.

## Requirements

1. An ops session can read the transcript of any session on the host.
2. The read returns all that the chat shows: the user's messages, the
   assistant's text, the cards, the tool calls with their inputs, and the tool
   results. A large body is cut, and the output says that it was cut.
3. Before the ops session gets the text, ShipIt replaces credentials with
   `[REDACTED]`: API keys, tokens, JWTs, bearer values, and passwords in URLs.
   URLs, file paths, e-mail addresses and commit hashes stay readable.

## What this reverses

This is a deliberate reversal, by the operator, of a boundary that two earlier
features recorded:

- `docs/255-ops-session-inventory` req 8 — an ops session "must **not** be able
  to read what was said inside another session".
- `docs/264-ops-session-logs` req 4, and its non-requirement "Any widening of
  the 'no reading another session's conversation' boundary".

Those documents stay as the record of what was decided then. The inventory read
and the log read do not change: each still returns what it returned before.

## Non-requirements

- A change to any session kind other than ops. The operator named the ops
  session only.
- A change to the fleet coordination surface (`docs/280-fleet-coordination`),
  which uses similar words for a different surface.
- A way for an ops session to write to, send a message to, or start a turn in
  another session. The operator asked for a read.

## Open questions

_(none)_

## Resolved questions

- 2026-10-10 — How much of each tool call does the read return? The UI shows
  tool calls and their results, and the incident needed one failed tool result.
  But a tool result is also how a session's workspace files and command output
  get into its transcript, and `docs/255-ops-session-inventory` req 8 also
  withheld "workspace contents". The options were: all that the chat shows;
  names and status only; conversation and cards only. The operator chose **all
  that the chat shows**, with large bodies cut and marked. Recorded as
  requirement 2. This means that workspace content which is in a transcript
  can reach the ops session.
- 2026-10-10 — Is the text redacted before the ops session gets it? The other
  ops reads also replace every URL, e-mail address and workspace path, which
  removes the file paths and pull request links that an investigation needs.
  The options were: credentials only; the full redaction of the other ops
  reads; no redaction. The operator chose **credentials only**. Recorded as
  requirement 3.
