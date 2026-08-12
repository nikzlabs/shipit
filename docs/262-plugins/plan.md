---
issue: planning#355
title: Plugin repositories — declaration format & UI design
description: The shipit.yaml formats on both sides of the plugin edge, and the UI surfaces that make plugins visible, grantable, and refreshable.
---

# Plugin repositories — declaration format & UI design

Implements [requirements.md](requirements.md) (27 requirements; cited as
`(req N)`). This design slice covers **how plugins are declared and used**
and **every UI change**, with committed prototypes in
[mockup.html](mockup.html) (services panel) and
[mockup-plugins-tab.html](mockup-plugins-tab.html) (the Plugins tab).
Server mechanics are the next slice — see `checklist.md`. Independent design
reviews (adversarial + simplification passes) ran on 2026-08-12; accepted
findings are folded in below and recorded on planning#355, alongside the
user-directed revisions (repos+use syntax; the right-rail Plugins tab).

## 1. The two sides of the edge

A plugin crosses one edge: a **plugin repository** exports it; a **consuming
project** declares it. Each side owns one block in its own `shipit.yaml`.

### 1a. Consumer side — `plugins:` (req 11): declared repos + per-plugin use

Two sub-blocks (user decision, 2026-08-12, superseding both earlier shapes):
**`repos:`** declares which repositories to pull and at which version;
**`use:`** activates individual plugins by reference to a declared repo. The
repo declaration brings the files (req 2) and owns the version (req 8); a
`use` entry activates one plugin's services, commands, skills, and declared
needs. Fail-closed per entry (a malformed entry warns and is dropped; the
session still opens — req 13); a `use` entry whose `from:` names no declared
repo, or whose `plugin:` selector is not in that repo's manifest, is dropped
with a surfaced warning.

```yaml
plugins:
  repos:
    - repo: nicolasalt/game-tools # GitHub owner/name (v1; see Feedback below)
      name: game-tools            # explicit name: checkout path, feedback
                                  # destination, plugin card, refresh target
      branch: main                # tracked branch (default: repo default branch)
      # pin: v2.1.0               # tag or SHA; mutually exclusive with branch (req 8)
  use:
    - plugin: requirements        # selector: the exported plugin to activate
      from: game-tools            # references a declared repo by name
      alias: reqs                 # optional local name; default = plugin.
                                  # Keys overrides/settings/skills namespacing and UI.
      overrides:                  # optional — flat: the entry IS one plugin
        services:
          requirements:           # per SERVICE (req 16)
            autostart: false
            as: reqs-ui           # service alias on collision (req 20)
        commands:
          reqs:
            as: rt-reqs           # command alias on collision (req 20)
        settings:                 # req 26 — values for plugin-declared settings
          root: docs
```

The per-repository requirements — coherence (req 15), refresh (req 12),
independence (req 14), degradation (req 13), feedback (req 25) — attach to
the explicit `repos:` entry: one checkout, one generation, one refresh unit,
one feedback destination, one plugin card per declared repo. A declared repo
with zero `use:` entries is still checked out (req 2 gives its *files* to the
session); nothing from its manifest is activated. There is no derived
grouping and no ref-agreement rule — the version is stated exactly once.

Rules (review findings, both rounds):

- **Naming domains** (req 20) — five, each case-normalized, checked in the
  earliest phase that can know the answer (round-two finding 7 split the
  old "all at parse time" claim into three phases):
  - *Phase 1 — consumer-config parse* (no network): 1. repo `name`s **plus
    declared tracker names** (one reservation pass across both blocks; first
    declared wins, the loser is dropped with a surfaced warning). The
    reservation is also **destination-based**: a plugin repo whose GitHub
    repository is already a declared tracker does not register a second
    destination — its `name` becomes an alias of the existing one, so both
    names resolve to one adapter (round-two finding 6). 2. plugin `alias`es
    across all `use:` entries. Plus reference shape: unknown `from:`,
    `branch`+`pin`.
  - *Phase 2 — repository-generation validation* (after fetch, before
    activation): 3. `plugin:` selectors against the fetched manifest; a
    failing selected export invalidates that repository's generation
    (reqs 13, 14).
  - *Phase 3 — activation validation* (per session): 4. surfaced **service**
    names across the project and every plugin (service controls and log
    channels are name-addressed today — `ws-handlers/service-handlers.ts`);
    5. **command** names across every plugin, the project, and protected
    binaries (`shipit`, `git`, coreutils, the base PATH). An activation
    failure keeps the prior generation (or nothing) active and reports the
    collision; it never half-activates (req 15).
  Aliases are per service and per command; there is no plugin-wide rename of
  services or commands (the entry-level `alias` names the *plugin*, not its
  parts).
