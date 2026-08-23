---
title: Fleet coordination — implementation-level requirements
description: Technical-tier requirements with their provenance — what each must achieve and where it comes from. Solutions live in coordinator-design.md.
---

# Implementation-level requirements

Split from `requirements.md` on 2026-08-23 at the user's direction. The product statement stays at the top level — now numbered, scoped, in req 10: within the coordinator conversation, delivery comes from the agent and input goes to the agent. This document holds the technical requirements underneath that experience — each stated as what must be achieved, with **where it comes from**. Potential solutions, and which one is currently chosen, live in the separate design doc, `coordinator-design.md`; this document names none.

Standing rule: **the MVP builds the minimal thing that satisfies the top-level product requirements.** Anything here beyond the minimum is adopted only when observed evidence demands it.

## I1. Simultaneous completions must not confuse the coordinator

**Requirement.** When many sessions finish at the same time, the user still experiences orderly, one-at-a-time, comprehensible delivery. No arrival is lost, duplicated, or garbled by volume.

**Where it comes from.** Product reqs 1–2 and 5–6 (items delivered and discussed item by item, decidable by ear) meeting an observed model limitation: an agent — especially on a weaker model — may be confused when handed multiple conversations at once ("if multiple sessions all end at the same time, the agent may be confused, especially if the model powering it is not very powerful"). Whether this pressure requires machinery at all is open — "maybe we don't even need it" — which is why it is a requirement on the outcome, not on a mechanism.

**Solutions.** `coordinator-design.md`, wake-model section (MVP and optimization tiers).

## I2. A permanent conversation on a finite context window

**Requirement.** The coordinator's model context is finite and fills on heavy days; the conversation is permanent (product req 14). Whatever keeps the context healthy must satisfy the product-level acceptance contract: no degradation over months (req 20) and complete invisibility to the user on every surface (req 21).

**Where it comes from.** Product reqs 14, 20, 21 colliding with the physical context limit of every harness; sharpened by the user's observation that a heavy single day needs the same treatment as any calendar boundary — the clock has no role, context weight does.

**Solutions.** `coordinator-design.md`, context-lifecycle section (the current choice, the escalation ladder, and the analysis behind them).

## I3. Clients beyond the trust boundary must be individually authenticated and capability-scoped

**Requirement.** Any client reaching ShipIt from outside the deployment's private network holds an individual identity with named capabilities, deny-by-default, individually revocable.

**Where it comes from.** Product req 27's authority boundary meeting network exposure. **V2 by user decision (2026-08-23):** the MVP's phone app and ShipIt share a Tailscale network, and network membership is the authentication — "authentication would not be needed." This requirement activates the day any surface is exposed beyond the tailnet.

**Solutions.** `api-proposal.md`, auth and structural-scoping section (per-client tokens, scopes, repo allowlists).

## I4. A stateful conversation API for the coordinator

**Requirement.** The coordinator has durable, programmatic state for its conversation with the user: the outbound pending-delivery queue, per-session suppression windows, and scheduled returns ("bring it back in a few days"). This state is the **sole executable source** of pending commitments — the memory repository may keep historical notes but no actionable ledger. It is separate from the session/fleet APIs and from the memory repository, survives context resets and restarts, and is what the platform's delivery machinery executes from.

Also durably here (round three, from the clarification-scope receipt): the **autonomous-clarification cap** — the coordinator's self-initiated clarification round-trips are capped per item, the cap survives retries, restarts, and context changes, and exhausting it surfaces the item to the user. The numeric default lives with the solutions in the design doc.

**Where it comes from.** Product reqs 26, 29, and 30 (reliable routing, loud failure, assistant instructions that hold across time and restarts) meeting req 21 (context is disposable, so no conversational guarantee may live in it). The user's framing: the delivery queue sits **on top of the coordinator, managed by it** — "we separate the smartness of the agent from reliability that would be programmatic."

**Solutions.** `coordinator-design.md`, "smartness sandwich" subsection (tool sketch and layering; MVP-minimal: a thin durable outbound queue plus routing, with curation verbs growing as usage teaches — req 12).

## Open questions

None. Adoption triggers for anything beyond the MVP minimum are the measurements recorded with the solutions in `coordinator-design.md`, and — for I3 — the moment of exposure beyond the private network.
