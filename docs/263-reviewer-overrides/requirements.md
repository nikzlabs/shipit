---
issue: planning#362
title: Per-review reviewer choice — requirements
description: A user can ask, in chat, for a review on a specific model, effort, or harness; ShipIt resolves the rest.
---

# 263 — Per-review reviewer choice: requirements

**These are the things this feature changes. Everything ShipIt already does is a requirement
too, and is not restated here** — existing behaviour must keep working at least as well as it
does today.

This feature exists because a review request names who reviews in exactly two ways today
(docs/261 reqs 6 and 7), and the user wants the case in between. `--role reviewer` resolves
the two configured reviewers; the explicit call names every parameter and refuses an omission.
There is no way to say "this review, on a specific model and parameters" — the user's request
in chat either goes to the configured reviewer, or cannot be fulfilled because the agent
inside the container cannot discover a valid service id, model id, billing mode or effort
level, and the prompts forbid it from guessing.

## Requirements

1. The user can ask for a review, in chat, that names a specific **model**, **reasoning
   level**, and/or **harness** — rather than only the two configured reviewers.

   *"I want to be able to tell the agent to review with a specific model and parameters and
   so on."* There is no UI control for the reviewer; the request is made through chat.

2. A review request that names values runs on **exactly those values**. Values the user did
   not name are resolved by ShipIt from the install as it stands — never invented by the
   agent, and never completed from a stored setting the user cannot see.

3. Naming a **model** without naming who pays still runs that model. ShipIt chooses the
   service and billing mode from the offerings of that model this install can run, and the
   review **reports the choice**. The user can then change it by naming the service or
   billing mode in the next request.

4. The review **reports what actually ran** — model, service, billing mode, harness and
   reasoning level — as every review does (docs/261 req 9).

5. The two existing shapes keep working unchanged: `--role reviewer` alone resolves the
   configured reviewer as it does today, and a request that names the complete parameters
   runs on exactly what it names. Nothing between those two shapes is silently completed.

## Scope

The Settings surface is untouched — a named reviewer is a per-request choice, not a
configuration. Docs/261's distance ranking keeps its role for the bare role (req 5): the
override path is the human choosing, which lifts the ranking's guarantee just as a pin does.

## Open questions

- **What does naming a harness mean?** The user says "review with Codex". Two readings:
  (a) **swap** — run the would-be-chosen reviewer's model on the Codex harness, refusing
  when that harness cannot run it; (b) **axis** — choose the best distant model the Codex
  harness can run. A third option: (c) defer harness naming to a later version and support
  model + effort first.

- **Are service and billing mode nameable, or always derived?** The user names "GPT-5.6 on a
  subscription". Two readings: (a) **any subset** of the parameters is nameable and the
  unnamed ones are derived; (b) **derived only** — naming a model always derives the service
  and billing mode, and only model, effort and harness are nameable.
