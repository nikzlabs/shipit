---
title: Grok Build harness — requirements
description: Grok Build (xAI's `grok` CLI) as ShipIt's fourth coding-harness backend, integrated per the docs/266 recipe.
---

# Grok Build harness — requirements

Requirements for integrating Grok Build as ShipIt's fourth harness, alongside
Claude Code, Codex, and OpenCode. The integration follows
[docs/266-harness-integration-recipe/plan.md](../266-harness-integration-recipe/plan.md);
this doc holds what the feature must do, [plan.md](./plan.md) holds how.

Source of the decisions below: the orchestrating session's spawn brief
(2026-08-18), which settled them ahead of time from docs/266's candidate
assessment ([candidates.md §Grok Build](../266-harness-integration-recipe/candidates.md)).
They are recorded here as requirements, not relitigated.

## Requirements

1. **Fourth harness.** Grok Build (the `grok` CLI, xAI) is available as a
   harness wherever a harness can be selected — session creation, model
   picking, roles — on installs that include it in `SHIPIT_HARNESSES`.
2. **Claude-shaped spawn-per-turn adapter.** Grok Build imitates Claude
   Code's flag surface (`-p`, `--output-format streaming-json`,
   `--always-approve`, `--resume`); the adapter spawns one process per turn
   and maps its NDJSON stream, mirroring `session/agents/claude/`.
3. **Pinned, reproducible install — a settled design, not an improvisation.**
   `grok` is curl-installed, not npm, so it cannot ride the npm-lockfile
   pipeline. The install design (how the exact version is acquired and baked,
   auto-update disabled, and the id written into `installed.json` — the
   authoritative installed-set report) is recorded in plan.md and signed off
   before implementation. The third-party claim that the install script
   accepts a pinned version must be verified live, not trusted.
4. **Not default-on at launch.** Per docs/271, default-set membership
   (`DEFAULT_HARNESSES` / `HARNESS_DEFAULT`) is a separate, deliberate
   product decision; Grok Build ships installable-but-unchecked. Dogfooding
   uses the explicit `SHIPIT_HARNESSES` build arg in both dogfood compose
   blocks (docs/266 step 3).
5. **Stream conformance before trust.** The streaming-json event schema is
   undocumented. Real transcripts are captured in-container, the adapter's
   event mapping is locked by a conformance test replaying byte-shaped
   captured lines (docs/272 conventions), and no capability flag is declared
   from documentation alone.
6. **Auth.** Subscription auth is injected via the CLI's real on-disk token
   store (the `~/.grok/auth.json` path and `--device-auth` flow are
   third-party claims — verified live before wiring); API-key auth via
   `XAI_API_KEY`. ShipIt's subscription-first ranking applies. Grok Build's
   beta gating (SuperGrok / X Premium Plus) limits who can sign in; it does
   not change the wiring.
7. **Recipe discipline.** Every step of the docs/266 recipe is worked,
   including the full silent-sites list, and every declared
   `AgentCapabilities` flag is honest — confirmed against observed CLI
   behavior, not documentation.
8. **Reviewer wiring stays valid.** Grok Build declares reasoning levels it
   actually offers, and `REVIEWER_DEFAULT_EFFORT` names one of them
   (`reviewer-model.test.ts` constraint). If live verification finds no
   reasoning control at all, integration stops for a reviewer-default design
   decision before any recipe step (docs/266 Phase 0 blocker semantics).

## Open questions

Phase 0 live verification is not yet run (network access pending at time of
writing). The following are *conditional* human calls — each opens only if
research lands on its "no" branch; facts themselves are resolved empirically
and recorded below, per the docs/268 precedent.

- **If the install script cannot pin a version** (req 3's third-party claim
  fails): integrating requires an explicitly signed-off exception to the
  dependency policy — a human call, not a recipe step.
- **If no injectable subscription path exists** (req 6's claims fail):
  launching metered-only (`XAI_API_KEY`) needs explicit sign-off, since
  ShipIt is subscription-first.
- **If no reasoning control exists** (req 8): stop and report; the
  reviewer-default mechanism needs a design decision first.

## Resolved questions

None yet.
