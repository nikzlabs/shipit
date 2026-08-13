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
  editing the declaration re-resolves. **The record is orchestrator-wide and
  keyed by the consuming *project*** (`plugin-pins.ts`), not per session —
  a per-session store would let two sessions of one project resolve the same
  moved tag to different commits, which is the drift this requirement
  forbids. A recorded pin is honored *without* re-resolving, so a tag later
  deleted or made ambiguous still activates the pinned commit.
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
layer, never in the checkout and never in the project (req 7). **Withdrawn (2026-08-13):** an earlier revision claimed that layer IS the
generation directory, because a per-session, per-commit checkout already
confines build output — so a copy-on-write layer "buys nothing". It buys req 7,
whose plain words put install output somewhere that is neither plugin source
nor project data. The checkout stays pristine; the CoW layer is real.

**Where install runs is a security boundary, not a detail** (implementation
review). Two attempts were rejected before the answer settled.

It must NOT run in the **orchestrator**: that process holds ShipIt's own
credentials (the PAT in the global git config) and has unrestricted host
access, so executing a repo-authored `install` string there is strictly more
privileged than `agent.install`.

It must also NOT run in the **agent container**, which was the second attempt
and is the one that shipped as a blocked PR. The reasoning that it inherits
"the authority `agent.install` already has" was true and beside the point:
`agent.install` is the project's OWN command, while a plugin's install string
comes from a third-party repository. In that container it can read
`/credentials`, inherit provider and project secrets from the worker's
environment, and — the finding that decided it — call the worker's
**loopback** credential broker (`/agent-ops/*`, which requires no worker
token) to obtain a real GitHub token. Scrubbing the environment does not close
that: the route is listening either way.

So install runs in **its own throwaway container** (user decision, 2026-08-13),
holding only what it needs: the staging checkout read-only, its copy-on-write
upper layer read-write, and nothing else — no `/credentials` mount, no worker
URL, no orchestrator callback env, no session network. Reqs 7 and 19 then hold
**by construction** rather than by convention, which is what this document
already claimed before anything enforced it. Generation activation itself still
runs no plugin-authored code in-process.

**Install runs BEFORE publish.** Stage → validate the manifest → run install in
its own container → *then* atomically activate. The blocked attempt inverted
this: it published, pruned the prior generation, and only then installed
fire-and-forget, discarding the result — so a failed install left a broken
commit reported as `active` with nothing to fall back to. With the correct
order a failed install is just a failed activation: the prior generation stays
whole and live, and the card degrades visibly (req 13). Install runs with the generation's env — `SHIPIT_PLUGIN_COMMIT`
set for a consumer generation, unset under `repo: self` (set by the fixture:
its install stamp records the commit, and the probe checks the stamp against
the active generation). Install re-runs when its stamped inputs change: the
plugin commit, the install string, or the content of the manifest's
`install-inputs` files (the same convention `agent.install` already uses).

**What the container actually gets** (implemented — `plugin-install.ts`): the
generation's overlay volume at `/plugin` as its ONLY mount, `cwd` there, the
session-worker image for its toolchain with its ENTRYPOINT bypassed (that
script prepares session mounts this container does not have), an environment
of exactly `SHIPIT_PLUGIN_COMMIT` + `HOME=/tmp`, all capabilities dropped,
`no-new-privileges`, a memory and PID ceiling, and a timeout.

**And its own network — which is a security control, not tidiness** (review
finding, this round). "Not the session's network" is not enough. Install needs
outbound access (`npm ci` fetches), outbound includes the host gateway, and
ShipIt's own API is published there. `api-container-guard.ts` identifies a
container by its source IP and reads *anything it does not recognise* as a
browser or host caller — so an install container on the default bridge would
have had MORE API reach than the agent container it was isolated from: list
sessions, then ask `/api/sessions/<id>/git/credential`, which returns a real
GitHub token. The fix is a dedicated network whose whole subnet is declared
untrusted to that guard, and the subnet is registered when the network is
created rather than per container after it starts — otherwise the first
request, which is the one worth making, arrives before the registration. It
fails closed: no registerable subnet, no install.

The general question of what plugin code may reach *outbound* — the manifest's
`hosts:` as an enforced allowlist rather than an informational one — is req
24's open decision, and it now covers this container as well as plugin
services. What is settled is that ShipIt's own API is not reachable from it. It runs as the session-worker UID — which is why the staging checkout
is handed to that UID first: overlayfs takes the merged directory's
permissions from the LOWER dir, so a root-owned checkout would leave the
plugin root unwritable and every install would fail at its first file. That
handoff is also what covers a generation staged *after* the session container
booted, which the entrypoint's boot-time chown cannot reach.

**A runtime with no install runner activates, and says so.** Local/dogfood mode
has no Docker, so nothing can run a plugin's install there. The generation is
published anyway — that runtime has to be able to exercise a plugin at all —
but a selected export with an `install:` it never ran makes the generation
partial, so the card carries "active but was not installed" rather than a plain
`active`. Req 13's rule is "degrade visibly", not "refuse" (review finding, this
round: this path silently reported a partial generation as fully active).

For a consumer generation the commit determines every input, so the stamp is
not what decides a re-install — a new commit is a new generation and a new
layer. It exists for the case that is not a new commit: an install that
succeeded and then had its *publish* fail leaves a populated layer behind, and
the next attempt re-stages the same commit. The stamp turns that into a no-op
instead of a repeat.

## 2. How a plugin is used inside a session

