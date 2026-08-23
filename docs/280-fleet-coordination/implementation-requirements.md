---
title: Fleet coordination — implementation-level requirements
description: Optimization-level requirements split out of the product requirements — the MVP may ship without them; each is evidence-gated.
---

# Implementation-level requirements

Split from `requirements.md` on 2026-08-23 at the user's direction: "these queues happen before the agent — it's the underlying implementation for me… on a different level… split it from the overall product to the optimization requirements." The product statement stays at the top level: **the user always talks to the coordinator agent; whatever is delivered is delivered from the agent, and whatever the user sends is sent to the agent.** Everything below is machinery underneath that experience.

Standing rule: **the MVP builds the minimal thing that satisfies the top-level product requirements.** Items here are V2 candidates, adopted only when observed evidence demands them.

## I1. Programmatic queue serialization

Items accumulate, order, and serialize in code before the coordinator; the coordinator is handed one item at a time, and the system — not the agent — decides what comes next when many sessions finish simultaneously.

- **Status: V2 candidate, evidence-gated.** In the user's words: "it's optimizing against models that cannot handle multiple conversations at a time — maybe we don't even need it."
- **Provenance:** originally product req 19 (2026-08-23, same day), mandated because "if multiple sessions all end at the same time, the agent may be confused, especially when the model powering it is not very powerful." Reclassified the same day as implementation-level.
- **MVP behavior instead:** the coordinator receives arrivals (the wake envelope may carry the batch) and manages presentation with its own judgment — req 12's flexibility. Adopt I1 when a session of observed use shows the coordinator juggling badly or misordering under simultaneous completions.
- The serialized-wake design (top item + counts, next-item tool call) is fully worked out in `coordinator-design.md` and waits.

## I2. Context-lifecycle mechanism

How the coordinator's model context is kept healthy over a permanent conversation.

- **v1: the harness's own built-in auto-compaction** — "it's kind of free; use the harness compaction and then see how it goes."
- **Escalation ladder, evidence-gated** (full analysis and measurements in `coordinator-design.md`): timing-controlled native compaction (agreed 60% arm / 80% act occupancy thresholds) → the verified fresh-context reset seeded from the memory repository plus a verbatim tail (the existing `conversation_replay` production path; companion work specified). A future reset seed may draw on active-session information — to be explored against the no-stale-fleet-state rule.
- **What stays at product level in `requirements.md`:** req 20 (usable over months, no degradation) and req 21 (context management is invisible on every surface). Those are the acceptance contract this mechanism must meet, whichever rung of the ladder is active.

## Open questions

None. Both items are settled as V2-candidates behind the MVP; their adoption triggers are the recorded measurements.
