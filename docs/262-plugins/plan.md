---
issue: planning#355
title: Plugin repositories — declaration format & UI design
description: The shipit.yaml formats on both sides of the plugin edge, and the UI surfaces that make plugins visible, grantable, and refreshable.
---

# Plugin repositories — declaration format & UI design

Implements [requirements.md](requirements.md) (26 requirements; cited as
`(req N)`). This design slice covers **how plugins are declared and used**
and **every UI change**, with committed prototypes in [mockup.html](mockup.html).
Server mechanics (checkout mounts, refresh internals, compose merging) are the
next slice — see `checklist.md`.

## 1. The two sides of the edge

A plugin crosses one edge: a **plugin repository** exports it; a **consuming
project** declares it. Each side owns one block in its own `shipit.yaml`.

### 1a. Consumer side — `plugins:` (req 11)

Modeled on `issues.trackers`: a list of named repository declarations,
fail-closed per entry (a malformed entry warns and is dropped; the session
still opens — req 13).

```yaml
plugins:
  - repo: nicolasalt/game-tools   # owner/name, or a full git URL
    name: tools                   # local name: unique, used in paths, UI, references
    branch: main                  # tracked branch (default: repo default branch)
    # pin: v2.1.0                 # tag or SHA; mutually exclusive with branch (req 8)
    select: [requirements]        # optional; default = everything exported (req 5)
    overrides:                    # optional, per exported plugin
      requirements:
        autostart: false          # req 16 override, either direction
        as: reqs-ui               # rename on collision (req 20)
        settings:                 # req 26 — values for plugin-declared settings
          root: docs
```

Rules:
- `name` is unique across **plugin repos AND declared trackers** — the plugin's
  feedback channel (req 25) registers `name` as an issue destination, so the
  two namespaces must not collide.
- `branch`/`pin` are mutually exclusive; neither means the repo's default
  branch, tracked (req 8).
- `overrides` and `settings` are per-project configuration, never copied
  definitions (reqs 5, 16, 26). Secret *values* never appear here — keys go in
  the project's secret store (req 23).

### 1b. Plugin side — `exports.plugins:` (reqs 5, 16, 17, 22, 23, 24, 26)

The plugin repository's own `shipit.yaml` gains an `exports.plugins` map —
one entry per plugin, each owning everything a consumer must never copy:

```yaml
exports:
  plugins:
    requirements:
      description: Numbered requirements database with a review UI
      compose: plugins/requirements/docker-compose.yml  # its service definitions (req 5)
      autostart: true               # default for its services (req 16)
      cli:
        reqs: plugins/requirements/cli                  # command name → entry (req 17)
      skills: plugins/requirements/skills               # dir shipped to sessions (req 22)
      install: npm --prefix plugins/requirements ci     # runs in the writable layer (req 7)
      credentials: [FAL_KEY]        # names only — values live with each project (req 23)
      hosts: [fal.run]              # informational; grants nothing (req 24)
      settings:                     # declared settings + defaults (req 26)
        root:
          description: Directory inside the project the plugin reads and writes
          default: docs
```

The manifest is versioned with the repo, so a refresh (req 12) can change it;
parsing is fail-closed per plugin like the consumer side (req 13).

## 2. How a plugin is used inside a session

- **Files** (req 2, 7): each declared repo is checked out read-only at
  `/plugins/<name>` in the agent container. `install` output and build caches
  go to a per-plugin writable layer, never into the checkout (req 7).
- **Workspace handle** (req 21): plugin *services* get the consuming project's
  workspace mounted at the fixed path **`/project`**; plugin *CLIs* run in the
  agent container with **cwd = the project workspace**, which keeps
  cwd-addressed tools (the requirements tool) working unchanged. Env for both:
  `SHIPIT_PROJECT_DIR`, `SHIPIT_PLUGIN_DIR`, `SHIPIT_PLUGIN_COMMIT` (req 15 —
  the commit is readable by the plugin itself), and one
  `SHIPIT_SETTING_<NAME>` per declared setting (req 26).
- **CLIs** (reqs 17, 20): exported commands go on the agent's PATH under their
  exported names, collision-checked against project and sibling-plugin names.
- **Skills** (req 22): the plugin's `skills` dir is disclosed exactly like the
  repo's own `.claude/skills` — through the cross-agent disclosure mechanism
  (docs/209), so Claude and Codex both see them.
- **Refresh** (req 12): `shipit plugin list | status | refresh [name]` for the
  agent; the UI control below for the user. Refresh re-resolves the ref,
  updates the checkout coherently (req 15), reruns `install` if its inputs
  changed, and reloads affected services and CLIs.