- **Files** (reqs 2, 7): each declared repo is checked out read-only at
  `/plugins/<repo-name>` in the agent container (browsable by the agent),
  with the per-repo writable layer described above.

  **Mount the store, not the generation.** The obvious shape (bind
  `<state>/plugins/<name>/active` at `/plugins/<name>:ro`) is wrong for one
  reason: Docker resolves a bind source's symlinks at container-creation time,
  so the mount would pin the generation that was live when the session opened
  and a refresh (req 12) could never reach the agent without recreating its
  container. Instead the session's whole plugin root is mounted **read-only**
  at `/plugin-store` and the container makes `/plugins/<name>` a symlink to
  `/plugin-store/<name>/active`. Both hops resolve *inside* the container on
  every access, so swapping the `active` symlink on the host is visible
  immediately — which is what refresh needs.

  **The agent container gets no writable view of a checkout, at any path**
  (req 7). A first attempt mounted the same root a second time read-write so
  the in-container install could write `node_modules`, and argued req 7 down to
  a workflow guarantee to fit. That reinterpretation is **withdrawn**
  (requirements.md, resolved 2026-08-13): a writable alias of a read-only
  surface is not read-only, and the requirement is not the design's to narrow.
  Install writes into a copy-on-write upper layer belonging to a different
  container — see §1b.

  **The merged view lives in a Docker volume, not on the host** (resolved
  2026-08-13 by consultation, against the code). Req 7 keeps the checkout
  pristine, so a plugin's own code needs checkout + install output merged. That
  merged tree is NOT constructible where the `active` symlink could point at
  it: a host-side overlayfs mount needs `CAP_SYS_ADMIN`, which the orchestrator
  does not have (`docker/local/prod/compose.yml`), and docs/183 rejected the
  privileged variant on containment grounds. What docs/183 *does* build is the
  piece that works here — a `local` driver volume with `type=overlay`
  (`overlay-volume.ts`), where the DAEMON performs the mount when a container
  attaches it, and which several containers can share coherently
  (`docs/183-overlay-dep-store/FINDINGS.md`). Note the orchestrator's own view
  of that volume is upper/storage, never the merged tree.

  So, per generation: lowerdir = the pristine checkout, upper/work = per-
  generation runtime storage, and ONE named overlay volume shared by the
  installer, the services, and the CLI-invocation containers. Per generation,
  never per repository — a volume's driver options are fixed while consumers
  hold it, and one upperdir must not back two independently created mounts.

  The agent container keeps seeing only pristine source through
  `/plugins/<name>`. That is the whole reason it stays browsable and
  refresh-follows-instantly, and it is enough: nothing the agent itself runs
  needs the merged tree.
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

  **Implemented** (`plugin-state.ts`), as
  `<sessionDir>/plugin-data/<alias>/state/`. The container-side names both
  consumers will use — the mount point and the two env vars — are fixed once in
  `shared/plugin-contract.ts`, so the compose slice and the CLI slice cannot
  drift apart on them; the mounts themselves are those slices' work.

  **Not under the session state dir, and that is the whole placement decision.**
  Everything else this feature writes lives in `<sessionDir>/state/` (docs/246),
  and putting this there would have been the obvious symmetry — but that whole
  subtree is in `REGENERABLE_SESSION_SUBDIRS` (`disk-utils.ts`), which archive
  and disk-tier eviction delete *because* everything in it can be rebuilt. Plugin
  state cannot be rebuilt, and req 18 lets only a session reset or delete take
  it. So it sits where the other durable, non-git session data sits — a sibling
  of `workspace/`, the `uploads/` convention — which the reclaim allowlist
  deliberately leaves alone and a full reset still removes. It is equally not
  under `<state>/plugins/`: that root is the read-only store mount, and
  generation pruning owns everything beneath it.

  **Keyed by alias, prepared on every round.** Two `use:` entries of one plugin
  are two imports and get two directories. Preparation hangs off the END of an
  activation round (`plugin-activation.ts`), including a round that fetched
  nothing — a `repo: self` project activates no generation and would otherwise
  never get its primitives at all. A dropped `use:` entry KEEPS its state
  directory: undeclaring an import is neither of the two things req 18 allows to
  discard state, so re-adding it finds what was there.
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

  **The settings file is implemented** (`plugin-state.ts`), one flat JSON object
  per import at `<sessionDir>/plugin-data/<alias>/settings.json` — **beside** the
  state directory, never inside it: that directory is plugin-writable, and a
  plugin that can rewrite its own validated settings has settings that were
  never validated. It is written atomically (a service may be reading it while a
  refresh rewrites it) and re-resolved on every round against the LIVE
  generation's manifest, which is how a refresh that changes a default reaches
  the plugin. **Unchanged content is not rewritten** — a mechanic the compose
  slice depends on: an atomic write gives the file a new inode, a Docker *file*
  bind mount follows the inode it was created with, and a round runs on every
  session activation and every `shipit.yaml` edit. Skipping the no-op write means
  the inode changes only when the settings did, which is also when that slice
  recreates the service.

  **Validation is fail-closed, and a failure writes nothing.** The plugin's
  declared defaults apply where the project sets nothing; a declared setting with
  neither is omitted rather than emitted as null (the manifest has no "required"
  concept). Two things are errors rather than silent degradations — a value for a
  name the plugin does not declare, and a value whose type disagrees with the
  declared default (the only type information a manifest carries). Both are
  invisible from inside the plugin, which would simply see its default; and req
  26's own example setting is *the directory a plugin writes the project's
  durable output into*, so getting it silently wrong writes real files to the
  wrong place. On an error the import gets NO settings file — including the
  removal of a now-stale one — and the failure appears as an issue on that
  repository's card (`settingsIssues`). The card's issues are **recomputed** by
  the snapshot GET from the same pure resolver rather than remembered from the
  last round, so a declaration that cannot work says so before anything has run,
  and the GET still activates nothing.

  Four things the independent review had to force, each confirmed at the source
  and each a way for this to be quietly wrong. **The settlement re-reads the
  declaration** rather than using the one its round started with: a round holds
  its config for as long as its slowest fetch, so an edit landing in that window
  could be written by the round it triggered and then *reverted* by the older
  round finishing over it. Settings are derived config, so the current file is
  always the right answer and the last settlement converges instead of
  resurrecting a superseded declaration. **A failed write is fail-closed and
  remembered**: it removes the file it could not replace (otherwise the plugin
  keeps reading the previous declaration's values — the exact silent wrong-place
  write this validation exists to stop) and, since nothing can recompute "the
  write did not happen", the failure is kept per session beside the activation
  state and merged into the card. **Issues are grouped in a `Map`, not an
  object**: `constructor` and `toString` are valid declared repository names, and
  on a plain object every one of them reads back as an inherited function for a
  repository with no issues at all — truthy, and fatal at the first spread, which
  turned a valid declaration into "shipit.yaml could not be parsed". **And a
  number JSON cannot carry is an error**: YAML's `.nan`, `.inf` and an
  overflowing literal all pass the scalar and type checks and then serialize as
  `null`, so the plugin would receive neither its declared value nor a number.
- **CLIs** (reqs 17, 20, 23): exported commands go on the agent's PATH as
  generated wrappers. **The wrapper is ShipIt's, and it is all that runs in the
  agent container**; it brokers an invocation container that mounts the
  generation's overlay volume, `/project`, the plugin's state dir, and only the
  plugin's declared credentials. Plugin credentials never enter the agent's
  general environment, and plugin code never runs beside the loopback
  credential broker — the same boundary as `install` (§1b), for the same
  reason.

  This corrects an earlier version of this bullet, which had the command itself
  running in the agent container while §"Fetch authority" simultaneously said
  plugin code must not run there. Req 17 only promises the agent can invoke the
  command *inside the project session*; it says nothing about sharing the
  agent's container, so a transparent wrapper keeps the promised UX. Per-call
  container start costs latency; a credential-blind persistent runner is a
  later optimisation, and `docker exec` into the agent or a service container
  is not an acceptable shortcut — it re-opens the boundary.
