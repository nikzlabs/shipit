---
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

- **How much of each tool call does the read return?** The UI shows tool calls
  and their results in the transcript, and the incident needed one failed tool
  result. But a tool result is also how a session's workspace files and command
  output get into its transcript, and `docs/255-ops-session-inventory` req 8
  also withheld "workspace contents". Options: (a) everything the chat shows,
  with large bodies cut and marked; (b) the conversation, the cards, and for
  each tool call only its name and whether it failed; (c) the conversation and
  the cards only.
- **Is the text redacted before the ops session gets it?** The other ops reads
  put `[REDACTED]` in place of token-shaped strings, and also in place of every
  URL, e-mail address and workspace path. In a transcript that removes file
  paths and pull request links, which an investigation usually needs. Options:
  (a) redact known credential shapes only; (b) the same full redaction as the
  other ops reads; (c) no redaction — the same text the UI shows.

## Resolved questions

_(none yet)_
