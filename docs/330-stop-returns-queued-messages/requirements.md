---
issue: planning#692
title: A Stop returns the queued messages to the input box
description: When the user stops a turn, their waiting messages go back into the input box and the queue is emptied.
---

# A Stop returns the queued messages to the input box

What the feature must do, in the user's terms. Design lives in
[`plan.md`](plan.md).

The report that started it (planning#692, found by the reviews of
`docs/329-user-steers-every-turn`): a Stop discarded the queue behind a turn
that the user typed, and kept it behind a turn that ShipIt started. A message
of the user's that waited in a discarded queue was lost.

## Requirements

1. When the user presses Stop, the content of the queue goes into the input
   box, before the text that is already there.
2. The Stop clears the queue.
3. An entry that ShipIt put in the queue is removed by the Stop, and its text
   does not go into the input box. Its sender delivers it again by its own
   rule.

## Open questions

None.

## Resolved questions

- 2026-10-12 — *What does a Stop do with the queue behind a turn?* The agent
  offered three directions: discard it behind every turn, keep it behind every
  turn, or keep it and start nothing until the user's next message. The user:
  "Could we on "stop" prepend the queue content to the input box text and clear
  the queue?" The agent read the code and answered that it is possible. These
  are requirements 1 and 2.
- 2026-10-12 — *What must happen to the entries that ShipIt put in the queue (a
  merge notice, a CI fix, a report from a child session, a consult result)?*
  The agent offered: remove them, keep them in the queue, or put their text in
  the input box too. The user: "Remove them (Recommended)". That option read:
  "They leave the queue and do not go to the input box. Each sender delivers
  again by its own rule […] Before I build, I check each sender and tell you if
  one would lose its entry." This is requirement 3. The check of each sender is
  in `plan.md`.

## How the requirements are read

The user gave the sentences quoted above. Nothing in this section is the
user's. It is written down so that a review can see what was not asked for.

- **"The queue content" of requirement 1** is, after requirement 3, each
  waiting message that the user sent in this session: a message typed in the
  input box, and an answer on a question card.
- **"Before the text that is already there"**: the returned messages keep the
  order in which the user sent them, and the text that the user was writing
  comes after them.
- **Neither sentence names a kind of turn**, so the rule is the same behind a
  turn that the user started and a turn that ShipIt started. This is also
  `docs/329-user-steers-every-turn` requirement 1.
- **Neither sentence names an exception.** Before this feature, a Stop during a
  compaction that ShipIt runs ahead of a message skipped the compaction, and
  the message ran. That message is queue content, so it goes back into the
  input box too. The agent told the user this on 2026-10-12 with the words
  "Tell me if you want to keep the special case"; the user did not ask to keep
  it.
- **A Stop is the user's Stop control.** The interrupt that ends a turn on a
  question card is not one, and `docs/322-question-holds-automatic-turns` still
  governs what waits behind a question.
- **A message is more than its text.** The agent told the user that the
  attachments of a returned message come back with it. A returned message
  without its files would be a message that is lost in part.