- **Skills** (req 22 — review finding 5) — **implemented**
  (`session/plugin-skills.ts`): checkout alone discloses nothing — ShipIt's
  skill listing scans only the workspace skill dirs, and Codex reading
  `.claude/skills` is observed harness behavior, not a guarantee (docs/209).
  Each imported plugin's skills are therefore **materialized** into every
  backend's actual discovery root, namespaced (`plugins--<alias>--<skill>`),
  without touching project-tracked paths; refresh re-materializes and the agent
  re-scans on next turn. The docs/209 verification rule applies to future
  backends.

  Details the implementation settled, most of them after two independent review
  rounds found them. **Every** harness root gets a copy,
  not just the running session's: req 22's "never tied to one backend" is the
  requirement's own wording, and `skillsDirName` additionally drives ShipIt's
  skill picker, so a Codex session with the copy only under `.claude` would
  work in the CLI and be missing from the picker. **The frontmatter `name:` is
  rewritten** to the namespaced directory name — the scanner takes the
  invocable name from the frontmatter and only falls back to the directory, so
  namespacing the directory alone leaves two plugins' `probe` skills both
  called `probe`. And **"projects never keep copies" is enforced by
  `.git/info/exclude`**, the per-clone non-tracked ignore list docs/198 already
  uses for pnpm's relocated store — a project's own `.gitignore` is a tracked
  file ShipIt does not own, so editing it would be the very "copy kept in sync"
  the requirement forbids. Copies (not symlinks) follow the marketplace
  installer: kilobytes of markdown, no dangling-link failure mode, and
  re-copying is what makes a refresh take effect.

  **Containment is checked with `realpath`, on both sides, before anything is
  written.** The manifest's own validation is lexical — it rejects `..` and
  absolute paths in the declared `skills:` value and says nothing about what any
  *component* of that path is, nor about what a link inside the checkout points
  at. So a dereferencing copy let a plugin ship `skills/x/assets ->
  /credentials`, and `skills: pkg/skills` with `pkg` a symlink out of the
  checkout read somebody else's files entirely — the per-entry copy filter never
  saw it, because it only inspects what it is handed. The destination has the
  mirror problem: a project-owned `.claude -> /outside` put every copy beyond
  the exclude, and checking only the final path component missed it because the
  directory was created before the check ran. Both sides now resolve fully — the
  destination against its deepest existing ancestor — before any `mkdir`.

  **Published by rename — which is complete, not atomic.** Prepare runs while a
  turn may be reading these files, so deleting the live directory and copying
  into its final path exposes half a tree, and a copy that failed after the
  delete left an unmarked partial that the ownership check would then refuse to
  replace, wedging that skill permanently. Staging plus rename fixes both. It
  does NOT make publication indivisible: `rename(2)` refuses a non-empty
  destination, so the old copy is removed first and a reader in that gap sees no
  skill rather than half of one. Absent-then-whole is the failure mode worth
  having, and calling it "atomic" was an overclaim the second review caught. The
  staging directories are themselves excluded from git and swept on the next
  pass, since a killed process cannot run its own cleanup.

  **The marker's content is checked, not its name.** A file called
  `.shipit-plugin-skill.json` is something a handwritten skill could plausibly
  contain, and this module deletes what it owns recursively.

  **Duplicate names are rejected; the hash only narrows the odds.** The readable
  rendering collapses punctuation, so the aliases `foo_bar` and `foo-bar` — both
  valid, both distinct to the parser's uniqueness check — render identically,
  and the second copy silently deleted the first. A hash of the exact pair was
  the first fix and was not enough: the second review produced a real collision
  at 6 hex digits from under ten thousand crafted candidates (`a-._--_-.b` and
  `a...-.---b`, reproduced here before being fixed). The width is 12 digits now,
  but the guarantee is that a plan REFUSES a name already claimed — a hash width
  is a defence, not a proof.

  **The git exclude names the exact directories**, written from the plan before
  any of them exists. A `plugins--*` wildcard would also hide whatever the user
  happens to name that way, and would swallow a marketplace plugin called
  `plugins--acme` (installed as `plugins--acme__<skill>`), whose own
  path-scoped `git add` then fails as an ignored path. Two limits are inherent
  rather than fixed: an ignore rule does not apply to an already-tracked path
  (an unmarked directory there is refused as foreign, so the copy never
  happens), and `git add -f` / `git clean -x` / `git stash --all` override any
  ignore, as they do for `.gitignore`.

  **The block is rewritten in a fixed order, and never widens what it hides.**
  Sweep stale directories FIRST, then narrow the block, then write — dropping an
  exclusion while the directory it covers still exists opens a window where a
  concurrent `git add -A` stages it. The rewrite runs on every pass including
  the empty one, or a dropped declaration leaves its exclusions installed
  forever, later hiding a directory the user creates with the same name. And an
  orphaned BEGIN marker (from an interrupted write) must not let the next
  rewrite treat everything up to its own END as managed: that deletes the user's
  own ignore rules in between, which is how someone loses a rule that was
  keeping a secret out of a commit.

  **The container's prepare result travels back to the card** (req 13 —
  implemented: `services/plugin-activation.ts`,
  `container-session-runner.ts`). Prepare has two halves that fail
  independently: the orchestrator writes each import's state directory and
  settings file, and the container links `/plugins/<name>` and materializes the
  skills. Only the first half was ever visible. The second ended at a
  `console.warn` in `preparePlugins()`, so a plugin that shipped none of the
  agent instructions it promised still rendered as a healthy card — and a
  degradation the user cannot see is not the "clearly reports … and why" req 13
  asks for. The channel already existed (`prepareFailures`, keyed by session and
  repository, merged into the snapshot by the route); what was missing was the
  result travelling into it. Four decisions the implementation settled:

  - **The worker returns an attributed failure list, not a boolean.** Every
    source, plan entry and failure now carries the DECLARED repository name in
    the declaration's own spelling — `from:` matches case-insensitively, so the
    `use` entry's spelling is not the card's key. It also carries a readable
    `<alias>/<skill>` label beside the namespaced directory name: the hashed
    directory is the right identifier on disk and the wrong one on a card. The
    single "could not keep them out of git" failure is attributed to each
    repository that had skills planned and to no other — one exclude file, but
    the consequence belongs per repository, and a repository shipping no skills
    must not grow an issue about a mechanism it does not use.

    **`linkPlugin` reports too, and two more silent shortfalls are now
    failures** (review findings). The link step returned a bare `false` nobody
    read, so a repository whose `/plugins/<name>` refused to be created — a real
    file already sitting there — rendered as a perfectly healthy card with none
    of the repository behind it. And a declared `skills:` directory that EXISTS
    but holds nothing readable was a clean pass: the plugin promises agent
    instructions and ships none, which is the same shortfall as declaring a
    directory that is not there. A declared repository with no live generation
    is deliberately NOT among these: the card already renders that as
    `unavailable` from the generation state, and repeating it here would state
    one ordinary fact twice, as an error.
  - **The response is validated, not cast** (review finding). Containers survive
    an orchestrator restart and are reconnected, so a rolling upgrade puts a new
    orchestrator in front of a worker built before failures carried a `repo`.
    Casting stored those under `sessionId::undefined` — a key no card looks up,
    and one that displaced whatever the previous run had recorded. Unattributable
    entries are dropped with a log line instead, which leaves an old worker
    exactly as silent as it was before this change: it is not reporting less
    than it knows, it never knew.
  - **The two halves are recorded in separate maps and concatenated on read.**
    They are written by different processes at different moments, and each
    replaces only its own entries; merging them into one map would let a clean
    container prepare erase a settings-write failure recorded microseconds
    earlier. The snapshot route is unchanged — it asks "what could this
    repository not be given?", and which process failed to give it is a detail
    of the answer, not part of the question.
  - **Only a prepare that actually RAN may write the record, and it replaces the
    session's whole set.** Wholesale replacement is what makes a fixed problem
    disappear, and it is safe because the container pass is always
    whole-declaration even when the round that triggered it was narrowed to one
    repository (`shipit plugin refresh <name>`). The corollary is the
    unreachable case: a prepare that could not run leaves the previous record
    alone rather than clearing it, because nothing reached the container's
    filesystem — the last successful pass is still the truth about what is
    materialized there, and clearing it would report health nobody observed.
    Inventing a failure instead would attach a transport error to every plugin
    card. A stale record therefore cannot outlive its session: the epoch is
    captured before the request (so a result arriving after disposal writes
    nothing, exactly as the activation state map does), `clearActivationState`
    drops it on disposal, and a container RESTART re-runs prepare through
    `setWorkerUrl` and overwrites it.
  - **The result pushes a `plugin_repos_updated` only when the recorded set
    moved.** The settled hook emits that message and *then* fires the container
    prepare, so the browser's refetch predates the answer and a first push
    cannot carry it. An unconditional second push would double the tab's
    refetches to say nothing, since prepare runs on every activation round and
    every container start and the healthy case dominates.

  **Four limits, stated rather than closed.** Each was confirmed at the source;
  each fix costs more than the gap does.

  - **`shipit plugin refresh` returns before the container prepare its round
    triggered has finished**, so its printed rows never carry container-side
    failures — the card catches up seconds later on the push above. Awaiting it
    would make a deliberately fire-and-forget hook blocking. This keeps both
    halves symmetric: prepare failures of either half report on the card,
    neither in the refresh row.
  - **A cleanup failure for a repository the declaration no longer names has
    nowhere to render.** A stale `/plugins/<name>` link or a materialized skill
    that could not be swept stays logged only, because the snapshot iterates the
    CURRENT declaration and the dropped repository has no card. Surfacing it
    needs a tombstone or a session-level warning — a surface, not a field — and
    that is its own piece of work rather than a line in this one.
  - **Runner disposal clears the record while the container's filesystem may
    outlive it.** `clearActivationState` fires on every runner `disposed` event,
    and an idle-disposed container is later reconnected without a fresh
    `setWorkerUrl`. The record is restored by the activation round that runs
    when the session is next set up, so the window is "disposed, not yet
    reactivated" — during which nothing is reading the tab. The orchestrator
    half has had exactly this lifetime since it was written; making the
    container half durable alone would make the two disagree.
  - **A timeout is ambiguous, and is treated as "did not run".** The 30-second
    deadline destroys the orchestrator's request socket; it does not cancel the
    worker, which may finish the pass afterwards. So the preserved record can be
    stale in either direction until the next prepare — which runs on every
    activation round and every container start. Resolving it properly needs a
    queryable prepare revision on the worker, which is more protocol than a
    30-second copy of markdown warrants.

  A fifth was considered and deliberately left alone: **overlapping prepares are
  not ordered.** Two triggers each capture the same epoch, and whichever
  response lands last wins. The worker serializes its own work and queues one
  follow-up, so responses normally return in work order; an orchestrator-side
  invocation counter would narrow the window without reflecting actual worker
  execution order, which is mechanism that reads like a guarantee and is not.
  The correct fix is a worker-issued revision, and the bug it would fix is a
  card that is wrong until the next prepare.
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

  **Implemented** (`services/plugin-refresh.ts`, `agent-shim/shipit-plugin.ts`).
  Refresh is the SAME round a `shipit.yaml` edit runs — the deps are built by
  one factory in `bootstrap-managers`, so the fire-and-forget trigger and the
  awaited verb cannot drift into two fetch or install policies. What refresh
  adds is that it awaits the round and reports before/after. Three details the
  implementation settled: it narrows to ONE declared repository when the agent
  names one (re-fetching the others would be a surprise, and a slow one);
  before/after are read from disk on both sides rather than inferred from the
  activation outcome, because the live commit is a fact about the filesystem;
  and a `repo: self` name is refused with its own message, since it IS the
  working tree and "nothing happened" would read as success. The call uses the
  UNBOUNDED transport — a refresh can fetch, check out, and run that plugin's
  install, so a default deadline would abort work that is still running.

  Three more the review had to force, each of which made the verb quietly
  wrong. **It passes the settled hook**, which is not decoration: that hook also
  calls the container's `preparePlugins()`, so without it a refresh swapped the
  generation on disk, printed `activated`, and left the session looking at the
  old one — the refresh never reached the agent, which is the entire point.
  **It is below the trust gate** (docs/178): automatic activation sits under
  `repoStore.isTrusted()` because fetching a plugin repository and running its
  install is repo-declared auto-execution, and a verb the agent can invoke must
  not be the way around that. And **the report comes from this round's own
  returned outcome**, not the shared activation-state map — that map belongs to
  the UI and is owned by whichever round finishes last, so with a second
  trigger queued a refresh whose install had just failed read back as
  `unchanged` and exited zero.
