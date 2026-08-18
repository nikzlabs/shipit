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
3. **Pinned npm install.** Grok Build installs through the existing
   `docker/agent-cli` npm pipeline, pinned to an exact `@xai-official/grok`
   version at least 7 days published (dependency policy), with the CLI's
   auto-updater disabled so the pinned binary never self-replaces.
   *(Reworded 2026-08-18 — see Resolved questions: the original text assumed
   curl-only distribution; an official npm package exists.)*
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

The following is a *conditional* human call — it opens only if live
verification lands on its "no" branch; facts themselves are resolved
empirically and recorded below, per the docs/268 precedent.

- **If no injectable subscription path works in practice** (req 6 — the
  on-disk store is confirmed first-party, but an injected `auth.json`
  authenticating a headless turn in a fresh container is unverified until a
  credential is available): launching metered-only (`XAI_API_KEY`) needs
  explicit sign-off, since ShipIt is subscription-first.

## Resolved questions

- **2026-08-18 — Can the install be exact-pinned (req 3, a start-blocker)?**
  Resolved empirically, better than expected: an **official npm package
  `@xai-official/grok`** exists (latest 1.0.5; verified against the registry
  — platform binaries as `optionalDependencies` + postinstall shim, the same
  shape as `opencode-ai`), so Grok rides the standard npm-lockfile pipeline
  with the established `npm rebuild` exception; no policy exception and no
  bespoke curl/bake design is needed. The curl installer's pin claim also
  verified first-party (`install.sh` accepts `bash -s X.Y.Z`), and
  auto-update has three first-party kill switches (`--no-auto-update`,
  config `[cli] auto_update`, `GROK_DISABLE_AUTOUPDATER`). The original
  req 3 text and the pin-exception open question were rewritten/removed
  accordingly.
- **2026-08-18 — Does Grok Build expose reasoning control (req 8, a
  start-blocker)?** Partially resolved, twice revised by evidence. The
  `--reasoning-effort <EFFORT>` flag (alias `--effort`) exists, with
  per-model `reasoning_efforts` catalog machinery in the binary — but
  recorder-verified probes in **API-key mode** show the flag silently
  dropped for every model tried (no effort field reaches the wire);
  key-mode reasoning is selected by model id (`-reasoning` /
  `-non-reasoning` pairs). The effort machinery appears gated on the
  subscription catalog, so whether req 8 can be satisfied as written —
  `REVIEWER_DEFAULT_EFFORT` naming a real level — **is pending the
  subscription device-flow login**. If subscription mode also offers no
  levels, the docs/266 "harness with no reasoning levels" design decision
  applies and integration pauses at the reviewer wiring, per req 8's
  stop-and-report branch.