- **Pin durability** (req 8): `pin:` accepts a tag or SHA. On first
  resolution ShipIt records the resolved SHA durably, keyed by the consumer
  declaration, and stays there even if a tag moves (a moved tag warns). Only
  editing the declaration re-resolves.
- **Startup** (req 16): the plugin's compose fragment owns per-service
  defaults via the existing `x-shipit-preview` vocabulary; the consumer
  overrides per service. No plugin-level boolean exists.
- **Fail-closed grammar**: unknown keys warn; an unknown `from:` reference,
  an unknown `plugin:` selector, or `branch`+`pin` together drop the entry
  with a warning; setting values are scalars. Within one repository, a selected export that fails validation
  invalidates that repository's whole generation — degraded beats partial
  (reqs 13, 14).
- **Repo forms**: `owner/name` (GitHub) in v1 — the feedback channel needs a
  brokerable issue backend, which an arbitrary git URL does not have.
  Other hosts are a later extension, declared with an explicit issue
  backend or with feedback disabled.
- **Self-use** (req 27): a plugin repository dogfoods its own exports by
  declaring itself — `repo: self` in a `repos:` entry (with a `name`; no
  `branch`/`pin`, both are errors) plus ordinary `use:` entries. The
  "checkout" is the session's own working tree: **editable, live** — no
  staging, no generations, no refresh. Req 15 itself scopes its coherence
  guarantee to tracked, read-only checkouts and names the self-declared
  working tree as the ratified exception (final-review finding 1); req 7's
  read-only rule likewise does not apply; no feedback destination is registered (the repo's own
  issues are already this session's); `/project` and the CLI cwd point at
  the same working tree. Everything else — services, commands, skills,
  settings, needs — activates through exactly the consumer path.

### 1b. Plugin side — `exports.plugins:` (reqs 5, 17, 22, 23, 24, 26)

The plugin repository's own `shipit.yaml` gains an `exports.plugins` map —
one entry per plugin, each owning everything a consumer must never copy:

```yaml
exports:
  plugins:
    requirements:
      compose: plugins/requirements/docker-compose.yml  # service definitions,
                                                        # incl. per-service startup (reqs 5, 16)
      cli:
        reqs: plugins/requirements/cli                  # command name → entry (req 17)
      skills: plugins/requirements/skills               # dir shipped to sessions (req 22)
      install: npm --prefix . ci                        # see Install contract (req 7)
      install-inputs: [package-lock.json]                 # files whose content re-triggers install
      credentials: [FAL_KEY]        # names only — values live with each project (req 23)
      hosts: [fal.run]              # informational; grants nothing (req 24)
      settings:                     # declared settings + defaults (req 26)
        root:
          description: Directory inside the project the plugin reads and writes
          default: docs
```

The manifest is versioned with the repo, so a refresh (req 12) can change it;
parsing is fail-closed per plugin with the generation rule above (req 13).
Ahead of the parser, `plugins` and `exports` are **reserved top-level keys** in
`shipit-config.ts` (known-but-ignored), so a repo already carrying the
declaration — this repo's own fixture — doesn't render a migration warning.

**Fragment paths** (set by the fixture): relative paths in the compose
fragment resolve against the fragment's own directory inside the checkout
(through the writable layer), never against the consuming project. That is
how the fragment behaves standalone (`docker compose up` in its own
directory) — but it is **not** what compose's multi-file merge does, which
resolves relative paths from the base file. Slice 2 must therefore
deliberately preserve per-fragment resolution: compose `include` semantics,
or rebasing the fragment's paths before merging (review finding, this
round).
ShipIt-injected pieces (`/project`, the state dir, the `SHIPIT_*` env) are
deliberately not declared in the fragment, so it stays valid for a plain
`docker compose up` and the plugin can degrade its report gracefully.