- **Fetch authority and the standing grant** (req 19): repository fetches
  run **orchestrator-side** (the bare cache), so fetch credentials are never
  *stored* inside the session container.

  **That is not sufficient on its own, and this document asserted for two
  slices that it was.** A credential does not have to be stored somewhere to
  be obtainable there: the worker's loopback broker (`/agent-ops/*`, no worker
  token required) hands a live GitHub token to any local caller, so "never
  written into the container" and "unreachable from inside the container" are
  different claims. Only the second one is req 19. It holds for plugin code
  because plugin code does not run in that container at all — `install` gets
  its own container with no worker URL and no session network (§1b), and CLIs
  and services inherit the same rule when they land. A guard test owns the
  boundary and must exercise the broker path specifically, not just the
  environment. The standing grant means activation never prompts: a new
  tracked-branch commit stages, validates, and activates with no approval
  step, and the visible repo/ref/commit identity on the plugin card — in
  every state, including degraded and collision — is the accountability
  surface that replaces approval.
- **Which credential the fetch uses** (reqs 7, 10, 13) — **implemented**
  (`plugin-fetch.ts`, the credential half of `repo-git.ts`). Orchestrator-side
  says *where* the fetch runs; req 10 asks *what it authenticates with*, and the
  two are not the same question.

  **The host PAT is not the answer, because a plugin repository is a different
  repository from the project.** Every other orchestrator-side git operation
  rides one credential — the global helper `git-config.ts` installs, which
  echoes the PAT for whatever repository git is touching. Under GitHub App mode
  a token is minted per *installation*, so the token that clones the project
  neither covers nor names the plugin repository, and on an App-only install
  that global helper is not configured at all. Left there, a private plugin
  repository fails with a bare `fatal: Authentication failed` and the user is
  told nothing about which repository, or which of their two GitHub setups, is
  the problem.

  So the fetch resolves its own credential, for the plugin repository's own
  `owner/repo`, in this order: a **read-only App installation token**; else the
  **host PAT**; else **none**, which is not an error — a public plugin
  repository must be fetchable by a ShipIt with no GitHub identity, and refusing
  to try would break that. The PAT fallback under a configured App is the same
  availability-over-tightness policy `getRepoScopedGitCredential` already
  applies to the session's own repository.

  **Read-only is req 7 made structural.** The token carries `contents: read` and
  nothing else — not the `contents: write` and `pull_requests: write` the
  session's own repository gets — so "a declaration grants a fetch, never a
  push" is a property of the credential rather than of nobody having called
  `git push`. The minter caches per (repository, scope), because serving a write
  token where a read token was asked for would quietly give that back.

  **Three properties of how the token reaches git**, each of which has a way to
  be silently wrong: the inherited helper list is **reset** first (`credential.
  helper` is multi-valued and git consults helpers in config order, so without
  the reset the global PAT helper answers first and the App token is never
  reached); the replacement is **origin-scoped**, so a redirect elsewhere gets
  no answer at all — the host-blind-helper bug class of docs/172 Gap 2; and the
  token travels in the child process's **environment**, never in argv or in a
  `https://user:token@host` remote, so it reaches neither `ps` nor the bare
  cache's on-disk config. `repo-git.test.ts` drives real git for all three,
  because each one is a git behavior rather than a claim about our code — a
  decoy global helper for the reset, and a loopback server that demands Basic
  auth for what git actually sent.

  Two more the independent review had to force, both of which made this quietly
  wrong. **"No credential" is a credential decision, not the absence of one**:
  the anonymous fetch still resets the helpers and still disables prompts, or a
  stale global helper answers for a repository ShipIt holds nothing for, and a
  private repository stalls on a prompt instead of producing req 13's named
  failure. And **the environment is sanitized, not forwarded whole**: simple-git
  refuses to spawn when any of ~18 variables is set (`PAGER`, `GIT_ASKPASS`,
  `GIT_SSH_COMMAND`, `GIT_CONFIG_COUNT`, …), each a way to make git run someone
  else's code — so a plain `PAGER=cat` in the orchestrator's environment failed
  **every** credentialed plugin fetch before git ran. They are dropped rather
  than allowed; the two kept (`GIT_CONFIG_GLOBAL`, `GIT_EDITOR`) are the ones
  this orchestrator sets on purpose. Dropping `GIT_CONFIG_COUNT` also closes the
  one config layer that outranks the reset.

  Req 19 is unaffected and slightly stronger: the credential is resolved, used
  and dropped inside one `ensureCache` call. Everything the generation engine
  does after the fetch is local (`rev-parse`, `clone --local`), so no plugin
  path has a network credential to reach in the first place.

  **A refused fetch is named** (req 13): the message says the repository, which
  of the two setups was tried, and the one-time act that fixes it, plus the
  sentence the mode difference exists for — that authorizing the project does
  not cover the plugin repository. It reaches the Plugins card as that
  repository's activation error. A failure that is *not* credential-shaped (DNS,
  a truncated transfer) is passed through untouched: a GitHub outage reported as
  a permissions problem would send the user to fix something that is not broken.

  Naming it accurately is narrower than it looks, and the review caught both
  ways of overclaiming. GitHub answers **404 for "the App is not installed
  here" and for "no such repository" alike** — it will not confirm a repository
  the caller cannot see — so the message says both rather than sending someone
  to install an App when they mistyped a name. And the token remedy names
  **both PAT kinds** (a classic token's `repo` scope, a fine-grained token's
  selected repositories plus Contents read), since this repo supports both and
  half the users would otherwise be pointed at the wrong setting.

  **Known limit, deliberately not fixed here.** Under an App-only install the
  orchestrator's own fetches of the *project* repository still ride the global
  helper and so have no credential either (App minting today feeds only the
  in-container credential broker, `api-routes-github.ts`). That is pre-existing
  and outside this feature; the mechanism this slice adds — a per-remote
  credential on `RepoGit` — is what a fix would be built from.
