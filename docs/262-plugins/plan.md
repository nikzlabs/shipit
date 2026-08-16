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

### The trust model, stated first because everything below reads differently without it (req 29)

The mechanisms in this document contain a plugin's **code**. They do not
contain its **influence on the agent**, and no mechanism could — a materialized
skill is instructions the agent follows (req 22), a companion CLI's stdout is
material the agent reads and may act on (req 17), and a plugin service serves
pages the user's browser loads (req 21). Those three are the feature, not a
leak.

So read every containment decision below as bounding the **blast radius** of a
repository that turns hostile or is compromised upstream — no fetch credential,
no host reach, no write to the project's repository — and never as making an
unread plugin safe to declare. Declaring one is a trust decision on the order of
adding a dependency. This was written down (2026-08-15) after a design
discussion found that the documents asserted the containment and never stated
its limit, which let a reader infer a stronger guarantee than the design offers.

Two consequences that are easy to get wrong in a later slice: a defect in the
containment (planning#370, planning#371) is worth fixing on the blast-radius
argument alone, even though a declared plugin is trusted; and a proposal to
"sandbox" skills or CLI output is a category error — the answer there is the
same one that applies to any ingested content, which is that the agent treats
it as data rather than as instructions.

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

    **Amended for commands, on implementation** (§2, "CLIs"): a contested
    *command* name withholds **that command** — from every claimant — and
    activates everything else. Failing the whole generation was the wrong unit
    here: a command collision is a defect in the CONSUMER's declaration, not in
    either repository's version, and both are fixed in the same `use` entry
    (`overrides.commands.<x>.as`). Failing activation would take out a
    perfectly good plugin's services and skills over a naming clash it did not
    cause, and it would have to pick a repository to blame. Req 15's coherence
    is about a repository's own version, which nothing here disturbs; req 20's
    requirement is that the ambiguous one is reported rather than run, which
    withholding satisfies exactly. Services keep the stated rule — a compose
    stack is activated as a unit.
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

  **Implemented, and the substitution is one line per surface.** Every reader
  already takes "which tree does this declaration resolve to?" as its input, so
  self-use is that one answer changed and nothing else: the orchestrator's
  `resolveLiveGenerations` answers `null` (no generation to verify) while each
  surface's own self branch names the working tree —
  `plugin-compose.ts`'s `snapshotRepo`, `plugin-cli-run.ts`'s unpinned mount,
  `plugin-state.ts` and `plugin-credentials.ts` reading the project's own parsed
  manifest, and now `session/plugin-runtime.ts`'s `resolveLiveCheckout` for the
  container pass. No second compose path, manifest reader or settings writer
  exists for it (req 5 applied to the plugin's own repository).

  **The identity guard's answer for `repo: self`: never resolve a generation,
  and retire any that is found.** A generation records the repository it was
  built from and every reader compares that against the declaration; a self
  declaration has no such record, so the question is not "which record proves
  this one?" but "what may stand in for it?" — and the answer is only the
  session's own working tree. Nothing under the store is consulted, so a
  checkout left by a declaration that USED to be tracked under the same name
  cannot be linked, cannot supply skills and cannot name a command. It is also
  retired rather than left lying about (`retireSelfDeclaredGeneration` wraps the
  same retirement an ordinary re-point runs, under the same lease): self
  activates nothing, so no later round would ever have reconciled it, and the
  store mount would keep the previous repository's files readable for the
  session's whole life. Two things that wrapper adds, both from review. It takes
  the **per-repository queue**, the key activation serializes on, so it cannot
  interleave with a publish for the same name — off the queue it could delete a
  generation a later round had just published, or that round's staging tree. And
  it **re-reads the declaration inside the queued task**: ordering alone does not
  help a round that read `self` before the name was re-pointed, so the version on
  disk when the work runs is the only one it acts on. It also answers the
  source-less legacy record the OPPOSITE way from the tracked path — there
  "unknown provenance" might be this repository's own generation, and under a
  self declaration it cannot be, since nothing ever publishes one.

  **The two things a plugin author should expect, stated rather than implied.**
  `/plugins/<name>` is deliberately NOT created for a self declaration — the
  agent already has that tree as its workspace, and the path is not one a plugin
  can rely on anyway, since every consumer names the repository itself. And what
  ShipIt *copies* rather than reads live — the materialized skills and the
  generated command wrappers — is re-applied on the next activation round (a
  `shipit.yaml` save, or the session opening), not on the edit itself; `shipit
  plugin refresh <self-name>` stays refused, because there is no version to move
  to. Everything read live — the service's tree, the CLI's tree, `/project` —
  needs nothing.

  **And `install` does not run under self — settled by the user on 2026-08-14
  ("keep it out"), and now in req 27's own words** (`requirements.md` → Resolved
  questions; the paragraph below is why it was asked). A plugin's `install`
  populates a generation's writable
  layer and self has neither, so the repository's own `agent.install` is what
  prepares the working tree its services and CLIs run out of. An independent
  review read that as a req 27 violation — "nothing is duplicated to make
  self-use work" — against req 27's own enumeration, which does not name install;
  `test-plugin/` assumes the reviewer's reading (it gitignores a stamp only a
  self-mode install could write). It went to the user rather than being decided
  here, because running it would mean a new install-container branch over the
  session's working tree — mechanism no requirement had asked for.

  **What `agent.install` prepares has to reach the plugin's containers, and did
  not** (`nikzlabs/shipit#2298` finding 1, fixed in #2302). On an overlay-eligible
  session (docs/183) the clone's `node_modules` **is** an empty directory on the
  workspace volume — the content lives only in per-session `type=overlay` Docker
  volumes that the agent container and the project's own compose services attach.
  A plugin's containers attached neither, so under `repo: self` both `/plugin`
  and `/project` held an empty directory exactly where the plugin's own
  dependencies belong, and no entry point could start. One rule now covers both
  surfaces: **a plugin sees the project's dependency directories precisely when
  the project's tree is its own tree, and then it waits for the project's
  install** — the nesting targets are empty for a tracked import, and
  `dependsOnInstall` becomes `svc.self`.

  Two things about that rule are load-bearing rather than incidental. The
  **self-only narrowing came from review, not from design**: nesting uniformly
  would have given a *tracked* plugin's `/project` the project's real
  dependencies while it kept `dependsOnInstall: false`, so it would read
  `node_modules` while `agent.install` was writing them — the precise race
  docs/137's gate exists to prevent. And it is the same narrowing the trust
  boundary needs, for an unrelated reason: a third-party plugin never gets a
  writable handle on the tree the agent's own processes load code from. Under
  `repo: self` there is no such boundary to hold — the plugin IS the project.

  This is **not** a new requirement, and deliberately was not written as one. Req
  27 already says a plugin "works as a plugin inside its own repository", and a
  companion CLI that exits with `ERR_MODULE_NOT_FOUND` is not working; the
  outcome was always required. Which directories are mounted where is *how*, so
  it belongs here rather than in `requirements.md`.

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
      dep-dirs: [node_modules]                            # what install populates; shared via the
                                                          # dependency store (req 28). This is the
                                                          # default — an empty list opts out
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

**Implemented** (`plugin-compose.ts`), and the resolution question is settled
by taking the third option: the fragment is **never handed to `docker compose
-f`** at all. ShipIt parses it, validates it, and re-emits each service into the
generated override with every relative source rewritten into an explicit mount
of the plugin's own tree — the generation's overlay volume with a `subpath` of
the fragment's directory, or the workspace volume for a `repo: self` import.
Neither `include` nor a path rebase could have been enough on their own: what a
fragment's `.` must resolve to is not a path on the daemon's filesystem at all
but a subpath of a Docker volume (§2's merged view), which no compose-level
mechanism can express for it.

Re-emitting is also what turns the validation below into a boundary rather than
a lint, since ShipIt then authors every line the daemon sees. The v1 limits that
follow from it: a fragment may declare only keys from an explicit allowlist
(everything a service says about ITSELF; nothing about its relationship to the
host, which is ShipIt's to decide), only bind mounts of its own `./…` files plus
anonymous volumes, and **no `build:`** — a build context cannot be a Docker
volume, and pointing it at the pristine checkout instead would give one service
two different views of the same plugin. A plugin that needs an image builds and
publishes it like any other image.
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
fails closed: a subnet ShipIt cannot deny means nothing runs.

**"Cannot deny" includes an address family the guard does not match.** The
guard's CIDR comparison is IPv4-only, so on a *dual-stack* network the
container's IPv6 address falls in no registered CIDR, which the guard reads as
a browser/host caller. Registering *some* IPv4 subnet is therefore the wrong
bar: every subnet the network reports has to be registerable, and the network
ShipIt creates is pinned `EnableIPv6: false` so a daemon default cannot make
it dual-stack in the first place. **Latent rather than live**, and recorded
that way so the wrong end does not get "fixed": the orchestrator binds
`0.0.0.0` (`app-lifecycle.ts`), so no IPv6 listener answers today — what the
check buys is that the boundary does not open silently when the listener,
a proxy, or the deployment topology gains one. Teaching
`api-container-guard.ts` to match IPv6 CIDRs closes it from the other side and
is the better fix the day a plugin container legitimately needs IPv6; until
then this refuses such a network outright, so an IPv6-only outbound dependency
is unreachable from plugin code. Both the install and CLI surfaces get this
from `plugin-container.ts`, which is why it is shared code rather than two
copies.

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

  **`/plugin` is writable exactly when it is the project** (settled 2026-08-15,
  after the real-instance run found the two surfaces disagreeing — see
  `real-instance-e2e.md`, Run 1). The rule is one sentence because the answer
  must not depend on which surface asks; both halves already follow from reqs 7,
  15 and 27, so nothing new is required:

  | What the tree is | Companion CLI | Service | `install` |
  |---|---|---|---|
  | A tracked **generation** (overlay volume) | read-only | read-only | **read-write** — the one writer, and it runs *before* publication |
  | A **`repo: self`** working tree | read-write | read-write | does not run (req 27) |

  **It is a rule about the TREE, not about the path** — which is the half a
  review caught after the first fix. A service also mounts its own tree through
  its *fragment's* relative volumes (`- .:/app`), and those are rewritten onto
  the same generation volume; Compose's default there is read-WRITE, so a
  read-only `/plugin` sat beside a writable alias of the identical layer, and the
  ordinary declaration almost every fragment writes was enough to reach it.
  `rewriteFragmentVolume` now forces read-only for a tracked generation and
  leaves a `repo: self` fragment's declared mode alone. Forced rather than
  refused: the read-write form is a default nobody typed on purpose, and
  refusing would withhold a whole repository's services (§2's all-or-nothing
  rule) over it.

  For a generation, read-only is req 7 (the source stays unmodified; the writable
  location a plugin gets is `/plugin-state`, and its durable output is `/project`)
  and req 15 (the files, the CLIs and the services of a repository all correspond
  to ONE commit). A runtime surface that can write the merged view copies up into
  the generation's upper layer, so it changes the code *every other surface in
  that session* then runs, for the life of the generation, while
  `SHIPIT_PLUGIN_COMMIT` still names the commit it is no longer running — and, in
  the words `plugins.md` already uses for the agent's own checkout, the edit
  "applies to this one session, vanishes on the next refresh, and reaches
  nobody". **Both surfaces could write it until this was settled** — the
  companion CLI directly at `/plugin` (`plugin-cli-run.ts`), a service through
  its own fragment's `- .:/app` (`plugin-compose.ts`, see the next paragraph).

  For a `repo: self` tree, read-write is req 27 ("the read-only rule binds only
  consuming projects"), and read-only there would be a boundary in name only:
  it is the same directory the same container has read-write at `/project`, so
  forbidding the `/plugin` path forbids nothing and only makes self-use behave
  unlike the mode it exists to rehearse. **The service mounted `/plugin`
  read-only until this was settled** (`plugin-compose.ts`), while mounting the
  same tree writable at the fragment's own path — the two halves of this rule
  were each wrong on a different surface.

  **What the rule is about is coherence within a session — one commit, one
  answer per path — not containment across sessions**, and the second claim
  needs stating narrowly, because a broad version of it is false. What holds:
  **a plugin's RUNTIME code cannot mutate another session's generation, or a
  dependency base that has already been published.** A generation lives under
  `<sessionDir>/state/plugins/…`, so it is per session to begin with; a write
  through a merged mount never reaches the generation directory on disk; and a
  shared dependency base (req 28) is stacked as a **lowerdir**
  (`buildPluginOverlaySpec`), which the kernel makes read-only, so a write
  copies up into the caller's own layer.

  What is deliberately shared, and should not be read as excluded by the above:
  a plugin's **`install` is plugin-authored code with a read-write mount of that
  repository's package download cache** (`resolveDepCacheMount`), which every
  session and project installing the same plugin repository shares; and its
  output is **promoted into a shared dependency base** for later sessions
  (req 28's whole point). The orchestrator performs the promotion and a
  published base is immutable afterwards, but the bytes in it were produced by
  the plugin. Both are req 28 working as designed — the trust that pays for them
  is the standing grant of req 19, not a containment property.
- **The consumer lease** (req 15) — **implemented** (`plugin-leases.ts`): a
  generation's checkout and writable layer are deleted only when nothing is
  running against them.

  The shared volume above is what makes this necessary. Both plugin surfaces —
  a companion-CLI invocation container and a plugin service container — attach
  ONE volume per generation, whose lowerdir is the checkout on disk and whose
  upperdir is `work/<sha>`. Publication deletes both of those the moment a newer
  commit is published, and did so with no idea either consumer existed.
  docs/183's own spike records the result: merged `readdir` starts coming back
  empty while path lookups still resolve, so the container is silently corrupted
  rather than failed. Req 15 says an update completes coherently or the prior
  complete version keeps running; a half-deleted checkout under a live mount is
  neither.

  **One lease, two facts, because they cover different lifetimes.** A generation
  may be deleted only when both agree:

  - an **in-process hold**, taken in the same synchronous block that resolves
    `active` and released in a `finally`. It covers the window a volume cannot —
    from resolving a generation to the moment a container holds it — where the
    volume is either not created yet or created and attached to nothing. That
    window is not benign: Docker re-creates a missing named volume at container
    start as an empty local volume, so the failure is a silently empty `/plugin`
    rather than an error.
  - the **volume's own attachment**, which the daemon enforces (a volume a
    container holds cannot be removed) and which `removePluginOverlay` already
    verifies rather than assumes. This is the half that survives an orchestrator
    restart, and the half that covers a plugin service — a long-lived container
    the call that created it does not outlive.

  **What happens when the releasing side never runs**, which is the case this
  had to be designed around: a hold that is never released costs a generation
  directory that is not deleted — bounded disk inside a session state directory
  that dies with the session, reclaimed by the next publish's prune, and never
  corruption. Process death drops every in-process hold, which is correct
  precisely because no container this process started can outlive it without the
  boot reap removing it. A session disposal drops the rest.

  **Where it is taken.** The CLI invocation holds its pinned generation for the
  whole call (`plugin-cli-run.ts`); a call that resolves a generation the pruner
  has already claimed is refused with "run the command again" rather than
  mounting a tree that is going away. The service surface replaces its hold set
  wholesale on every round (`services/plugin-services.ts`), which is how a
  long-lived consumer's lease follows a refresh with no release call to forget.
  And publication itself claims the commit it is about to write — from before
  `install`, which CLEARS `work/<sha>` before writing, through the rename that
  replaces the checkout's inode. Both of those are reachable by one route: a
  project pinning back to a version it recently ran (req 8's exact case), whose
  generation a prune left in place *because* a consumer was using it. Refusing
  there is an ordinary failed activation.

  **The bound, stated rather than left implied.** A prune that is refused does
  not retry on its own; the next publish's prune reclaims whatever has since been
  released. So a session retains, beyond the live generation, **one generation
  per still-held generation** — normally the single one its consumers were
  running when the refresh landed, but genuinely more when long invocations
  overlap several refreshes (a CLI on A, refresh to B, a CLI on B, refresh to C
  retains both A and B — review finding; an earlier version of this paragraph
  claimed a flat ceiling of one). Every one of them is a generation something is
  actually using, and each is reclaimed by the first publish after its consumer
  finishes, or with the session.

  **What the prune cannot see, stated for the same reason.** Removing a
  superseded generation's *volume* is now part of taking the lease to delete the
  generation, which closes the leak where volumes were only ever swept on the
  service path and a session refreshing without services accumulated one per
  refresh. The residual is the mirror image: the prune derives volume names from
  the directories it finds, so a volume whose directories were removed by a
  DIFFERENT actor — disk-tier eviction wipes the whole session state dir
  (`REGENERABLE_SESSION_SUBDIRS`) — is no longer discoverable by it (review
  finding). Such a volume holds no bytes, since the upper layer it describes went
  with the state tree, and `reapOrphanPluginInstalls` drops every plugin overlay
  volume at the next orchestrator boot. Re-adding a Docker-listing sweeper on the
  service path to catch it sooner is the thing to *not* do: two owners racing on
  one volume name is what this lease replaced.
- **Services** (reqs 3, 5, 16, 20) — **implemented**
  (`plugin-compose.ts`, `services/plugin-services.ts`): each imported plugin's
  fragment becomes real services in the session's own compose stack, emitted
  into the generated override beside the project's own and therefore picking up
  every ShipIt policy — labels, the session network, `cap_drop`, the
  contained-egress overlay, the worker uid — from one implementation, which is
  what req 16's lifecycle parity means in practice. They are in the same service
  map, so start/stop/restart, logs, health and preview all address them by name;
  the only thing that marks one is a structured `origin` on `ManagedService` and
  the service WS messages.

  **A fragment is validated exactly as the project's own compose file is in that
  session** — the same `validateServiceSecurity`, contained-egress rules
  included (docs/263), so a plugin must declare a numeric non-root `user:` in a
  Contained session like everything else there. Three things are added at the
  plugin edge, each because the project's own laxity is not the plugin's to
  inherit: **never the Docker socket**, whatever `compose.docker-socket` says;
  **every `$` escaped on the way out**, because Compose interpolates from the
  environment of the process that runs it — the orchestrator's — so a fragment
  could otherwise name ShipIt's own variables into a plugin container; and the
  key allowlist above. A pass-through `environment: [- SOME_NAME]` entry is
  refused for the same reason as the escaping.

  **A repository's services are all-or-nothing.** One unusable service — an
  invalid fragment, a name that collides with the project's or another plugin's
  — withholds every service that repository provides, with the reason on its
  card; the prior generation stays live, so nothing is torn down to say so
  (req 15). This is the phase-3 rule as §1a states it, and it is deliberately
  **not** the rule for commands, which are withheld individually: a compose stack
  is not a set of independent services, while a command name is just a name. The
  collision message names the domain and the fix
  (`overrides.services.<name>.as`), and the snapshot GET **recomputes** it from
  the same pure collector rather than remembering it, so a declaration that
  cannot work says so before anything has run.

  That recomputation adds a read of `active` to the snapshot GET, which the
  "resolve `active` once" sweep has to count. The collector itself is coherent
  — one `realpathSync` in `snapshotRepo`, every later fact read from the
  directory it returned — so the residual skew is between the collector and the
  route's own `readActiveGeneration`: the commit rendered could belong to a
  different generation than the issues rendered beside it. Closing it means the
  route taking that record from the collector, which is a change to the route's
  contract rather than a call-site tidy, and so is left to the sweep. Same class
  as the credential/commit skew recorded below: one request wide, self-healing.

  **Open, and it fails toward running the wrong repository: the directory-scoped
  readers carry no identity check.** #2225 adds `source` to `GenerationRecord`
  and makes `readActiveGeneration`/`readActiveManifest` return null when the
  live generation came from a different repository than the declaration now
  names — but it leaves `readGenerationRecordAt`/`readGenerationManifestAt`
  source-agnostic, and those are what the resolve-once rule tells callers to
  use. `snapshotRepo` is such a caller, so a `repos:` entry re-pointed from
  `acme/old` to `acme/new` can still have `acme/old`'s checkout mounted as this
  session's plugin services. `retireForeignGeneration` closes the window inside
  `activateOnce` — but activation is **fire-and-forget** at both call sites
  (`service-manager-setup.ts:436`, `:1077`), deliberately, so a slow fetch never
  delays a session opening (req 13). The window is therefore bounded by a git
  fetch plus an install, not by a symlink swap, and the service path usually
  wins it: `setupServiceManager` fires activation at `:436`, then resolves
  plugin services at `:814-817` behind local awaits only. A session opening
  against a declaration re-pointed since its last round STARTS the previous
  repository's services. The `shipit.yaml`-edit path differs — its reconcile
  reuses already-resolved services rather than re-resolving, so there the
  exposure persists across the edit rather than being created by it. Ordering
  the reconcile behind activation is the wrong lever: it trades req 19 for
  req 13 and still leaves session activation resolving before any round has run.
  **This is a class, not an instance, so the fix is a shared helper rather than
  a comparison pasted here.** The guard sits in the wrappers because that is
  where the link-following callers were when #2225 was written; "resolve once"
  moves callers OFF the wrappers onto self-resolution, so each migration sheds
  the guard as a side effect and looks like progress while doing it. There are
  two self-resolvers — `pinGeneration` (`plugin-cli-run.ts:368`, merged) and
  `snapshotRepo` — and a third arrives with the next one. The version that
  generalizes is an engine helper (sibling report, req 25 slice):

  ```
  resolveActiveGeneration(stateDir, repoName, expectedSource)
    → { dir, record } | null
  ```

  One resolution, the identity check AT the resolution, a verified handle out.
  `readActiveGeneration`/`readActiveManifest` delegate to it; `snapshotRepo`
  calls it in place of its `realpathSync`; and the `…At` readers keep an honest
  meaning — *I hold a directory somebody else verified* — which is the only
  reading under which leaving them unguarded is safe. That helper belongs with
  whoever carries #2225, since it owns the `source` field; this slice's change
  is then the call-site swap, not a private comparison.

  **The collector already reads everything that call site needs**, which makes
  the sweep cheaper here than it looks: `snapshotRepo` calls
  `readGenerationRecordAt(root)` and keeps only `.commit`, discarding the
  `exports` and `manifestWarnings` off the same record — the exact two fields
  the route's own `readActiveGeneration` supplies. Widening `RepoSnapshot` to
  carry the record is the whole change on this file; no second read, and no new
  resolution.

  **Session paths are mounted as volume subpaths, never as binds — and that is
  a production-only trap, so it is written down rather than left to be
  rediscovered.** In production the whole session tree lives inside a named
  volume the daemon knows nothing about, so a bind of the orchestrator's
  `/workspace/sessions/<id>/…` makes Docker silently create an EMPTY,
  ROOT-OWNED directory: `/project` would not be the project and `/plugin-state`
  would not be the state the CLI writes to, while dev and dogfood worked
  perfectly the whole time. `container-lifecycle.ts` mounts workspace,
  credentials, uploads and scratch through `VolumeOptions.Subpath` for exactly
  this reason. The state directory and settings file need their own subpath
  keyed off the session ROOT, since `plugin-data/` is a sibling of `workspace/`
  rather than under it. The settings file is mounted **as a file**, which the
  daemon supports from API 1.45 — below the Engine 28 docs/263 already requires
  — and mounting its parent instead would hand the plugin its own settings to
  rewrite.

  **One translation, and it fails closed.** Both surfaces take the subpath from
  `volumeSubpathFor` (`plugin-state.ts`), keyed off the orchestrator-visible
  root that maps onto the volume, so the CLI container and a plugin service
  cannot derive it two different ways — and neither strips a literal
  `/workspace/`. It returns `null` for the two shapes with no honest answer: a
  path the volume does not contain, and the volume ROOT itself, whose subpath
  would be every session's tree at once. Callers must fail closed on `null`,
  because there is nothing to degrade to — a bind does not error, it starts a
  container in which `/project` exists and is empty. The CLI surface refuses the
  run and says why; the compose surface drops the repository's services with a
  reason on its card, the same way it already treats a missing writable layer.
  On the compose side the volume name and its two subpaths are one value
  (`SessionVolume`), so a mount helper that compiles has the subpath it needs;
  the earlier per-mount `?:` spreads could emit `/project` with no subpath at
  all, which is worse than an empty directory — it is every session's tree.
  Asserted on the mount SPEC, never on a filesystem effect: the bug is invisible
  when the source is a real path, which is why dev and dogfood cannot catch it.

  **A settings change recreates the service, via a label.** The settings file is
  rewritten only when its content changes, so a change means a NEW INODE — and a
  file bind mount follows the inode it was created with, leaving a running
  container reading a file nothing writes to any more. The mount path is
  identical either way, so neither the reconcile decision nor Compose's own
  changed-service test would notice. A digest of the content rides a
  `shipit-plugin-settings` label, which changes both answers at once.

  **Mounts come from `shared/plugin-contract.ts`, and the plugin tree is one
  volume per generation.** A service gets the merged tree at
  `/plugin` — the same path the install and CLI-invocation containers use, so a
  `cli:` entrypoint declared relative to the repository root resolves identically
  on every surface — plus `/project`, `/plugin-state` and the settings file. The
  volume itself is obtained through `ensurePluginRuntimeOverlay`, an **ensure**
  rather than a create, because the kernel forbids one upperdir backing two
  independently created overlay mounts and the CLI container asks for the same
  volume. `/plugin` is mounted **read-only** for a service: req 7 keeps the
  plugin source unmodified, and a service's writable surfaces are `/plugin-state`
  and `/project`, not the layer its own CLI runs out of. The full rule, which
  binds the companion-CLI surface identically, is **"`/plugin` is writable
  exactly when it is the project"** — see §2 below.

  **The consumer lease is what keeps a service's tree from disappearing under
  it** (`plugin-leases.ts`, req 15 — see §2 "The consumer lease" below). This
  surface takes an in-process hold on the live generation of every tracked
  repository it resolves, replaced wholesale on each round, and the service
  container's own attachment to the generation volume carries the lease past the
  orchestrator. It no longer sweeps superseded volumes itself: removing a
  generation's volume is now part of taking the lease to delete the generation,
  and two sweepers racing on one volume name is the second mechanism the lease
  exists to avoid.

  **The gap this slice found is now closed** (`services/plugin-preflight.ts`).
  Phase 3 used to run only when services were resolved, which is AFTER
  `activateGeneration` has published and pruned — so a tracked commit whose
  fragment failed validation still became the live generation, its files, CLIs
  and skills moving while its services were withheld. That is the partial
  version req 15 forbids, and it contradicted §1a's "an activation failure keeps
  the prior generation active".

  It is now a **pre-publish gate**: `activateGeneration` takes an injected
  `validateStaged` hook, and the implementation judges the candidate by
  **substitution** — the same `collectPluginFragments`, with this one
  repository's `LiveGenerations` lookup pointed at the STAGING tree. One
  implementation, so the gate cannot drift from the surface it gates; and the
  generation engine still knows nothing about compose. A refusal is an ordinary
  failed activation, so the prior version stays whole and live and the card
  carries the collector's own message (req 13).

  **It runs inside a session-wide publish window, not beside the phase-2 check.**
  Phase 3 asks about the whole session's name domain, so the verdict is worth
  only as much as its adjacency to the swap — and activation is serialized per
  *repository* while repositories run concurrently. Judged any earlier, two
  first-time candidates exporting one service name each see the other as
  not-live, both pass, and both publish; the loser then ends up live for files,
  CLIs and skills but not services, which is the same partial version by another
  route. So the gate, the rename and the link swap are one serialized decision
  (`plugin-generations.ts`'s publish key). Fetch, checkout and `install` stay
  concurrent per repository (req 14). The cost is that a doomed candidate has
  already run its `install` — wasted work in a throwaway container, the cheaper
  half of the trade.

  Three rulings the gate encodes rather than leaves implicit. **The staged
  repository's own issues are absolute; every other repository is judged on the
  DIFFERENCE** — publishing must not take a working sibling's services away
  (req 14), and because the collector's claim order is the declaration's, the
  "who is to blame" attribution would otherwise let an earlier-declared
  repository silently disable a later-declared one by shipping a commit.
  **Command collisions do not gate**, per the amendment above: they withhold the
  contested command and are reported by `plugin-commands.ts`, so the version
  stays coherent. And the gate **fails closed** — on a declaration that went away
  or was re-pointed mid-round, on a project compose file that exists and cannot
  be parsed, and on any unexpected throw. Each is guard-tested, so the next slice
  does not read the gate as half-built.

  Two of those are corrections a review made to the first version, and both were
  ways the original shape re-opened the bug it closed: admitting a candidate
  whose declaration had gone away let an ungated generation reach disk and then
  become live through the `unchanged` short-circuit on re-add, and reading an
  unreadable project stack as an *empty* name domain admitted exactly the
  collisions the gate exists to catch. A declared compose file that does not
  exist yet stays a definite answer — no stack, no claimed names.

  **Egress is unchanged on this surface.** Plugin service containers ride the
  session's existing posture, whatever `containComposeServices` gives the
  project's own services. Req 24 is one decision covering the install container,
  the CLI invocation container and services, and closing it on one surface alone
  is how the three drift — in particular, joining a plugin container to the
  agent's network namespace would re-expose the worker's loopback credential
  broker and break req 19.

  **A project that declares plugins and no `compose:` block of its own still
  gets their services** (req 5's "one declaration"). It then has NO project
  compose file — not "one that may be missing": keying it on whether a
  conventional `docker-compose.yml` happens to exist would start a stack the
  project never declared, and the collision domain would not know about those
  services either. The generated override is the whole stack.

  **The project's compose file is re-validated before every `up`, not only at
  start.** A plugin service gets `/project` read-write (reqs 18, 21), so
  third-party code can now rewrite that file — and a manual start, a restart,
  an OOM or install retry, and the gate release all re-read it from disk. Left
  as it was, the rewritten file would run with none of the checks it was
  admitted under: `privileged: true`, a Docker-socket bind, an absolute host
  path. Every `compose up` in the manager goes through one function, which is
  where the check lives.
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

  **The mounts are implemented** (`plugin-compose.ts`): the state directory
  read-WRITE and the settings file read-ONLY, at the paths
  `shared/plugin-contract.ts` fixes, as absolute **daemon-side** bind sources —
  the same translation `plugin-overlay.ts` does and the staged secrets
  entrypoint already relies on (planning#287), since the daemon resolves a bind
  source and the orchestrator's own view of the session tree is not the daemon's.
  The settings file is mounted only once it EXISTS: a bind source that does not
  is created by the daemon as an empty directory, which would leave a directory
  where the next validated write expects a file.

  **And the port pin is implemented** (`plugin-ports.ts`), by adding the one
  piece it needs to be more than a wish: an **indirection**. Pinning the number
  alone would have moved the origin off the container the moment a fragment
  changed its port. So a plugin service now carries two — the pinned
  `publishedPort`, which is what the preview subdomain, the health probe and the
  browser's service list all use, and the `port` the container actually serves
  on, which follows the fragment. `ServiceManager.resolvePreviewTarget` maps one
  to the other and the proxy asks it, so the origin holds while the traffic
  follows the container. For a project service the two are always the same
  number: its compose file is the user's, so a change to it is a change the user
  made. Allocation prefers the service's own port, falls back to a band, and
  treats the project's ports as reserved — of the two, only a plugin's origin is
  ShipIt's own bookkeeping to move. The pin lives at
  `<sessionDir>/plugin-ports.json`, outside the reclaimable state dir, for the
  reason the state directory is: rebuilding it IS the origin change req 18
  forbids.

  **Seeding the pin from the fragment's own port was a mistake, and #2325 is
  it.** A plugin service that declares 5173 gets 5173 as its published port
  whenever that number "looks free" — and "looks free" was answered by the
  plugin resolver's own, separate parse of the project compose file
  (`readProjectServices`), which disagrees with the parse the stack actually
  runs whenever a watcher fires mid-write, `shipit.yaml` re-points
  `compose.file`, or a round resolves before the file is written. Two services
  then claim one routing key, `resolvePreviewTarget` answers with the first, and
  the plugin's preview origin serves the PROJECT's app. The consuming project
  cannot fix it: the number comes from the plugin's fragment, and `overrides`
  offer `autostart` and `as`, neither of which is a port. 5173 being the Vite
  default makes this ordinary rather than exotic.

  **The correction is planning#395, and it is a deletion**: a plugin fragment
  stops declaring `ports:` altogether, and the port becomes the consuming
  project's — which is where it belonged, since only the consumer knows what its
  own stack already uses. A plugin can then no longer *arrive* holding a number,
  which is the collision this bug is. It does not by itself make every preview
  address unique — a consumer can still assign one number twice, and what ShipIt
  does about that is an open question on that doc, not something ownership
  settles. It also puts the two-number scheme above in question: the pin exists
  because a tracked commit can move the fragment's port behind the consumer's
  back, and under planning#395 it cannot.

  Until then the ambiguity is real, and `warnOnAmbiguousPreviewPorts` reports it
  on every start — for this case and for the one planning#395 does NOT address,
  the project declaring one container port on two of its own services (legal
  Compose; ShipIt moves neither, since a project service's port is its origin
  *and* its container port and both definitions belong to the person who can
  change them). The two surfaces do now count a mapping's ports through one
  shared derivation (`declaredContainerPorts`), so they cannot at least disagree
  about what a mapping *means* — every entry of a service, not just the first,
  because a service listening on two answers on both.

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

  **Mounting it is a volume subpath, not a bind.** In production the session tree
  lives inside the named workspace volume, so a session path has to travel as a
  volume mount with `VolumeOptions.Subpath` relative to the volume's root; a plain
  bind of the orchestrator's `/workspace/...` path silently gets an empty
  root-owned directory, which dev and dogfood never show (CLI-slice review
  finding). Every other `Subpath` mount in this repo is a **directory** subpath
  (`container-lifecycle.ts`, `compose-generator.ts`) and this one is a **file**,
  which raised the question of whether the Engine supports it at all.

  **It does — settled at the daemon's source, not by inference.**
  `VolumeOptions.Subpath` resolves through `safepath.Join`, whose
  `tempMountPoint` fstats the resolved path and branches on `S_IFDIR`: a directory
  gets `os.MkdirTemp`, and anything else gets `os.CreateTemp` — a regular file. A
  regular-file subpath is explicitly supported rather than incidental. The version
  floor is API 1.45 (Engine 26); docs/263 already requires Engine 28 / API 1.48
  for contained Compose services, so every runtime that can host a plugin service
  is above it.

  The alternative, kept because an eventuality understood is cheaper than one
  rediscovered: were a runtime ever to refuse a file subpath, **no layout change
  is needed** — mount `<sessionDir>/plugin-data/<alias>`, a directory, read-only
  and point `SHIPIT_SETTINGS` at `<mount>/settings.json`. The plugin then also
  sees a read-only view of its own state directory under that mount, which is the
  same data it already has read-write at `/plugin-state`, so nothing is exposed
  that was not already. What must NOT be done instead — the load-bearing half —
  is moving the settings file *into* the state directory so one mount serves both:
  that directory is writable by plugin code, and a plugin that can rewrite its own
  validated settings has settings that were never validated.

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

  **Implemented** (`shared/plugin-cli.ts`, `session/plugin-cli.ts`,
  `orchestrator/plugin-cli-run.ts`, `orchestrator/plugin-commands.ts`, plus
  `shipit plugin exec`). The shape, end to end: a generated wrapper in
  **`/plugin-bin`** on the agent's PATH execs the `shipit` shim, which relays
  `POST /agent-ops/plugin/exec` to the orchestrator, which builds the invocation
  container. The wrapper's whole body is `exec shipit plugin exec --alias …
  --command … -- "$@"`; it never names the plugin's entrypoint, so the agent
  container holds no plugin path, no plugin credential, and nothing to execute.

  **The wrapper directory is APPENDED to PATH, never prepended** — and that is
  the second line of defence, not the first. The first is that a name already
  resolvable on PATH is refused outright (below); appending means that even if
  that check is ever wrong, a plugin still cannot shadow `git`. It is on PATH in
  two places for the reason docs/248 needed two: the worker appends it to
  `process.env.PATH` for everything it spawns, and a baked
  `/etc/profile.d/11-shipit-plugin-bin.sh` re-appends it inside login shells,
  because Codex runs every tool command as `bash -lc` and Debian's
  `/etc/profile` overwrites PATH outright. Without the second, a plugin command
  would work under one backend and be `command not found` under another — the
  same backend-dependence req 22 rules out for skills.

  **Credential delivery reads the credential slice's single definition.**
  Which declared names count as *satisfied* is decided once
  (`loadSatisfiedPluginCredentialNames`: `SecretStore` only, keyed by the
  CONSUMING session's remote, non-empty values only — req 23's last sentence,
  held by construction). Delivery consumes that answer and then reads the value
  for exactly those names, rather than re-deriving the rule, so the card cannot
  say "satisfied" while the container gets nothing, or the reverse. The dep is
  typed as `loadSecrets` alone, so `CredentialStore` — ShipIt's own GitHub
  identity, tracker tokens and agent routes — does not fit the parameter.

  **Collision policy (req 20): a contested name refuses EVERY claimant.**
  First-declared-wins is what the requirement rules out — it is silent
  last-one-wins with the order reversed, and the loser's author cannot tell
  their command never ran. So neither claimant gets a wrapper, and the card
  names both aliases and the `overrides.commands.<x>.as` that resolves it.
  (Repo-name collisions upstream DO use first-declared-wins; the difference is
  deliberate — there the loser is dropped whole and says so, here both imports
  stay live and only the one contested name is withheld.) Three domains are
  checked: cross-plugin claims, a short **reserved** list (`shipit`, `gh`,
  `git`, the shell, the package managers), and **what the agent container's
  PATH already resolves**. The first two are pure, so the Plugins tab
  recomputes them from the declaration plus the live manifests and can report a
  collision before anything has run; the third is checked where PATH is real.
  The plan is derived once, in a pure module both sides call, so the surface
  that *reports* and the surface that *writes* cannot disagree — and it is
  re-derived a third time **at the run boundary**, because a wrapper is a file
  and the declaration can change under it.

  **What the invocation container gets**: the generation's overlay volume at
  `/plugin`, read-only (the same merged checkout+install-output the installer
  produced — under `repo: self` the session's own working tree instead, live and
  writable per req 27; the rule both surfaces follow is stated under "`/plugin`
  is writable exactly when it is the project" below), the project workspace at
  `/project` and as the cwd, this
  import's state directory at `/plugin-state`, its validated settings file
  read-only at `/plugin-settings.json`, `SHIPIT_PROJECT_DIR` /
  `SHIPIT_PLUGIN_STATE` / `SHIPIT_SETTINGS` / `SHIPIT_PLUGIN_COMMIT` (the last
  unset under `repo: self`), and **only the credential names the plugin
  declared**, resolved from the consuming project's own store (req 23). A
  declared name with no stored value is omitted rather than sent empty, so a
  missing key stays a named gap on the tab instead of surfacing as a
  third-party authentication error. Everything else matches the install
  container: worker image with its ENTRYPOINT bypassed, no inherited
  environment, all capabilities dropped, `no-new-privileges`, memory and PID
  ceilings, a timeout, and **its own untrusted-registered network** — that last
  one shared with install through `plugin-container.ts`, because "not the
  session's network" is not enough and a second, slightly different copy of a
  security control is how the two drift.

  Three smaller decisions, each of which had a wrong-looking cheaper option.
  The agent's **cwd is carried across**: a cwd inside `/workspace` becomes the
  matching path under `/project`, and anything else falls back to the project
  root — Docker *creates* a missing `WorkingDir`, so passing one through
  unchecked writes a stray directory into the user's repository. Output is
  **buffered, not streamed**, with an 8 MiB per-stream cap that announces its
  own truncation; streaming through two relay hops is real machinery and the
  plan already accepts per-call latency here. And the **trust gate** (docs/178)
  is re-read on every call, not at wrapper-generation time: a repository
  un-trusted since the wrapper was written must stop executing, and this is the
  only place that can notice.

  One thing this slice does **not** settle, found by the independent review and
  cross-slice. (The other — a refresh deleting a generation out from under a
  running mount — is now closed by the consumer lease, §2 below; the invocation
  holds its pinned generation for the whole call, so "a CLI invoked mid-refresh
  runs the old generation" is true rather than aspirational, and a call that
  resolves a generation the pruner has already claimed is refused with "run the
  command again" instead of mounting a tree that is being removed.)

  **Egress.** The invocation container has its own network with unrestricted
  outbound — which is what `install` already has and what plugin *service*
  containers have today. So req 24's enforcement question now covers three
  surfaces rather than two, and it stays one decision, not three. Joining a
  plugin container to the agent's network namespace is **not** the fix: it
  re-exposes the worker's loopback credential broker and breaks req 19.

  And one accepted limitation, not a gap: output is buffered, so a long-running
  command shows nothing until it exits.

  **Every refusal reaches the card, by two different routes, and that split is
  the design.** Cross-plugin collisions and reserved names are **recomputed** by
  the snapshot from the declaration plus the live manifests, so they are visible
  before anything has run. The third domain — a name the agent container's PATH
  already resolves — is knowable ONLY inside that container, so it rides the
  `/plugins/prepare` response as `commandsRefused` / `commandsFailed`, each
  attributed to its declared repository, and lands through
  `readPrepareFailures` on the same card channel `skillsFailed` and `linkFailed`
  use. An unattributed entry is dropped rather than rendered on no card, which
  is that channel's existing rule.
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

  **`active` is followed ONCE per pass, and the concrete generation directory
  is what travels.** Prepare used to hand the unresolved `<store>/<name>/active`
  path downstream, where the manifest read and then the containment check
  followed it again — two re-follows, not more: the check returns the *resolved*
  target, so the per-skill copies were already concrete. Publication swaps that
  symlink atomically, so a refresh landing between those two produced a pass
  describing two generations, the manifest naming skills from A and the files
  copied from B. The containment check made the narrowest case worse than a torn
  copy — it resolves base and target independently, so a swap between those two
  `realpath` calls left the base in B and the target in A and reported the
  plugin as resolving outside its own checkout, a security-shaped message for an
  ordinary refresh. Resolving once per repository per pass means a pass never
  mixes two generations; the newer one arrives with the next prepare, which
  every activation round fires.

  Two honest limits on that. A pin fixes the *path*, not the directory it names:
  publication prunes the generation it replaces, so a pass pinned to A can find
  A deleted mid-copy and report a write failure. That is the trade — the
  unpinned code silently copied B instead, and a bounded, visible, self-healing
  failure is what req 13 asks for. And this pins only the READ side:
  `/plugins/<name>` still points at the unresolved `active` on purpose, so the
  agent sees a new generation with no re-link (the "mount the store, not the
  generation" rule above). The consequence is a transient divergence — between a
  refresh's swap and the next materialization, a turn can browse B's checkout
  while invoking A's copied skills. Linking the concrete generation would close
  it by giving up refresh-without-recreation, which costs more than the window
  does.

  **The whole pass shares that one resolution.** It did not at first: the pin
  landed in the skills half while the companion-CLI half kept resolving
  `<store>/<name>/active` itself and reading the manifest through the
  unresolved link, so one prepare result could name commands from generation B
  beside skills from A. `preparePluginCommands` now takes the resolved
  directory from the caller (`checkoutFor`) and reads the store nowhere, which
  is also what let the identity check below reach all three halves at once
  rather than being written three times.

  **The rule is narrower than "resolve `active` once everywhere", and stated
  wrongly it breaks things.** It targets reads whose results are *compared or
  combined as if they came from one generation*. A read that must observe a
  CHANGE is excluded by construction: `services/plugin-refresh.ts` snapshots
  each repository's commit before `activateDeclaredPlugins` and reads it again
  after, and `after !== was` is the entire activated/unchanged determination;
  collapsing that pair would make every refresh report `unchanged`. So is a path
  that must FOLLOW a later swap, which is why `/plugins/<name>` stays
  unresolved. Verified at the source; the classification is the req 10 slice's.

  This is a rule about one operation's reads, not about every store path — and
  it is about the READS. `/plugins/<name>` still points at the unresolved
  `active`, so the verified directory deliberately does not travel through the
  link half; what travels there is the decision of whether to link at all.

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

    **A link whose generation was retired is dropped, and that is not the same
    as a stale one.** `removeStaleLinks` removes links for names the declaration
    no longer has; re-pointing a `repos:` entry keeps the name and retires what
    the PREVIOUS repository left, before the fetch that may then fail. So the
    link survived pointing at nothing, and `/plugins/<name>` listed while being
    unreadable — presence claiming a plugin the card was simultaneously
    reporting as unavailable. It is removed in the same pass that reports the
    repository as `missing`, under `linkPlugin`'s ownership rule (the link must
    point exactly where we would have pointed it, so a foreign or real entry is
    left alone even when broken), and silently: `missing` already carries the
    user-facing fact, and calling it `unlinked` would claim the declaration
    dropped a repository it still names. Self-healing — the next prepare
    re-links as soon as a generation is published.

    **The container checks identity too — it is not left to retirement.** The
    orchestrator's readers refuse a generation whose recorded source does not
    match the declaration; this half had no record check at all, so the
    generation the card correctly refused was still the one the agent got. The
    window is not a symlink swap: `retireForeignGeneration` clears `active`
    inside an activation round, and that round is fire-and-forget behind a git
    fetch and possibly an install — minutes, or forever if the fetch fails. The
    concrete case is a `repos:` entry re-pointed at a private repository whose
    fetch fails: the card says failed with no commit, while the container was
    still mounting the previous repository's tree, still materializing its
    SKILL.md files into the agent's skill roots, and still listing its command
    names on PATH.

    Skills are the sharpest of the three. A checkout under `/plugins/<name>` is
    files the agent may read; a materialized skill is **instructions it
    follows**, from a repository this project's declaration no longer names —
    and req 19's standing grant covers the repository the declaration names and
    no other.

    So `preparePlugins` resolves `active` once per declared repository and
    compares the generation record's `source` against
    `destinationKey(repo.source)`, treating a mismatch exactly as "nothing
    live" — the branch all three readers already had. One resolution shared by
    all three halves is what makes the pass answer for one generation AND one
    repository; a per-half check would drift the same way the freshness half
    did. **A record with NO source is refused for the same reason a foreign one
    is:** nothing can prove whose it is. The orchestrator deliberately keeps
    such a generation rather than deleting it — deleting would drop every
    plugin in every live session on the first deploy, ahead of a fetch that may
    fail — so refusing to expose it is what makes keeping it safe. The cost is
    stated rather than hidden: after this deploys, an existing session's
    plugins read as unavailable until the next successful activation
    republishes them with a source, which is the same round that would have
    refreshed them anyway.

    **A refusal says why.** `missing` never leaves the worker — the orchestrator
    ingests only the failure lists — so a refused repository would otherwise
    render as a bare `unavailable`, which is the wrong story: something IS
    published, it is just not this declaration's. Usually the activation that
    caused it reports its own error, but that is transient in-memory state and
    there are mismatch cases with no current error at all (an orchestrator
    restart, or no round having run). So the refusal is pushed as an attributed
    reason naming the repository the version actually came from, or saying
    plainly that a legacy version cannot be confirmed as this one's. And a
    withdrawal that FAILS is reported rather than swallowed: this path exists to
    stop the agent reaching a tree it may not use, so "could not take it away"
    is the one outcome the card must not render as a clean unavailable.

    **Scope, stated precisely, because "the agent cannot see it" would be
    false.** What this guard controls is the MANAGED surfaces — the
    `/plugins/<name>` link, the materialized skills, the wrapper names on PATH.
    The plugin store itself is mounted read-only in the container, so an agent
    with a shell can still read `/plugin-store/<name>/active` directly. That is
    unchanged by this work and is the mount's own design (plan §2); the claim
    here is that ShipIt stops PRESENTING a foreign version as this project's
    plugin, not that the bytes become unreachable.

    Two further limits, both inherent rather than deferred. **Withdrawal happens
    on the next prepare, and prepare runs when an activation round settles** —
    so between a `shipit.yaml` edit and that round finishing (a fetch, possibly
    an install, possibly a failure) the previous artifacts are still in place,
    and a slow repository delays the withdrawal for every repository in the
    round. Running one prepare immediately on a declaration change would narrow
    it, and that is an orchestrator-side trigger rather than a container-side
    check. And **an already-running container keeps the code it started with**:
    a session container that predates this guard does not acquire it from an
    orchestrator upgrade, so the guarantee is about containers started after it,
    plus whatever container recreation the upgrade performs.

    The record format lives in `shared/plugin-generation-record.ts` rather than
    in the container: `src/server/session/` cannot import
    `src/server/orchestrator/` (the ESLint boundary, type imports included), so
    a container-local copy would be a second implementation of a format only
    one file writes. It exposes only the `source`, because that is the only
    question this side asks — a reader that also returned the commit would
    invite a second question (what a malformed `commit` should mean) with no
    bearing on the decision. It fails closed: not JSON, not an object, an array,
    or a non-string `source` all read as "no source", because a corrupt file
    must not be able to decide that a foreign checkout is this declaration's.
    Folding the orchestrator's own reader into it is a follow-up for whoever
    next owns that file.
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

    A repository that is still DECLARED but identity-refused is a different
    case, because it does have a card: the link withdrawal reports its own
    failure there. The skill and wrapper sweeps still only log theirs, so a
    materialized skill or a wrapper that cannot be removed leaves the agent
    holding an artifact of a version the card says is unavailable. That is the
    remaining fail-open in this half, and it wants the sweeps to return
    attributed failures the way the write paths already do — a change to two
    more return types rather than a new surface.
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
| Needs — hosts (req 24) ✓ | tab mock 1 | The plugin card's needs rows, over the existing `POST /api/egress/hosts` (global or session scope; browser-only) | **Built**, and the design-era text below was overtaken twice. All three execution surfaces are now bound by the same allowlist (`containComposeServices` for services, `plugin-egress.ts` for the CLI and install containers), so the row no longer hedges across them — though it still names the claiming plugin, because req 24 asks for req 23's grouping. The bigger change is that the card asks ONE predicate, `orchestrator/egress-host-reach.ts`: **can this host be made reachable at all, and by whom** — `allowed`, `grantable`, `blocked-by-session` (docs/211's Network-off sandbox, which carries no user hosts), `blocked-by-deployment` (`SESSION_EGRESS_DNS=0`, where the fixed Tier A floor is the whole reach of every contained session). The two `blocked-*` verdicts render as ONE row with **no button**, because there every grant writes a durable entry that changes nothing (planning#383). The same predicate answers the grant route's outcome report and the Tier C decision route's card rule, so the surface that offers a grant, the one that reports what it did, and the one that decides whether to prompt cannot disagree — the consolidation planning#377/#380/#383 argued for, each of which was one surface being optimistic about a different thing. Grant endpoints stay browser-only, so plugin code cannot self-grant. Original design-era note, kept because it records why the row names a claimant: "Host not allowed" was evaluated against the **agent container's** allowlist alone, since containment then lived only in the agent's netns (round-two finding 4) |
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
  **A generation records the repository it came from, not only the declaration
  name.** Every on-disk path is keyed by the name, and a name is re-pointable:
  moving `tools` from `acme/old` to `acme/new` left the old repository's
  generation live under the new declaration, so the Plugins tab, the feedback
  footer and `SHIPIT_PLUGIN_COMMIT` all reported the new repository at the old
  repository's commit. `readActiveGeneration` therefore takes the expected
  source (required, not optional — an optional check is one every caller can
  forget) and reads a foreign generation as absent. Reading it as absent is only
  half: while the `active` symlink resolves, the container's prepare pass keeps
  linking `/plugins/<name>` at the old files, so a re-point also RETIRES what the
  previous repository left — before the fetch that can fail. req 15's "the prior
  generation stays live" means the prior generation of THIS plugin; another
  repository's files are not a degraded version of it, so a re-point whose new
  source fails reads as unavailable. **Both readers take the expected source**:
  `readActiveManifest` resolves through the same symlink, so a re-pointed
  declaration would otherwise validate a consumer's selectors, settings and
  declared credentials against the PREVIOUS repository's manifest.

  **One resolution per repository per operation** (`resolveLiveGenerations`).
  Five readers answer for the same card on one snapshot request — the commit,
  the manifest behind the settings verdict, the one behind the command verdict,
  the credential names, and the compose fragment — and each used to follow
  `active` itself, so a refresh landing mid-request could compose ONE card from
  several generations. The request now resolves each declared repository once
  and hands every reader that verified `{dir, record}` handle; the service build
  does the same, so a fragment and the tree its services mount cannot disagree.
  Two properties come with it: the identity check runs where the link is
  resolved rather than once per reader, and `readActiveManifest`'s own three
  traversals collapse to one.

  The lookup resolves a repository on **first ask**, not for the whole list up
  front. The guarantee the readers need is per-repository — the facts one card
  or one mount states about one repository come from one generation — and
  memoizing gives that; pinning every repository at a single instant would
  additionally cost a resolution for repositories the operation never reads.
  `plugin-cli-run.ts` is why that matters and not merely tidier: it builds the
  lookup for the collision verdict over the OTHER imports while `pinGeneration`
  pins its target separately (that pin also names the volume and the lowerdir),
  so resolving the list up front followed the target's `active` a second time
  for an answer it discarded — a review found it, and a test in
  `plugin-cli-run.test.ts` now holds that count at one.

  **What is NOT in that rule, because each of these breaks if it is folded in:**
  a read whose subject IS the change (`plugin-refresh.ts`'s before/after pair,
  `plugin-activation.ts`'s pre-activation read — collapse them and every refresh
  reports `unchanged` and the card names the new generation as the one it is
  replacing); a stored path that must FOLLOW a later swap (`/plugins/<name>`
  links the unresolved `active` on purpose); and an operation that already
  resolves once (the feedback footer, whose residual window is between its read
  and the GitHub POST and is what "what this session was running" means). The
  rule is stated where a new reader will meet it — beside the directory-scoped
  readers, which carry no identity check and are safe only on a directory the
  resolver returned.
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
- ✓ `src/server/orchestrator/plugin-leases.ts` — the consumer lease over a live
  generation (req 15): the in-process hold both plugin surfaces take, and the
  deletion claim publication takes before it removes anything. Two facts, one
  module, because a service-only or CLI-only version leaves the other exposed
  and creates a second mechanism to reconcile. The hold and the claim are
  deliberately **synchronous** — a consumer resolves `active` and holds what it
  resolved in one block, and a pruner claims before it awaits anything, so
  neither can slip between the other's check and act. Also owns the Docker half:
  removing a superseded generation's volume is part of taking permission to
  delete the directories under it. Injected into `activateGeneration` as
  `beginGenerationDeletion` from `bootstrap-managers`, for the same reason
  `runInstall` is — the generation engine holds no Docker client.
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
- ✓ `src/server/shared/plugin-cli.ts` — the pure command plan (reqs 17, 20):
  which commands a session surfaces, and which it refuses because the name is
  ambiguous. Filesystem-free, because the orchestrator reports the refusal on
  the card and the session writes the wrappers, and the two must not disagree.
  ✓ `src/server/orchestrator/plugin-commands.ts` feeds it the live manifests
  through `plugin-state.ts`'s resolver, so the snapshot GET recomputes refusals
  rather than remembering them. ✓ `src/server/session/plugin-cli.ts` adds the
  one input only it has — what the agent container's PATH already resolves —
  and writes/sweeps `/plugin-bin`, marker-checked so nothing it did not write
  is ever touched. ✓ `src/server/orchestrator/plugin-cli-run.ts` is the
  invocation container; ✓ `plugin-container.ts` holds what it shares with
  install (the untrusted network, the bounded wait).
- ✓ `src/server/orchestrator/plugin-compose.ts` — the fragment edge (reqs 3, 5,
  16, 20): locate each import's fragment in whatever is live for it, validate it
  under the consuming session's own rules plus the plugin-edge allowlist, apply
  the consumer's `as`/`autostart` overrides, check the one name domain across the
  project and every plugin, and re-emit each service with its relative sources
  rewritten onto the plugin's own tree and ShipIt's mounts and environment
  attached. Pure apart from filesystem reads, which is what lets the snapshot GET
  report exactly what the service path would refuse. ✓
  `services/plugin-services.ts` is its lifecycle half — the runtime overlay
  volume, the published ports, and the failures nothing can recompute — called
  before the first `start()` and again whenever an activation round settles,
  which is what makes `shipit plugin refresh` reach a running service.
- ✓ `src/server/orchestrator/plugin-ports.ts` — the published-port pin (req 18),
  at `<sessionDir>/plugin-ports.json`. Deliberately outside the state dir, which
  eviction reclaims: rebuilding a pin is the origin change the requirement
  forbids. `ServiceManager.resolvePreviewTarget` is the indirection that makes
  the pin more than a wish, and `preview-proxy.ts` asks it on all three paths
  (HTTP, the HMR upgrade, and the health probe). **Seeding the pin from the
  fragment's declared port is what #2325 turned out to be**, and planning#395
  removes it at the source by making the port the consuming project's to declare
  — which may take most of this file with it.
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
- ✓ `src/server/session/agent-shim/shipit-plugin.ts` + the worker agent-ops
  relay routes — the agent's `shipit plugin refresh` and `shipit plugin exec`
  transports (orchestrator API routes are container-denied; the shim goes
  through the worker like `shipit issue`). `exec` is the target of every
  generated wrapper rather than a verb an agent types, and it is a pipe: the
  plugin's argv survives `--` untouched, its streams are undecorated, and its
  exit code is the shim's.
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
  needs plumbing (`secrets_status` origin, egress rows), and — via the
  consumer fixture — checkout/generation mechanics and `shipit plugin
  refresh` through the agent-ops relay (which local mode's explicit route
  allowlist must admit; see §2).

  **Corrected twice on implementation, both times by driving it.**

  First: CLI *execution* is not in the inner loop. Running a companion CLI
  needs the invocation container (§2), and local mode has no Docker — so
  `shipit plugin exec` there answers "this runtime cannot run plugin commands"
  rather than pretending. Execution itself — the mounts, the credential
  injection, the boundary — is covered by co-located tests over a fake daemon
  and, end to end, on a real instance.

  Second (2026-08-14, #2263): **CLI wrapper generation and skills
  materialization are not in the inner loop either**, and the list above used
  to claim they were. Both live in `session/plugin-runtime.ts`, which runs in
  the session worker; `emitPluginReposUpdated` reaches them through
  `container.preparePlugins?.()` — an *optional* property, optional precisely
  because the local runner has none. So the dogfood exercises everything up to
  the container hand-off and nothing past it. They were driven instead by
  invoking `preparePlugins` directly against each inner session's real
  workspace with temporary output directories, which is honest about what it
  covers: real declarations, real generations, real manifests, no container.

  One more measured limit, so the next reader does not re-derive it:
  `Dockerfile.dogfood` installs the `gh` shim and deliberately **not** the
  `shipit` one (planning#305). Admitting `plugin/refresh` in local mode's
  route allowlist is therefore necessary but not sufficient — the verb is
  drivable over HTTP, not through the shim, until that decision changes.
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
mechanics. *(Install execution, skills materialization, PATH wrapper generation
plus its credential injection, GitHub App multi-repo minting, and — with the
service slice — compose-fragment merging, its security validation and port
stability have since been built: see §1b, §2's Services, CLIs and
fetch-authority bullets, `plugin-fetch.ts`, and §4's ✓ entries.)*

Known v1 limits of the service path, each with its reason above rather than as
an oversight: a fragment may not declare `build:` (the merged plugin tree is a
Docker volume, which cannot be a build context); it may not declare named
volumes (`/plugin-state` is the home with a lifetime ShipIt guarantees); and
plugin **service** containers ride the session's existing egress posture, since
whether they get containment of their own is still req 24's open decision (§3's
needs-row note), taken once across all three surfaces rather than per surface.
