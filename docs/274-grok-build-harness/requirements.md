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
6. **Auth scope: key-billed only at launch.** API-key auth via `XAI_API_KEY`,
   enforced structurally the way docs/268 did for OpenCode (no `account`
   credential target, so no subscription mode joins). Subscription-mode
   verification and wiring (device-flow login, `auth.json` injection,
   account identity, quota) are deferred to **planning#435** — postponed
   2026-08-18 by Nik (requires a paid SuperGrok subscription). *(Reworded
   2026-08-18 — see Resolved questions; the original text assumed
   subscription wiring in this feature.)*
7. **Recipe discipline.** Every step of the docs/266 recipe is worked,
   including the full silent-sites list, and every declared
   `AgentCapabilities` flag is honest — confirmed against observed CLI
   behavior, not documentation.
8. **Reviewer wiring stays valid — via the no-levels mechanism extension.**
   Key-mode Grok offers no reasoning-effort levels (the flag is silently
   dropped; reasoning is a model-id choice), so Grok declares an honest
   empty reasoning list, and the reviewer-default mechanism is extended so
   a zero-levels harness is valid (its `REVIEWER_DEFAULT_EFFORT` entry
   empty/absent; guard tests updated to accept that shape for exactly this
   case). Revisit under planning#435 if subscription mode turns out to have
   real levels. *(Reworded 2026-08-18 from the original stop-and-report
   branch — see Resolved questions.)*
9. **Launch model set: grok-4.6 first-class, plus grok-4.3 and the
   key-mode defaults.** grok-4.6 ("the top model") must be probed live and
   supported; grok-4.3 (added 2026-08-18) and the grok-4.20-0309
   reasoning/non-reasoning pair (the CLI's own key-mode default line) ship
   alongside it. Real prices and context windows come from the live
   `/v1/models` API, never sentinels.

10. **Subscription mode is a second billing mode, not a second credential.**
    Grok Build is usable on a SuperGrok / X Premium+ subscription alongside
    the existing key mode, wherever a model is selected. The two are
    genuinely different offerings — different host, different API style and a
    disjoint model set (see plan.md) — so the catalogue must express them as
    two modes rather than one mode with two credentials.
11. **Signing in happens inside ShipIt.** The user connects a Grok account
    without leaving the product (§1): ShipIt runs the device-code flow and
    shows the verification URL and code, the user approves in their browser
    (an §3 external tab — xAI owns its login screen), and the account appears
    as a connected row. No terminal step, and no instruction to run a CLI.
12. **A connected account reaches a fresh container.** Once connected, the
    account authenticates turns in containers created later, including after
    an idle container is destroyed and recreated. Connecting once is enough.
13. **A session must not lose authentication part-way through work.** The
    subscription token is short-lived (~6h observed, with a refresh token),
    so a session that outlives one token keeps working without the user
    signing in again — a one-time copy of the credential file is not enough
    to satisfy this.
14. **Reasoning levels are offered where they exist and never where they are
    silently dropped.** This supersedes the key-mode-only finding behind req
    8: subscription mode does honour `--reasoning-effort` (wire-verified with
    a negative control), while key mode still discards it. So the levels a
    user can pick must follow the actual selection, and a Grok reviewer's
    `REVIEWER_DEFAULT_EFFORT` entry may name a real level for a selection
    that has them.
15. **The account's own identity and plan are visible on its row**, so two
    rows holding the same upstream subscription are distinguishable (the
    docs/150 req 22 duplicate-detection contract every other provider row
    already meets).
16. **Quota is reported honestly or not at all.** If xAI exposes no usage API
    for the subscription, ShipIt says so rather than rendering an empty or
    invented indicator — a declared reader that reads nothing is the state
    `catalogue/types.ts` warns against, not a placeholder to fill in later.

17. **A connected Grok subscription ranks above the metered xAI key**, the
    way every other connected account ranks above a metered key. Because the
    two modes offer disjoint model sets, this changes which models a Grok
    session gets and not only who pays for them — that consequence is
    accepted, not overlooked (see Resolved questions).
18. **Subscription mode ships both `grok-4.6` and `grok-4.5`.** Req 9's
    launch set was decided for key mode and does not constrain this one; the
    subscription offers both, so both appear.

## Open questions

None.

## Resolved questions

- **2026-08-19 — Does a subscription rank above the metered key (req 17)?**
  Asked with options; Nik chose **"Subscription first"**, the house rule,
  having been told the caveat explicitly: the two xAI modes do not offer the
  same models, so preferring the subscription also decides which models a
  session gets. Req 17 records both the rule and the accepted consequence.
- **2026-08-19 — Does `grok-4.5` ship (req 18)?** Asked with options; Nik
  chose **"Ship both 4.6 and 4.5"**. Recorded as req 18.

- **2026-08-19 — Does subscription mode offer real reasoning-effort levels
  (the open thread req 8 left)?** Resolved empirically: **yes**, and req 14
  above records the requirement it produces. The subscription catalogue
  (`GET https://cli-chat-proxy.grok.com/v1/models`) declares
  `supports_reasoning_effort: true` with per-model vocabularies — `grok-4.6`:
  xhigh/high/medium/low (default high); `grok-4.5`: high/medium/low. **And
  the flag reaches the wire**, which the catalogue alone does not prove: two
  otherwise-identical runs through a local recorder at
  `GROK_CLI_CHAT_PROXY_BASE_URL` produced
  `reasoning={"effort":"xhigh","summary":"concise"}` with
  `--reasoning-effort xhigh` against `reasoning={"effort":"high",…}` for the
  no-flag control. The control is what makes it evidence rather than an
  observation of a default that was already there — the docs/272 lesson.
  Key mode is unchanged: no effort field reaches the wire at all.
  Requirement wording is the orchestrating session's (2026-08-19), stated at
  the UX level deliberately: *"levels are offered where they exist and never
  where they are silently dropped."*
- **2026-08-19 — Who designs the per-mode reasoning shape?** Asked upward,
  since making a per-*harness* capability answer a per-*mode* question is
  design-visible and touches docs/275's role-completeness rule. The
  orchestrating session answered: **design it in this PR, do not split it** —
  splitting would ship subscription mode either mis-declaring levels on
  key-mode selections or offering none at all. Recorded here because it
  decides scope, not because it changes a requirement.

- **2026-08-18 — Reviewer wiring with a zero-levels harness (the docs/266
  design decision).** Asked with options; Nik chose **"Extend the mechanism
  now"**: the reviewer-default mechanism learns to accept a harness with no
  reasoning levels, Grok launches with an honest empty list, revisited
  under planning#435. Req 8 reworded accordingly.
- **2026-08-18 — Launch model set.** Asked with options (recommendation was
  the grok-4.20 pair only); Nik answered: *"4.6 is the top model and we
  need to probe and support it."* Recorded as req 9: grok-4.6 is
  first-class and gets a live probe; the 4.20 pair (my recommended
  key-mode defaults, not rejected) ships alongside. If the intent was
  grok-4.6 *only*, strike the pair from req 9. **Amended later the same
  day**: Nik added grok-4.3 to the set ("let's also add Grok 4.3") — and
  the pair staying was implicitly confirmed by the follow-up being an
  addition, not a replacement.

- **2026-08-18 — Metered-only launch (the former conditional open
  question).** Nik postponed subscription verification (it requires a paid
  SuperGrok subscription) and directed it be filed separately →
  planning#435. That is the explicit sign-off for a key-billed-only launch;
  req 6 was reworded accordingly, following the docs/268 OpenCode
  precedent (structural exclusion via the missing `account` target).

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