- **Feedback** (req 25 — review finding 12) — **implemented**
  (`shared/plugin-feedback.ts`, `trackers/registry.ts`,
  `services/issues.ts`): each declared repo registers its `name` in the **same
  tracker registry** the issue shim and Issues UI resolve — a separate registry
  would leave `shipit issue create --tracker game-tools` unresolvable, and a
  second issue path beside `shipit issue` would be a second thing to keep
  brokered. One destination per repository, however many plugins are used from
  it: feedback is about the repository that would have to fix it. Filing stays
  brokered; the token stays out of the container.

  **How the destination is named, and how it is distinguished** (the decision
  this slice owed):

  - **Named by the `repos:` entry's `name`** — no new syntax, and no per-plugin
    destination. That name is already reserved across the tracker namespace in
    phase 1, which is what makes `--tracker game-tools` unambiguous by
    construction rather than by a second uniqueness rule.
  - **Distinguished by `origin: "plugin"` on the destination, not by a
    narrower capability.** The registry entry is **unlisted**: a plugin
    repository is a dependency, not where the project's work is tracked, so it
    mints no Issues tab and an unqualified `list` never means it. Everything
    else — adapter, brokering, token boundary, reference forms — is identical to
    a declared tracker. A project that genuinely wants the tab declares the
    repository in `issues.trackers` as well; both names then resolve to the one
    destination.
  - **Rejected: a create-only capability** on plugin destinations. It reads
    safer and is not: undo of a create closes the issue it just filed, so a
    create-only destination ships a card whose Undo fails, and it removes the
    list/view a report needs to avoid duplicating one. It also buys no
    authority: whoever can add a `plugins.repos` entry can add an
    `issues.trackers` entry to the same file, so the restriction filters
    accidents, not privilege — and it filters them by breaking a working
    button. The agent-facing docs say what the channel is for instead.
  - **A repository declared BOTH ways stays ONE destination**, with the plugin
    name carried as an alias (`pluginNames`). This is not tidiness: two *named*
    destinations sharing one `owner/repo` make the canonical form
    `owner/repo#42` **ambiguous** (`resolveParsedIssueRef` fails closed on
    exactly that), so registering a second one would break a tracker that was
    already working. Matched case-insensitively, since a tracker id preserves
    the casing its declaration was written in.
  - **In that one case the NAME used is the intent, and it survives
    resolution** (review finding). One destination, two declared names:
    `--tracker tools` is feedback on the plugin, `--tracker planning` is an
    issue on the project's own tracker, and every plugin-specific behavior —
    the context footer, the `Closes` guard below — keys on the name rather than
    on the destination. Resolution therefore reports the name that *matched*
    (`matchedDestinationName`), where docs/248 otherwise normalizes to the
    destination's primary name; collapsing it there silently dropped req 25's
    own case, and left an Undo's re-point check unable to see the name its card
    recorded (`destinationForName` now matches aliases too).
  - **`repo: self` registers nothing** — its issues are already this session's
    own repository, which every session reaches without a declaration
    (docs/248 req 12).

  **The report carries the session's context, stamped server-side.** A create
  addressed at a plugin destination gets a footer with the repository's declared
  ref and the **exact commit the session is running** (req 15), read from the
  live generation record. The agent cannot obtain that commit itself — the
  checkout it browses is a staged export with no `HEAD` — and asking it to
  remember would make req 25's "can carry the running commit" a convention. The
  repro and the proposed diff stay the author's: they are the body, and this is
  a footer under it. The footer follows the name the create was addressed
  through, so an ordinary issue filed on a project tracker never grows plugin
  context, and a report addressed at the plugin name always does.

  Two limits, both stated rather than papered over:

  - **The generation store is keyed by declaration name, not by repository**
    (`GenerationRecord` carries `repoName`, no `owner/repo`), so while a
    re-pointed `repos:` entry's new generation is still activating — or has
    failed — the live generation belongs to the *previous* repository, and its
    commit is what the footer would carry. The Plugins tab has the same gap for
    the same reason (its card pairs the new source with the old commit), so the
    fix belongs to the generation record, not here: record the source
    repository in it and ignore a generation whose repository no longer matches
    the declaration.
  - **A replayed create is deduped on the body as the caller wrote it**
    (`handleWrite`'s key hashes the request, not the stamped result), so an
    identical report filed twice inside the 10-minute window is collapsed even
    if the plugin refreshed between the two. That is the wanted behavior:
    the window exists to stop a crash-retry filing the same issue twice on
    someone else's tracker, and a duplicate report is worse than a report whose
    footer names the commit that was live when it was first filed.

  **Req 7 is untouched.** A destination is an issue-API address; nothing on this
  path touches a git remote, a branch or a push, and the checkout stays
  read-only. The integration test asserts the plugin repository's issues
  endpoint is the *only* thing the filing reaches.

  **One consequence req 7 forced a guard for**: a merged project PR whose body
  says `Closes tools#12` would otherwise complete an issue on the plugin
  repository (docs/194 resolves `Closes` through exactly these destinations).
  Req 7 says the fix cannot have been in that merge — a project session never
  changes a plugin — so `issue-lifecycle.ts` refuses the completion for a
  plugin-addressed pointer and surfaces why, in the transcript, rather than
  closing a third party's report on the strength of an unrelated merge. `Refs`
  is unaffected and is the pointer that means what the author meant.

  **The user's half of req 25 is chat** (principle §5): the user reports
  feedback by asking the agent, which is the actor. No feedback button is added
  to the Plugins tab. One known consequence of the no-tab decision: an inline
  `game-tools#12` in a transcript renders as plain text rather than a badge,
  because the client derives its destinations from the tab list — the write
  card itself still opens the filed issue inline, so nothing links out.

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
| **The Plugins tab** — a right-rail tab holding one card per declared repo: ref @ exact SHA, the plugins used from it, needs, grants, refresh, degraded and collision states (reqs 12, 13, 15, 20, 23, 24) | tab mock 1–3 | The right-rail tab strip (`App.tsx` ~1690–1895; `Tab.badge` slot for the warn dot) | New tab, gated on **plugin intent, not on valid repos** (round-two finding 2): a `plugins:` block that parses to zero valid repos still shows the tab, and parse warnings, never-fetched, and unavailable states all count toward the warn dot — otherwise an invalid declaration erases its own warning surface (req 13). The dot uses the existing `Tab.badge` slot with an accessible label ("Plugins — attention required"). Client state is a **session-scoped store** (not pane-local): seeded from the snapshot on attach/reload, stale-session guarded, refetched by the `files-changed` shipit.yaml hook, feeding the dot while the pane is closed; when the tab disappears (declaration edited away, session switch to a plugin-less repo) an effective-tab fallback coerces `rightTab` to Preview/Files, and the tab joins `useTabLabelCollapse`'s dependency key. Mobile needs nothing separate — the same right panel renders under Workspace. Data: `GET /api/plugin-repos?sessionId` returns one authoritative snapshot (declaration incl. **`consumerRepoUrl`**, resolved ref/SHA, exports, needs and their satisfaction, degraded/collision state); WS `plugin_repos_updated` (as built) carries a `sessionId`-scoped **signal** that an activation round settled; the client refetches the snapshot rather than the message carrying a second copy of it. Grants happen here: **"Add key…" opens the Project Settings dialog on the CONSUMING project's secret store** — `setProjectSettingsRepoUrl(consumerRepoUrl, "secrets")`; passing the plugin repo's URL would save the key into the wrong store, since that call selects the store `/api/secrets` writes to (round-two finding 1). "Allow (session)/(instance)" posts to the existing not-container-accessible `POST /api/egress/hosts` with the scope choice. The `PrLifecycleCard` and its strip are **untouched**. No "commits behind" badge (req 15 wants ref + exact commit, not network polling) |
| Needs — credentials (req 23) ✓ | tab mock 1 | `SecretsTab.tsx` / `DeclaredSecretRow.tsx`, fed by `secrets_status`; the card's need rows, fed by the snapshot | **Built.** Two surfaces, one resolution (`shared/plugin-credentials.ts`). The **card** carries needs on the `use` entry that declares them (`PluginRepoUseView.credentials`), so an unset key reads as "`artk` needs `FAL_KEY`" — grouped per plugin, which is the requirement; a flat list cannot name the claimant. The **settings row** gets the origin dimension `secrets_status.declared` lacked (it is flat, name-keyed — `service.ts:117`, and `SecretsTab` save assumes unique names): entries gain `plugins: string[]`, and `secrets_status` gains a grouped `plugins` array. A project credential and a plugin credential with the same name are **deliberately the same stored secret** — one row, both claimant lists, the compose metadata (`required`, `agent`, description) untouched. A plugin-only name becomes a settable row with no consuming service. Plugin needs deliberately stay OUT of `missingRequired`: that list drives the preview's blocking "configure secrets" banner, which is about the project's own services failing to start; a plugin's gap belongs on the plugin's card and on the tab's warn dot. **Where satisfaction comes from is the security property** — see the boundary note below |
| Needs — hosts (req 24) | tab mock 1 | The plugin card's needs rows, over the existing `POST /api/egress/hosts` (global or session scope; browser-only) | "Host not allowed" is evaluated against the **agent container's** allowlist — where companion CLIs run — because today's containment lives in the agent's netns while compose service containers have unrestricted egress (docs/172 residual). The need-row therefore names the blocked claimant (e.g. "blocks `artk`") rather than asserting one repository-level truth across both execution surfaces (round-two finding 4). Whether plugin *services* get their own containment is an explicit slice-2 decision, not a side effect of compose validation. Grant endpoints stay browser-only, so plugin code cannot self-grant |
| Degraded / collision reporting (reqs 13, 20) | tab mock 2 | Card states inside the Plugins tab | **One card per declared repo, always** — simultaneous problems compose as multiple issue rows under one header whose status chip shows the worst state (round-two finding 8). Every card state, including degraded and collision, keeps the full `owner/repo` + ref @ commit identity visible (req 19 — the identity is what the standing grant trades approval for). **Degraded** distinguishes "refresh failed — prior version `<sha>` remains active" (req 15) from "never fetched — session runs without this repo's services" (req 13); **collision** names the colliding domain and the fix as "under the `use` entry whose alias is `<alias>`" (a `use` entry is a YAML sequence item, so there is no bracket path). A card states each fact **once**: a phase-2 failure names the selectors the declared version lacks, so the snapshot's own "not in this repository's `exports.plugins` manifest" line is suppressed for exactly those names (the failure carries them as `missingSelectors`) — it still fires when the attempt failed for another reason and the LIVE generation is what lacks the selector. Found by dogfooding the spine, not by review. Not transcript cards — no new DB columns, stores, or migrations |

**The credential boundary is held by construction, not by convention** (req 23,
last sentence: a plugin's store "can never resolve ShipIt's own platform
credentials"). There is exactly ONE producer of the satisfied-name set —
`loadSatisfiedPluginCredentialNames` — and its shape is the property:

- It reads **`SecretStore`**, the per-repository store of values the user typed
  into Settings → Secrets. ShipIt's platform credentials live in a different
  store entirely (`CredentialStore`: GitHub identity, tracker tokens,
  agent/provider routes, MCP OAuth), which `plugin-credentials.ts` does not
  import and whose type the parameter does not admit.
- It is keyed by the **consuming session's** `remoteUrl` — the same value the
  card's "Add key…" writes back to, so the gap named and the store opened can
  never disagree. That is the store trap below, on the read side.
- It returns **names only**: values are read to test emptiness and discarded,
  so nothing downstream is in a position to leak one.
- On the `secrets_status` path the boundary is held by *sharing one input*
  rather than by a second lookup that could drift: satisfaction is decided
  against the very `userSecrets` map the compose services just resolved from.
  `accountAgentEnvLoader`'s values (the user's provider tokens, MCP OAuth) are
  merged into `agentValues` only, and never consulted for a plugin.

`plugin-credentials.test.ts` proves it with a populated `CredentialStore` beside
an empty project store: a plugin declaring `GITHUB_TOKEN`, `LINEAR_API_KEY`,
`ANTHROPIC_API_KEY` and `MCP_PLATFORM_NOTION` reports all four as gaps while
every one of them is really set on the platform side. A value the *user* placed
in the project store under such a name is theirs and does resolve — the
boundary is about ShipIt's credentials, not about reserved names.

**Keeping both surfaces current** (implementation review). The card is fetched,
so it is current by construction — but only if something refetches it: saving a
key from "Add key…" now refetches the snapshot, because nothing else would and
the card would keep naming a gap the user had just closed. `secrets_status`
is *pushed*, and it samples plugin declarations only inside its own sync pass,
so a first activation or a refresh that renames a credential would leave the
settings rows on the previous declaration until an unrelated reconcile. The
settled-activation hook therefore calls `ServiceManager.refreshSecretsStatus()`
— deliberately NOT `refreshSecrets()`, which re-runs `compose up` for every auto
service and would make a plugin refresh restart the user's app.

One coverage limit remains, stated rather than hidden: `secrets_status` exists
only for a session that has a compose stack, so a plugin-consuming project with
no compose file of its own gets its needs from the Plugins tab alone until
compose-fragment merging (slice 2) gives it a stack. The snapshot path has no
such dependency, so the named gap and its "Add key…" are never missing there —
only the settings-row claimant chips are.

**An accepted, self-correcting skew**: within one snapshot request the active
manifest (credential names) and the generation record (commit) are two reads of
the same `active` symlink, so an activation swapping between them can render
commit A's identity beside commit B's credential names. Coupling the two reads
would mean threading one resolved generation path through the credential
collector, which both surfaces share; the window is one request wide, the client
is already polling while `activating` is true, and the next response is
coherent. Recorded here rather than left for a reader to rediscover.

Settings → Network egress is **unchanged** (it is explicitly the global-only
editor — `SettingsEgress.tsx:135`); the diagnostics panel addition and the
multi-host `EgressPromptCard` variant were reviewed out of v1.

**How the client learns the declaration** — the `issues.trackers` precedent,
copied: per-request config read behind `GET /api/plugin-repos`, the
`files-changed` handler refetches on `shipit.yaml` edits (with the
`declarationsPending` guard against caching an empty read), and the
`plugin_repos_updated` WS message keeps user- and agent-triggered refreshes
coherent in one UI.

## 4. Key files (anticipated; ✓ = exists)

- ✓ `src/server/shared/plugin-repos.ts` — both blocks parsed here (consumer
  `plugins:`, plugin `exports.plugins:`), one cross-block name reservation
  pass, fail-closed grammar, and the snapshot projection. Filesystem-free so
  the client imports the types; `shipit-config.ts` is the entry point and
  parses trackers first (the reservation order).
- ✓ `src/server/shared/plugin-credentials.ts` — req 23's pure half: collect
  each activated plugin's declared credential names from the LIVE manifest,
  resolve them against a name set, and project claimants. Filesystem-free (the
  client imports the types). A repository with no live manifest reports
  *nothing*, never "needs nothing" — "not knowable" must not read as satisfied.
- ✓ `src/server/orchestrator/plugin-credentials.ts` — its store-facing half and
  the single sanctioned satisfaction source
  (`loadSatisfiedPluginCredentialNames`); see the boundary note in §3. Feeds
  both the snapshot route and `service-secrets-resolver.ts`.
- ✓ `src/server/orchestrator/plugin-generations.ts` — the generation engine:
  layout under the session state dir (docs/246 — never inside the clone),
  commit resolution incl. durable pins, staging, phase-2 selector validation,
  atomic symlink publish, pruning. It runs no plugin-authored code — install
  is container-side (see §1b). ✓ `services/plugin-activation.ts` is its lifecycle
  half, triggered from `service-manager-setup.ts` on session activation and on
  a `shipit.yaml` edit. `readActiveManifest` reads the live commit's own
  `exports.plugins` through the same `active` symlink: the generation record
  carries export NAMES only, which answers "is this selector real?" and nothing
  about what an export *declares* (req 23's credentials, later settings and
  hosts).
- ✓ `src/server/orchestrator/plugin-fetch.ts` — req 10's credential resolution:
  the plugin repository's own read-only App installation token, else the host
  PAT, else none, plus the named failure when none of them reaches it (req 13).
  It builds the `ensureCache` hook `bootstrap-managers` injects, so the
  credential exists only for the duration of one fetch. Its mechanism half is
  ✓ `repo-git.ts`'s `GitRemoteCredential` (a per-instance, host-scoped
  credential that overrides the global helper) and ✓ `github-app-token.ts`'s
  read scope (`contents: read` — a declaration grants a fetch, never a push).
