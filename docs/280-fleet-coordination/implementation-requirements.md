---
title: Fleet coordination — implementation-level requirements
description: Technical-tier requirements with their provenance — what each must achieve and where it comes from. Solutions live in coordinator-design.md.
---

# Implementation-level requirements

Split from `requirements.md` on 2026-08-23 at the user's direction. The product statement stays at the top level: **the user always talks to the coordinator agent; whatever is delivered is delivered from the agent, and whatever the user sends is sent to the agent.** This document holds the technical requirements underneath that experience — each stated as what must be achieved, with **where it comes from**. Potential solutions, and which one is currently chosen, live in the separate design doc, `coordinator-design.md`; this document names none.

Standing rule: **the MVP builds the minimal thing that satisfies the top-level product requirements.** Anything here beyond the minimum is adopted only when observed evidence demands it.

## I1. Simultaneous completions must not confuse the coordinator

**Requirement.** When many sessions finish at the same time, the user still experiences orderly, one-at-a-time, comprehensible delivery. No arrival is lost, duplicated, or garbled by volume.

**Where it comes from.** Product reqs 1–2 and 5–6 (items delivered and discussed item by item, decidable by ear) meeting an observed model limitation: an agent — especially on a weaker model — may be confused when handed multiple conversations at once ("if multiple sessions all end at the same time, the agent may be confused, especially if the model powering it is not very powerful"). Whether this pressure requires machinery at all is open — "maybe we don't even need it" — which is why it is a requirement on the outcome, not on a mechanism.

**Solutions.** `coordinator-design.md`, wake-model section (MVP and optimization tiers).

## I2. A permanent conversation on a finite context window

**Requirement.** The coordinator's model context is finite and fills on heavy days; the conversation is permanent (product req 14). Whatever keeps the context healthy must satisfy the product-level acceptance contract: no degradation over months (req 20) and complete invisibility to the user on every surface (req 21).

**Where it comes from.** Product reqs 14, 20, 21 colliding with the physical context limit of every harness; sharpened by the user's observation that a heavy single day needs the same treatment as any calendar boundary — the clock has no role, context weight does.

**Solutions.** `coordinator-design.md`, context-lifecycle section (the current choice, the escalation ladder, and the analysis behind them).

## Open questions

None. Adoption triggers for anything beyond the MVP minimum are the measurements recorded with the solutions in `coordinator-design.md`.