**Install contract** (review finding 7): `install` runs with **cwd = the
plugin's checkout root inside its writable layer** — a copy-on-write layer
over the read-only checkout, so `node_modules` and build output land in the
layer, never in the checkout and never in the project (req 7). Writes outside
the layer fail. Install runs with the generation's env — `SHIPIT_PLUGIN_COMMIT`
set for a consumer generation, unset under `repo: self` (set by the fixture:
its install stamp records the commit, and the probe checks the stamp against
the active generation). Install re-runs when its stamped inputs change: the
plugin commit, the install string, or the content of the manifest's
`install-inputs` files (the same convention `agent.install` already uses).

## 2. How a plugin is used inside a session

- **Files** (reqs 2, 7): each declared repo is checked out read-only at
  `/plugins/<repo-name>` in the agent container (browsable by the agent),
  with the per-repo writable layer described above.
- **Workspace handle** (req 21): plugin *services* get the consuming
  project's workspace mounted at the fixed path **`/project`**; plugin *CLIs*
  run in the agent container with **cwd = the project workspace**, which
  keeps cwd-addressed tools (the requirements tool) working unchanged.
- **Shared plugin state** (reqs 17, 18 — review finding 2): each imported
  plugin (keyed by `alias`) gets a per-session **state directory**, mounted
  read-write into its service containers at **`/plugin-state`** and named by
  **`SHIPIT_PLUGIN_STATE`** on both surfaces (concrete names set by the
  fixture), surviving service restarts,
  refreshes, and container restarts, deleted with the session. This is the
  home of "same live state" between a CLI and a UI that is neither project
  data nor plugin source. Related mechanic for slice 2: a plugin service's
  **published port must stay stable per (session, service)** even if a
  tracked commit edits the fragment's port, because the preview origin is
  port-derived and req 18 guarantees origin stability.
- **Env**: `SHIPIT_PROJECT_DIR`, `SHIPIT_PLUGIN_COMMIT` (per declared repo;
  req 15 — the commit readable by the plugin itself; **unset under
  `repo: self`**, since a live tree corresponds to no exact commit — this is
  also how the fixture discriminates its two modes), and `SHIPIT_SETTINGS`
  — the path to one validated JSON file with the imported plugin's setting
  values, keyed by its `alias` (req 26; a per-setting env grammar was
  reviewed out as collision-prone). **Both surfaces get the same env names**
  (set by the fixture): for a CLI the paths are agent-container paths; for a
  service ShipIt mounts the settings file into the container and points the
  env at the mount. CLI wrappers use absolute entrypoints,
  so no plugin-dir variable is needed.
- **CLIs** (reqs 17, 20, 23): exported commands go on the agent's PATH as
  generated wrappers. A wrapper injects the plugin's declared credentials
  into that command's environment only — plugin credentials never enter the
  agent's general environment.
- **Skills** (req 22 — review finding 5): checkout alone discloses nothing —
  ShipIt's skill listing scans only the workspace skill dirs, and Codex
  reading `.claude/skills` is observed harness behavior, not a guarantee
  (docs/209). The design therefore **materializes** each imported plugin's
  skills into every backend's actual discovery root, namespaced
  (`plugins--<alias>--<skill>`), without touching project-tracked paths;
  refresh re-materializes and the agent re-scans on next turn. The docs/209
  verification rule applies to future backends.