- ✓ `src/server/orchestrator/plugin-state.ts` — the per-import primitives
  (reqs 17, 18, 26): the durable layout under the SESSION ROOT (not the state
  dir, which eviction reclaims), settings resolution and its two fail-closed
  errors, the atomic settings write, and the manifest resolver that reads a
  tracked import from the live generation and a `repo: self` import from the
  project's own parsed manifest. Reading a live checkout's manifest goes through
  the generation engine's `readActiveManifest` — the one **orchestrator-side**
  entry point, shared with `plugin-credentials.ts`; this module had its own copy
  of that parse until the two slices landed days apart, and a third copy is how a
  fix to manifest handling starts reaching only some of its readers. The
  container keeps a reader of its own (`session/plugin-skills.ts` →
  `readExports`) and that is **by design, not an oversight**: `eslint.config.js`
  makes `session/` ↔ `orchestrator/` imports a hard error in both directions,
  type imports included, because they are different processes — and for plugins
  it is also the "the orchestrator says *when*, never *what*" split. So: fold an
  orchestrator-side reader into `readActiveManifest`; do not try to fold the
  container's. Prepared from `services/plugin-activation.ts`
  at the end of every round; its issues are re-derived, not stored, by
  `api-routes-plugin-repos.ts`. ✓ `src/server/shared/plugin-contract.ts` holds
  the in-container names both later consumers need (`/plugin-state`,
  `SHIPIT_PLUGIN_STATE`, `SHIPIT_SETTINGS`), filesystem-free so the session
  layer can import them.
