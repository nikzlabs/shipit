---
issue: planning#355
title: Plugin repositories — declaration format & UI design
description: The shipit.yaml formats on both sides of the plugin edge, and the UI surfaces that make plugins visible, grantable, and refreshable.
---

# Plugin repositories — declaration format & UI design

Implements [requirements.md](requirements.md) (26 requirements; cited as
`(req N)`). This design slice covers **how plugins are declared and used**
and **every UI change**, with committed prototypes in [mockup.html](mockup.html).
Server mechanics are the next slice — see `checklist.md`. An independent
design review (adversarial + simplification passes) ran on 2026-08-12; its
accepted findings are folded in below and recorded on planning#355.

## 1. The two sides of the edge

A plugin crosses one edge: a **plugin repository** exports it; a **consuming
project** declares it. Each side owns one block in its own `shipit.yaml`.

### 1a. Consumer side — `plugins:` (req 11)

Modeled on `issues.trackers`: a list of named repository declarations,
fail-closed per entry (a malformed entry warns and is dropped; the session
still opens — req 13).

```yaml
plugins:
  - repo: nicolasalt/game-tools   # GitHub owner/name (v1; see Feedback below)
    name: tools                   # local name: unique, used in paths, UI, references
    branch: main                  # tracked branch (default: repo default branch)
    # pin: v2.1.0                 # tag or SHA; mutually exclusive with branch (req 8)
    select: [requirements]        # optional; default = everything exported (req 5)
    overrides:                    # optional, per exported plugin
      requirements:
        services:
          requirements:           # per SERVICE, not per plugin (req 16)
            autostart: false
            as: reqs-ui           # service alias on collision (req 20)
        commands:
          reqs:
            as: rt-reqs           # command alias on collision (req 20)
        settings:                 # req 26 — values for plugin-declared settings
          root: docs
```

Rules (review findings 3, 4, 6, 12):

- **Naming domains** (req 20) — four, each case-normalized and checked
  independently at parse time:
  1. plugin-repo `name`s **plus declared tracker names** (one reservation
     pass across both blocks; first declared wins, the loser is dropped with
     a surfaced warning) — the feedback channel (req 25) registers `name`
     into the tracker address space;
  2. exported plugin names within one manifest (`select`/`overrides` keys);
  3. surfaced **service** names across the project and every plugin
     (service controls and log channels are name-addressed today —
     `ws-handlers/service-handlers.ts`);
  4. **command** names across every plugin, the project, and protected
     binaries (`shipit`, `git`, coreutils, anything already on the base
     PATH).
  Aliases are per service and per command; there is no plugin-wide rename.
- **Pin durability** (req 8): `pin:` accepts a tag or SHA. On first
  resolution ShipIt records the resolved SHA durably, keyed by the consumer
  declaration, and stays there even if a tag moves (a moved tag warns). Only
  editing the declaration re-resolves.
- **Startup** (req 16): the plugin's compose fragment owns per-service
  defaults via the existing `x-shipit-preview` vocabulary; the consumer
  overrides per service. No plugin-level boolean exists.
- **Fail-closed grammar**: unknown keys warn; unknown `select` entries and
  `branch`+`pin` together drop the entry with a warning; setting values are
  scalars. Within one repository, a selected export that fails validation
  invalidates that repository's whole generation — degraded beats partial
  (reqs 13, 14).
- **Repo forms**: `owner/name` (GitHub) in v1 — the feedback channel needs a
  brokerable issue backend, which an arbitrary git URL does not have.
  Other hosts are a later extension, declared with an explicit issue
  backend or with feedback disabled.

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
      credentials: [FAL_KEY]        # names only — values live with each project (req 23)
      hosts: [fal.run]              # informational; grants nothing (req 24)
      settings:                     # declared settings + defaults (req 26)
        root:
          description: Directory inside the project the plugin reads and writes
          default: docs