- **Refresh** (reqs 12, 15 — review finding 1): refresh is **generation
  activation**, never in-place mutation. Stage the new checkout, validate
  the manifest, run install, prepare services — then atomically activate:
  swap the checkout path, CLI wrappers, `SHIPIT_PLUGIN_COMMIT`, and recreate
  affected services from the same generation. A CLI invoked mid-refresh runs
  the old generation or fails with "refreshing"; any failure keeps the old
  generation whole and active. Agent surface: `shipit plugin refresh
  [repo-name]`, which prints before/after status (a separate `list`/`status`
  command was reviewed out; the UI and `SHIPIT_PLUGIN_COMMIT` cover
  observability). Transport (round-two finding 3): the shim relays through
  the **worker's agent-ops surface** — like `shipit service` and the issue
  shim — because orchestrator API routes are default-denied to containers
  (`api-container-guard.ts`); the browser's `/api/plugin-repos` endpoints
  are not the agent's path. In the dogfood inner instance, local mode's
  agent-ops host allowlists routes explicitly (`local-agent-ops.ts`), so the
  relay must be added there too, with the parity test extended.
- **Fetch authority and the standing grant** (req 19): repository fetches
  run **orchestrator-side** (the bare cache), so fetch credentials never
  exist inside the session container — plugin `install`, services, and CLIs
  cannot read them, by construction, and a guard test owns that boundary
  (slice 2). The standing grant means activation never prompts: a new
  tracked-branch commit stages, validates, and activates with no approval
  step, and the visible repo/ref/commit identity on the plugin card — in
  every state, including degraded and collision — is the accountability
  surface that replaces approval.
- **Feedback** (req 25 — review finding 12): each declared repo registers
  its `name` in the **same tracker registry** the issue shim and Issues UI
  resolve (`GET /api/trackers`) — a separate registry would leave
  `shipit issue create --tracker game-tools` unresolvable. One destination
  per repository, however many plugins are used from it. Filing stays
  brokered; the token stays out of the container.

## 3. UI design

Prototypes: [mockup.html](mockup.html) (services list) and
[mockup-plugins-tab.html](mockup-plugins-tab.html) (the Plugins tab). The
review's simplification pass first cut the v1 surface to one plugin card plus
service-row badges; a later user decision (2026-08-12) moved the card out of
the chat column into a **dedicated right-rail Plugins tab** — the chat
column's PR card describes the work in flight, while plugins are session
*environment*, so their instrument panel belongs with the other right-rail
instruments. The move deletes mechanism: the PR-card strip generalization
(the PR-conditioned `hasPanelContent` parent change) and the chip-anchored
popover are both gone. Two rules keep the tab honest: it renders **only when
the project declares plugins** (zero rail cost otherwise), and **urgency
escapes the tab** as a warn dot on the tab label, so a closed tab can hide
information but never a problem. **Naming note:** the marketplace skills
feature already owns `PluginInfo` and `/api/plugins/*` (docs/149), so this
feature's code namespace is **`PluginRepo*`** and **`/api/plugin-repos`**;
only the `shipit.yaml` key says `plugins:`.