- ✓ `src/server/orchestrator/plugin-overlay.ts` — the copy-on-write layer, one
  `type=overlay` Docker volume per generation (lowerdir the pristine checkout,
  upper/work beside it under `work/<sha>/`). Its whole subtlety is that the
  three dirs are **daemon-host** paths, translated off the state volume's
  mountpoint the way docs/183 does; the orchestrator's own view is carried
  separately because it must create upper and work itself. Install and publish
  share ONE upper layer under two different lowerdirs (staging, then the
  published generation), so the install volume is removed before the runtime
  volume is created — the kernel forbids one upperdir backing two mounts. The
  12-character session prefix in the volume name is what makes an orphan
  reclaimable by the disk janitor's sweep.
- ✓ `src/server/orchestrator/plugin-install.ts` — the throwaway install
  container: the generation's overlay volume at `/plugin` and nothing else, the
  worker image for its toolchain with its entrypoint bypassed, no inherited
  environment, capabilities dropped, bounded by a timeout, and its own network
  whose subnet is denied at ShipIt's API (see §1b). Injected into
  `activateGeneration` as `runInstall` from `bootstrap-managers`, so neither the
  generation engine nor the activation service executes plugin-authored code.
  Also owns the boot-time reap of install containers **and generation volumes**
  a previous process left behind: no existing sweep covers them (the janitor's
  volume pass filters on `dangling=true`, which an attached volume is not, and
  on a later boot it preserves everything belonging to a live session), and an
  orphan holds the volume open so the next activation of that commit cannot
  rebuild the mount. It runs BEFORE the janitor's volume pass for that reason.