```

The manifest is versioned with the repo, so a refresh (req 12) can change it;
parsing is fail-closed per plugin with the generation rule above (req 13).

**Install contract** (review finding 7): `install` runs with **cwd = the
plugin's checkout root inside its writable layer** — a copy-on-write layer
over the read-only checkout, so `node_modules` and build output land in the
layer, never in the checkout and never in the project (req 7). Writes outside
the layer fail. Install re-runs when its stamped inputs change: the plugin
commit, the install string, or declared install-input files.

## 2. How a plugin is used inside a session

- **Files** (reqs 2, 7): each declared repo is checked out read-only at
  `/plugins/<name>` in the agent container (browsable by the agent), with the
  per-plugin writable layer described above.
- **Workspace handle** (req 21): plugin *services* get the consuming
  project's workspace mounted at the fixed path **`/project`**; plugin *CLIs*
  run in the agent container with **cwd = the project workspace**, which
  keeps cwd-addressed tools (the requirements tool) working unchanged.
- **Shared plugin state** (reqs 17, 18 — review finding 2): each exported
  plugin gets a per-session **state directory**, mounted read-write into its
  service containers and exposed to its CLIs, surviving service restarts,
  refreshes, and container restarts, deleted with the session. This is the
  home of "same live state" between a CLI and a UI that is neither project
  data nor plugin source. Related mechanic for slice 2: a plugin service's
  **published port must stay stable per (session, service)** even if a
  tracked commit edits the fragment's port, because the preview origin is
  port-derived and req 18 guarantees origin stability.
- **Env**: `SHIPIT_PROJECT_DIR`, `SHIPIT_PLUGIN_COMMIT` (req 15 — the commit
  readable by the plugin itself), and `SHIPIT_SETTINGS` — the path to one
  validated JSON file with the plugin's setting values (req 26; a
  per-setting env grammar was reviewed out as collision-prone). CLI wrappers
  use absolute entrypoints, so no plugin-dir variable is needed.
- **CLIs** (reqs 17, 20, 23): exported commands go on the agent's PATH as
  generated wrappers. A wrapper injects the plugin's declared credentials
  into that command's environment only — plugin credentials never enter the
  agent's general environment.
- **Skills** (req 22 — review finding 5): checkout alone discloses nothing —
  ShipIt's skill listing scans only the workspace skill dirs, and Codex
  reading `.claude/skills` is observed harness behavior, not a guarantee
  (docs/209). The design therefore **materializes** each plugin's skills
  into every backend's actual discovery root, namespaced
  (`plugins--<name>--<skill>`), without touching project-tracked paths;
  refresh re-materializes and the agent re-scans on next turn. The docs/209
  verification rule applies to future backends.
- **Refresh** (reqs 12, 15 — review finding 1): refresh is **generation
  activation**, never in-place mutation. Stage the new checkout, validate
  the manifest, run install, prepare services — then atomically activate:
  swap the checkout path, CLI wrappers, `SHIPIT_PLUGIN_COMMIT`, and recreate
  affected services from the same generation. A CLI invoked mid-refresh runs
  the old generation or fails with "refreshing"; any failure keeps the old
  generation whole and active. Agent surface: `shipit plugin refresh
  [name]`, which prints before/after status (a separate `list`/`status`
  command was reviewed out; the UI and `SHIPIT_PLUGIN_COMMIT` cover
  observability).
- **Feedback** (req 25 — review finding 12): the declaration registers
  `name` in the **same tracker registry** the issue shim and Issues UI
  resolve (`GET /api/trackers`) — a separate registry would leave
  `shipit issue create --tracker tools` unresolvable. Filing stays brokered;
  the token stays out of the container.

## 3. UI design

Prototypes: [mockup.html](mockup.html) (A–C). The review's simplification
pass cut the v1 surface to **one authoritative plugin card plus service-row
badges**; the cut list is recorded on planning#355. **Naming note:** the
marketplace skills feature already owns `PluginInfo` and `/api/plugins/*`
(docs/149), so this feature's code namespace is **`PluginRepo*`** and
**`/api/plugin-repos`**; only the `shipit.yaml` key says `plugins:`.

| Surface | Mock | Extends | Change |
|---|---|---|---|
| Service rows: origin badge (reqs 3, 15, 16) | A | `ServiceList.tsx`, `PreviewServicesDrawer.tsx` | Services get a stable runtime ID, display name, and **structured origin** on `ManagedServiceState` and the service WS messages; every path consumes it — the flat list, the single-service focus card, the log drill-in, bulk actions. A small origin chip renders beside `ModeBadge`. No group headers (reviewed out). Health counts stay over service rows only |
| **The plugin card** — the one surface for ref @ exact SHA, needs, grants, refresh, degraded and collision states (reqs 12, 13, 15, 20, 23, 24) | B, C | Chip row in the strip under `PrLifecycleCard` + a card it opens | The strip is PR-conditioned today (`hasPanelContent`, `PrLifecycleCard.tsx:133`) — the parent generalizes to show declared-context chips without a PR. Data: `GET /api/plugin-repos?sessionId` returns one authoritative snapshot (declaration, resolved ref/SHA, exports, needs and their satisfaction, degraded/collision state); WS `plugin_repo_status` carries deltas, has `sessionId`, is stale-session guarded, and the snapshot re-seeds on attach/reload. Grants happen here: "Add key…" deep-links the Secrets tab; "Allow (session)/(instance)" posts to the existing not-container-accessible `POST /api/egress/hosts` with the scope choice. No "commits behind" badge (req 15 wants ref + exact commit, not network polling) |
| Needs — credentials (req 23) | B | `SecretsTab.tsx` / `DeclaredSecretRow.tsx`, fed by `secrets_status` | `secrets_status.declared` gains an **origin** dimension (it is flat, name-keyed today — `service.ts:117`, and `SecretsTab` save assumes unique names). A project credential and a plugin credential with the same name are **deliberately the same stored secret**; multiple claimants render as one row with claimant chips |
| Degraded / collision reporting (reqs 13, 20) | C | The plugin card's own states | Two card states, not transcript cards (reviewed out — no new DB columns, stores, or migrations): **degraded** distinguishes "refresh failed — prior version `<sha>` remains active" (req 15) from "never fetched — session runs without this repo's services" (req 13); **collision** names the colliding domain and the exact `overrides…as:` fix |

Settings → Network egress is **unchanged** (it is explicitly the global-only
editor — `SettingsEgress.tsx:135`); the diagnostics panel addition and the
multi-host `EgressPromptCard` variant were reviewed out of v1.

**How the client learns the declaration** — the `issues.trackers` precedent,
copied: per-request config read behind `GET /api/plugin-repos`, the
`files-changed` handler refetches on `shipit.yaml` edits (with the
`declarationsPending` guard against caching an empty read), and the
`plugin_repo_status` WS message keeps user- and agent-triggered refreshes
coherent in one UI.

## 4. Key files (anticipated)

- `src/server/shared/shipit-config.ts` — both blocks parsed here (consumer
  `plugins:`, plugin `exports.plugins:`), one cross-block name reservation
  pass, fail-closed grammar.
- `src/server/orchestrator/api-routes-plugin-repos.ts` — snapshot +
  refresh endpoints (new); tracker registration folds into the existing
  trackers registry (`api-routes-issues.ts`).
- `src/server/shared/types/ws-server-messages/service.ts` — structured
  `origin` on service messages; `secrets_status` origin dimension; new
  `plugin_repo_status`.
- `src/client/components/ServiceList.tsx`, `PreviewServicesDrawer.tsx`,
  `PrLifecycleCard/` (strip generalization), `SecretsTab.tsx` — the
  extensions in the table above; the plugin card is the one new component.
- `src/server/shipit-docs/` — a new `plugins.md` for the agent-facing
  contract, once slice-2 mechanics are settled.

## 5. Deliberately not in this slice

Slice 2 (see `checklist.md`): checkout/bare-cache mechanics and the writable
layer, generation staging/activation internals, compose-fragment merging and
security validation, port stability per (session, service), credential
injection mechanics, PATH wrapper generation, skills materialization
mechanics, GitHub App multi-repo minting.