| Surface | Mock | Extends | Change |
|---|---|---|---|
| Service rows: origin badge (reqs 3, 15, 16) | A | `ServiceList.tsx`, `PreviewServicesDrawer.tsx` | Services keep `name` as their client identity (it is already globally collision-checked, req 20, and it is today's control/log address) and gain only a **structured `origin`** field on `ManagedServiceState` and the service WS messages — the runtime-ID/display-name layer was reviewed out (round-two finding 9). A small origin chip renders beside `ModeBadge` in every drawer path. No group headers. Health counts stay over service rows only |
| **The Plugins tab** — a right-rail tab holding one card per declared repo: ref @ exact SHA, the plugins used from it, needs, grants, refresh, degraded and collision states (reqs 12, 13, 15, 20, 23, 24) | tab mock 1–3 | The right-rail tab strip (`App.tsx` ~1690–1895; `Tab.badge` slot for the warn dot) | New tab, gated on **plugin intent, not on valid repos** (round-two finding 2): a `plugins:` block that parses to zero valid repos still shows the tab, and parse warnings, never-fetched, and unavailable states all count toward the warn dot — otherwise an invalid declaration erases its own warning surface (req 13). The dot uses the existing `Tab.badge` slot with an accessible label ("Plugins — attention required"). Client state is a **session-scoped store** (not pane-local): seeded from the snapshot on attach/reload, stale-session guarded, refetched by the `files-changed` shipit.yaml hook, feeding the dot while the pane is closed; when the tab disappears (declaration edited away, session switch to a plugin-less repo) an effective-tab fallback coerces `rightTab` to Preview/Files, and the tab joins `useTabLabelCollapse`'s dependency key. Mobile needs nothing separate — the same right panel renders under Workspace. Data: `GET /api/plugin-repos?sessionId` returns one authoritative snapshot (declaration incl. **`consumerRepoUrl`**, resolved ref/SHA, exports, needs and their satisfaction, degraded/collision state); WS `plugin_repo_status` carries deltas with `sessionId`. Grants happen here: **"Add key…" opens the Project Settings dialog on the CONSUMING project's secret store** — `setProjectSettingsRepoUrl(consumerRepoUrl, "secrets")`; passing the plugin repo's URL would save the key into the wrong store, since that call selects the store `/api/secrets` writes to (round-two finding 1). "Allow (session)/(instance)" posts to the existing not-container-accessible `POST /api/egress/hosts` with the scope choice. The `PrLifecycleCard` and its strip are **untouched**. No "commits behind" badge (req 15 wants ref + exact commit, not network polling) |
| Needs — credentials (req 23) | tab mock 1 | `SecretsTab.tsx` / `DeclaredSecretRow.tsx`, fed by `secrets_status` | `secrets_status.declared` gains an **origin** dimension (it is flat, name-keyed today — `service.ts:117`, and `SecretsTab` save assumes unique names). A project credential and a plugin credential with the same name are **deliberately the same stored secret**; multiple claimants render as one row with claimant chips |
| Needs — hosts (req 24) | tab mock 1 | The plugin card's needs rows, over the existing `POST /api/egress/hosts` (global or session scope; browser-only) | "Host not allowed" is evaluated against the **agent container's** allowlist — where companion CLIs run — because today's containment lives in the agent's netns while compose service containers have unrestricted egress (docs/172 residual). The need-row therefore names the blocked claimant (e.g. "blocks `artk`") rather than asserting one repository-level truth across both execution surfaces (round-two finding 4). Whether plugin *services* get their own containment is an explicit slice-2 decision, not a side effect of compose validation. Grant endpoints stay browser-only, so plugin code cannot self-grant |
| Degraded / collision reporting (reqs 13, 20) | tab mock 2 | Card states inside the Plugins tab | **One card per declared repo, always** — simultaneous problems compose as multiple issue rows under one header whose status chip shows the worst state (round-two finding 8). Every card state, including degraded and collision, keeps the full `owner/repo` + ref @ commit identity visible (req 19 — the identity is what the standing grant trades approval for). **Degraded** distinguishes "refresh failed — prior version `<sha>` remains active" (req 15) from "never fetched — session runs without this repo's services" (req 13); **collision** names the colliding domain and the fix as "under the `use` entry whose alias is `<alias>`" (a `use` entry is a YAML sequence item, so there is no bracket path). Not transcript cards — no new DB columns, stores, or migrations |

Settings → Network egress is **unchanged** (it is explicitly the global-only
editor — `SettingsEgress.tsx:135`); the diagnostics panel addition and the
multi-host `EgressPromptCard` variant were reviewed out of v1.

**How the client learns the declaration** — the `issues.trackers` precedent,
copied: per-request config read behind `GET /api/plugin-repos`, the
`files-changed` handler refetches on `shipit.yaml` edits (with the
`declarationsPending` guard against caching an empty read), and the
`plugin_repo_status` WS message keeps user- and agent-triggered refreshes
coherent in one UI.

## 4. Key files (anticipated; ✓ = exists)

- ✓ `src/server/shared/plugin-repos.ts` — both blocks parsed here (consumer
  `plugins:`, plugin `exports.plugins:`), one cross-block name reservation
  pass, fail-closed grammar, and the snapshot projection. Filesystem-free so
  the client imports the types; `shipit-config.ts` is the entry point and
  parses trackers first (the reservation order).
- ✓ `src/server/orchestrator/api-routes-plugin-repos.ts` — browser snapshot
  (the GET exists; refresh endpoints come with generation mechanics); tracker
  registration folds into the existing trackers registry
  (`api-routes-issues.ts`) with destination-based dedup.
- `src/server/session/agent-shim/shipit-plugin.ts` + a worker agent-ops
  relay route — the agent's `shipit plugin refresh` transport (orchestrator
  API routes are container-denied; the shim goes through the worker like
  `shipit issue`).