- ✓ `src/server/orchestrator/api-routes-plugin-repos.ts` — browser snapshot
  (the GET exists; refresh endpoints come with generation mechanics); tracker
  registration folds into the existing trackers registry
  (`api-routes-issues.ts`) with destination-based dedup.
- ✓ `src/server/shared/plugin-feedback.ts` — req 25's pure half: a
  `plugins.repos` entry → a feedback destination, and the session-context
  footer. Filesystem-free like its neighbours, so the orchestrator reads the
  live generation and hands the commit in. `trackers/registry.ts` registers the
  destinations (unlisted, `origin: "plugin"`, aliasing onto a tracker
  declaration of the same repository); `services/issues.ts` stamps the footer on
  a create; `api-routes-issues.ts` reads the declaration and the running commit
  in the same pass it already reads `issues.trackers`. No new route and no new
  agent verb — `shipit issue create --tracker <repo-name>` is the whole surface.
- ✓ `src/server/session/plugin-runtime.ts` — the container half: it points
  `/plugins/<name>` at the read-only store mount, removes links the declaration
  no longer names, and materializes each imported plugin's skills
  (`session/plugin-skills.ts`, req 22 — reading each repository's own manifest
  out of its live checkout, so the orchestrator still says only *when*, never
  *what*). It runs no plugin-authored code — copying markdown is not running
  it, and install is not here and must not come back here (§1b).
  Reached over `POST /plugins/prepare` on the worker
  (`session-worker.ts`), which `ContainerSessionRunner.preparePlugins()` calls
  when an activation round settles and when a container becomes ready — the
  latter because a restarted container loses its links while the generations
  they address survive. The single read-only mount is built in
  `container-lifecycle.ts`; `/plugins` itself is created and handed to the
  worker UID by the entrypoint, and appears in `container-hardening.ts`'s tmpfs
  set for the read-only-rootfs case.
- `src/server/session/agent-shim/shipit-plugin.ts` + a worker agent-ops
  relay route — the agent's `shipit plugin refresh` transport (orchestrator
  API routes are container-denied; the shim goes through the worker like
  `shipit issue`).
- ✓ `src/client/stores/plugin-repos-store.ts` — the session-scoped store
  behind the tab, its warn dot, and the effective-tab fallback; the pane is
  `PluginReposPanel.tsx`. v0 renders declarations with an honest
  "declared — mechanics pending" state for tracked repos (not counted toward
  the warn dot; the full state set arrives with the slice-2 mechanics).
  Three race guards, each from the implementation review: foreign-session
  responses are dropped, a monotonic generation makes same-session refetches
  **latest-wins** (the seeding fetch and `files_changed` overlap freely), and
  every read goes through `snapshotForSession` so a snapshot can only gate the
  session it belongs to. The route reports **`pending`** — evicted or
  mid-restore checkout — which the store retries with backoff instead of
  caching, the `declarationsPending` mechanism docs/248 needed for the same
  reason.
- `src/server/shared/types/ws-server-messages/service.ts` — structured
  `origin` on service messages; ✓ `secrets_status`'s plugin dimension
  (`declared[].plugins` claimants + the grouped `plugins` array); ✓ new
  `plugin_repos_updated`.
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

*(This section describes the DESIGN slice. Checkout/bare-cache mechanics and
generation staging/activation have since been built — see §4's ✓ entries and
`checklist.md`.)*

Slice 2 (see `checklist.md`): compose-fragment merging and
security validation, port stability per (session, service), plugin `install`
execution (container-side — see §1b), credential
injection mechanics, PATH wrapper generation, skills materialization
mechanics. (GitHub App multi-repo minting has since been built — see the
fetch-authority bullet in §2 and `plugin-fetch.ts`.)