- **Feedback** (req 25): the declaration registers `name` as a brokered issue
  destination — `shipit issue create --tracker tools …` files on the plugin's
  repository; the token stays out of the container like every tracker.

## 3. UI design

Prototypes: [mockup.html](mockup.html) (A–D). Every surface extends an
existing component; none is new chrome. **Naming note:** the marketplace
skills feature already owns `PluginInfo` and `/api/plugins/*` (docs/149), so
this feature's code namespace is **`PluginRepo*`** and **`/api/plugin-repos`**;
only the `shipit.yaml` key says `plugins:`.

| Surface | Mock | Extends | Change |
|---|---|---|---|
| Services panel grouping + origin badge (reqs 3, 15, 16) | A | `ServiceList.tsx` (badge slot beside `ModeBadge`, line ~155), `PreviewServicesDrawer.tsx` | `origin` field on `ManagedServiceState` + `WsServiceList`/`WsServiceStatus`; group header prop on `ServiceList` (it is flat today; the drawer's single-service focus path and `HealthBar` counts must keep working) |
| Plugin chips + card (reqs 12, 15) | B | `ChangedDocsStrip.tsx` — the collapsible strip under `PrLifecycleCard` (the session's "declared context" row) | Per-repo chip `name · ref@sha` with freshness dot; the chip opens mock B's card (status, services/CLIs/skills summary, needs list, Refresh). DTO shape follows `ShipitSourceStatusCard` (`available/ref/shortRef/exact/reason`) |
| Needs — credentials (req 23) | B | `SecretsMissingBanner.tsx` + `SecretsTab.tsx`/`DeclaredSecretRow.tsx`, fed by `secrets_status` | Plugin-declared credential names join the declared-secrets list with a per-plugin-repo grouping; the existing banner and self-clearing save flow are reused untouched |
| Needs — hosts (req 24) | B, D | `EgressPromptCard.tsx` (chat) + `SettingsEgress.tsx` | A multi-host "requested by plugins" variant of the prompt card and a matching section in Settings, both posting to the existing `POST /api/egress/hosts` with the session/instance scope choice. These routes are deliberately not container-accessible, so plugin code cannot self-grant — exactly req 24 |
| Degraded plugin notice (req 13) | C | Chat card, store-backed (pattern: `NonTurnFailureCard`) | Emitted via `emitChatCard`; a later successful refresh flips it to resolved in place. Full persistence checklist applies (CLAUDE.md → `TRANSCRIPT_SCOPED_MESSAGES`, `CARD_MESSAGE_FIELDS`, migrations, guard tests) |
| Collision report (req 20) | C | Chat card, static payload (pattern: `SessionReportCard`) | Historical fact; names the `overrides.<plugin>.as:` fix verbatim |
| Diagnostics | — | `SessionDiagnosticsPanel.tsx` ("Parsed shipit.yaml", line ~212) | Parsed `plugins:` block shown for free debuggability |

**How the client learns the declaration** — the `issues.trackers` precedent,
copied: `GET /api/plugin-repos?sessionId=…` reads the config per request; the
`files-changed` handler refetches when `shipit.yaml` changes (as
`files-changed.ts` already does for trackers, including the
`declarationsPending` guard against caching an empty read); a WS
`plugin_repo_status` message carries live resolution state (resolved
ref/commit, refreshing, failed) for the chips and cards.

## 4. Key files (anticipated)

- `src/server/shared/shipit-config.ts` — both blocks parsed here (consumer
  `plugins:`, plugin `exports.plugins:`), fail-closed per entry.
- `src/server/orchestrator/api-routes-plugin-repos.ts` — declaration read +
  refresh endpoint (new).
- `src/server/shared/types/ws-server-messages/service.ts` — `origin` on
  service messages; new `plugin_repo_status`.
- `src/client/components/ServiceList.tsx`, `PreviewServicesDrawer.tsx`,
  `ChangedDocsStrip.tsx`, `SecretsTab.tsx`, `SettingsEgress.tsx`,
  `EgressPromptCard.tsx` — the extensions in the table above.
- `src/server/shipit-docs/` — a new `plugins.md` for the agent-facing
  contract, once mechanics are settled.

## 5. Deliberately not in this slice

Checkout/mount mechanics (bare-cache reuse per docs/192, writable install
layer), compose merging and validation of plugin fragments, refresh
implementation, credential injection, and the PATH mechanism. They are listed
in `checklist.md` and cite the same requirements; nothing in this slice
constrains them beyond the contracts above.
