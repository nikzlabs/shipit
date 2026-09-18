---
title: Fleet coordination — implementation-level requirements
description: Technical-tier requirements with their provenance — what each must achieve and where it comes from. Solutions live in plan.md.
---

# Implementation-level requirements

Split from `requirements.md` on 2026-08-23 at the user's direction. The product statement stays at the top level — now numbered, scoped, in req 10: within the coordinator conversation, delivery comes from the agent and input goes to the agent. This document holds the technical requirements underneath that experience — each stated as what must be achieved, with **where it comes from**. Potential solutions, and which one is currently chosen, live in `plan.md` (MVP choices in its design sections, everything evidence-gated in its "Deferred designs" section); this document names none.

Standing rule: **the MVP builds the minimal thing that satisfies the top-level product requirements.** Anything here beyond the minimum is adopted only when observed evidence demands it.

## I1. Simultaneous completions must not confuse the coordinator

**Requirement.** When many sessions finish at the same time, the user still experiences orderly, one-at-a-time, comprehensible delivery. No arrival is lost, duplicated, or garbled by volume.

**Where it comes from.** Product reqs 1–2 and 5–6 (items delivered and discussed item by item, decidable by ear) meeting an observed model limitation: an agent — especially on a weaker model — may be confused when handed multiple conversations at once ("if multiple sessions all end at the same time, the agent may be confused, especially if the model powering it is not very powerful"). Whether this pressure requires machinery at all is open — "maybe we don't even need it" — which is why it is a requirement on the outcome, not on a mechanism.

**Solutions.** `plan.md` §6 (the MVP wake model) and §13 (the serialized narrowing, evidence-gated).

## I2. A permanent conversation on a finite context window

**Requirement.** The coordinator's model context is finite and fills on heavy days; the conversation is permanent (product req 14). Whatever keeps the context healthy must satisfy the product-level acceptance contract: no degradation over months (req 20) and complete invisibility to the user on every surface (req 21).

**Where it comes from.** Product reqs 14, 20, 21 colliding with the physical context limit of every harness; sharpened by the user's observation that a heavy single day needs the same treatment as any calendar boundary — the clock has no role, context weight does.

**Solutions.** `plan.md` §8 (the v1 choice and its measurements) and §13 (the escalation ladder and the reset, with the analysis behind them).

## I3. Clients beyond the trust boundary must be individually authenticated and capability-scoped

**Requirement.** Any client reaching ShipIt from outside the deployment's private network holds an individual identity with named capabilities, deny-by-default, individually revocable.

**Where it comes from.** Product req 27's authority boundary meeting network exposure. **V2 by user decision (2026-08-23):** the MVP's phone app and ShipIt share a Tailscale network, and network membership is the authentication — "authentication would not be needed." This requirement activates the day any surface is exposed beyond the tailnet.

**Solutions.** `plan.md` §13, I3 entry (per-client tokens, scopes, listener isolation, repo allowlists).

## I4. A stateful conversation API for the coordinator

**Requirement.** The coordinator has durable, programmatic state for its conversation with the user: the outbound pending-delivery queue, per-session suppression windows, and scheduled returns ("bring it back in a few days"). This state is the **sole executable source** of pending commitments — the memory repository may keep historical notes but no actionable ledger. It is separate from the session/fleet APIs and from the memory repository, survives context resets and restarts, and is what the platform's delivery machinery executes from.

Also durably here (round three, from the clarification-scope receipt): the **autonomous-clarification cap** — the coordinator's self-initiated clarification round-trips are capped per item, the cap survives retries, restarts, and context changes, and exhausting it surfaces the item to the user. The numeric default lives with the solutions in the design doc.

**Where it comes from.** Product reqs 26, 29, and 30 (reliable routing, loud failure, assistant instructions that hold across time and restarts) meeting req 21 (context is disposable, so no conversational guarantee may live in it). The user's framing: the delivery queue sits **on top of the coordinator, managed by it** — "we separate the smartness of the agent from reliability that would be programmatic."

**Solutions.** `plan.md` §5 (the smartness sandwich: MVP verbs, the delivery executor, and the clarification cap; MVP-minimal per req 12, curation verbs growing as usage teaches).

## I5. The agent-facing API is token-efficient and simple

**Requirement.** Operating the fleet costs the coordinator little: the agent-facing surface of the control API is token-efficient — small fixed overhead riding the agent's context, small per-operation cost — and simple for the agent to use correctly.

**Where it comes from.** Stated by the user (2026-08-23, after the review rounds closed): "the API should be token-efficient and simple for the agent." The pressure behind it is I2's permanent conversation on a finite context — whatever the tool surface costs, it costs on every turn, for months — under req 20's no-degradation contract. The user's suggested direction to explore, verbatim: "the CLI-based one, wrapping whatever handlers are exposed by the server."

**Solutions.** `plan.md` §3 (the brokered CLI over the handler substrate) and §13 (the named-tool alternative, evidence-gated).

## Open questions

None. Adoption triggers for anything beyond the MVP minimum are the measurements recorded with the solutions in `plan.md` (§8, §13), and — for I3 — the moment of exposure beyond the private network.
