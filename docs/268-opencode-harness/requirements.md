---
title: OpenCode harness — requirements
description: OpenCode (`opencode` CLI) as ShipIt's third coding-harness backend, integrated per the docs/266 recipe.
---

# OpenCode harness — requirements

Requirements for integrating OpenCode as ShipIt's third harness, alongside
Claude Code and Codex. The integration follows
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md);
this doc holds what the feature must do, [plan.md](./plan.md) holds how.

Source of the decisions below: the orchestrating session's spawn brief
(2026-08-16), which settled them ahead of time from docs/266's candidate
assessment. They are recorded here as requirements, not relitigated.

## Requirements

1. **Third harness.** OpenCode (the `opencode` CLI, npm package `opencode-ai`)
   is available as a harness wherever a harness can be selected — session
   creation, model picking, roles — on installs that include it in
   `SHIPIT_HARNESSES`.
2. **Spawn-per-turn adapter.** The adapter spawns `opencode run` once per turn
   (Claude-shaped). Attach-to-server (`opencode serve` + `--attach`) is out of
   scope — a separate future design task with its own docs folder.
3. **Pinned npm install.** OpenCode installs through the existing
   `docker/agent-cli` npm pipeline, pinned to an exact `opencode-ai` version at
   least 7 days published (dependency policy). ~~Not in the default
   `SHIPIT_HARNESSES` set.~~ **Superseded 2026-08-17 (docs/271):** every known
   harness is now in the default set, OpenCode included. See that doc's resolved
   questions for the instruction; the pinned-install half of this requirement is
   unchanged.
4. **Lossy-stream tolerance.** OpenCode has known event-loss bugs (dropped
   `text`/`step_finish`; exit before the final event; post-error hangs). A turn
   whose final `step_finish` never arrives must still terminate correctly: the
   adapter synthesizes the terminal result from process exit, and a test locks
   that path.
5. **Auth scope.** Anthropic models via OpenCode are API-key (metered) only —
   upstream removed Anthropic subscription login (v1.3.0; Anthropic prohibits
   it) — and no subscription-mode service may be offered on OpenCode at
   launch. ChatGPT/Copilot OAuth are OpenCode's subscription routes; wiring
   them into ShipIt is deliberate follow-up work, not part of this feature
   (see plan.md, "Auth scope").
6. **Recipe discipline.** Every step of the docs/266 recipe is worked,
   including the full silent-sites list, and every declared
   `AgentCapabilities` flag is honest — confirmed against observed CLI
   behavior, not documentation.
7. **Reviewer wiring stays valid.** OpenCode declares reasoning levels it
   actually offers, and `REVIEWER_DEFAULT_EFFORT` names one of them
   (`reviewer-model.test.ts` constraint).

## Open questions

None.

## Resolved questions

- **2026-08-16 — Does OpenCode expose reasoning control (docs/266 Phase 0 row
  12, a start-blocker)?** Resolved empirically against CLI 1.18.15, not by a
  human: `opencode run --variant <level>` exists (per-model named variants;
  observed vocabulary `none|minimal|low|medium|high|xhigh|max`), and reasoning
  effort was verified reaching the wire for custom-provider models. The
  "STOP and report if none" branch in the spawn brief was not taken.
- **2026-08-16 — Adapter shape, install path, stream-conformance criterion,
  auth scope** (reqs 2–5): settled in the orchestrating session's spawn brief,
  citing docs/266's candidate assessment; recorded verbatim above.