- ✓ `src/client/stores/plugin-repos-store.ts` — the session-scoped store
  behind the tab, its warn dot, and the effective-tab fallback; the pane is
  `PluginReposPanel.tsx`. v0 renders declarations with an honest
  "declared — mechanics pending" state for tracked repos (not counted toward
  the warn dot; the full state set arrives with the slice-2 mechanics).
- `src/server/shared/types/ws-server-messages/service.ts` — structured
  `origin` on service messages; `secrets_status` origin dimension; new
  `plugin_repo_status`.
- `src/client/components/ServiceList.tsx`, `PreviewServicesDrawer.tsx`,
  `SecretsTab.tsx` — the
  extensions in the table above; the Plugins tab pane (registered in the
  `App.tsx` rail) is the one new component. `PrLifecycleCard/` is untouched.
- `src/server/shipit-docs/` — a new `plugins.md` for the agent-facing
  contract, once slice-2 mechanics are settled.

## 5. Verification: dogfood a plugin inside ShipIt itself

The implementation is driven by a **test plugin exported by the ShipIt repo
itself** — a deliberately small export with one tiny service, one CLI, one
skill, one declared setting, one declared credential name, and one declared
host. **It exists**: [`test-plugin/`](../../test-plugin/README.md), with the
manifest and the `repo: self` declaration live in this repo's `shipit.yaml`.
Each export is a *probe* that reports which contract pieces it received, so a
regression shows as a changed report field. It is exercised through **two
fixtures**, because self-use deliberately has
no checkout, generations, or refresh (req 27) and therefore cannot dogfood
them: (a) **self-declared** (`repo: self`) for the live-working-tree path,
and (b) **consumer-declared** — the inner instance declaring the test
plugin's repo by `owner/name` — for checkout, generation activation, pin
durability, and refresh. The consumer fixture lives in the dogfood seed repo
`nicolasalt-shipit/todo-list` (its PR #13): it exports its own tiny
`todo-stats` CLI plugin, dogfoods it via `repo: self`, and consumes this
repo's `probe` by `owner/name` — two declared repos in one project, which
also exercises req 14 independence.

What runs where — the dogfood boundary:

- **Inner dogfood instance** (`RUNTIME_MODE=local`, the `dev` compose
  service): everything **except compose services and preview** — local mode
  skips Docker entirely, so plugin services cannot start there. Covered in
  the inner loop: declaration parsing and phased validation, checkout and
  generation mechanics, the Plugins tab (gating, warn dot, cards, grants),
  needs plumbing (`secrets_status` origin, egress rows), CLI wrappers and
  credential injection, skills materialization, and — via the consumer
  fixture — checkout/generation mechanics and `shipit plugin refresh`
  through the agent-ops relay (which local mode's explicit route allowlist
  must admit; see §2).
- **Integration tests** (`isTestMode`, fakes — the existing pattern): the
  service path — compose-fragment merge, per-service startup and overrides,
  origin on `service_list`/`service_status`, collision activation failures.
- **A real instance**: the one end-to-end that needs Docker — plugin service
  + preview + `window.shipit` interaction, verified once per milestone
  rather than per change.

## 6. Deliberately not in this slice

Slice 2 (see `checklist.md`): checkout/bare-cache mechanics and the writable
layer, generation staging/activation internals, compose-fragment merging and
security validation, port stability per (session, service), credential
injection mechanics, PATH wrapper generation, skills materialization
mechanics, GitHub App multi-repo minting.
