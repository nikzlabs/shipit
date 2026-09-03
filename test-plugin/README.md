# test-plugin — the docs/262 fixture

The deliberately tiny plugin that drives the plugin-repositories
implementation (docs/262-plugins/plan.md §5): one service, one CLI, one
skill, one setting, one required credential name, one optional host. Each export is a **probe**:
it checks one part of the usage contract (plan §2) and reports what it finds,
so a contract regression shows up as a changed report field, not a guess.

Exercised through two fixtures, because self-use deliberately has no
checkout, generations, or refresh (req 27):

- **self-declared** — this repo's own `shipit.yaml` declares `repo: self`
  (name `shipit-dev`) and uses the `probe` plugin: the live working-tree
  path. The report must show `mode: self-or-unprovided` — no
  `SHIPIT_PLUGIN_COMMIT`, because a live tree corresponds to no exact commit.
- **consumer-declared** — a consuming project (the inner dogfood instance)
  declares this repo by `owner/name`: the checkout / generation / pin /
  refresh path. The report must show `mode: consumer-generation` with the
  exact commit, and `install.matchesActiveCommit: true`. (`checkout.writable`
  is not the discriminator — read `mode` — but it does check the rule
  directly: a consumer generation is read-only on every surface, a `repo: self`
  working tree is writable.)

## The dependency check — why this fixture used to be blind

Every export here imports `node:` built-ins and one relative file. That made
the fixture **structurally incapable** of noticing an empty `node_modules`, and
it is why two real end-to-end runs passed while `repo: self` was broken outright
(nikzlabs/shipit#2298: the plugin's containers saw the project's dep dirs as the
empty mount points they are on the workspace volume, so neither the companion
CLI nor the service could load a dependency the working tree plainly had).

So the report now carries a **`dependency`** field, on both surfaces. It loads
an ordinary runtime dependency of this repository (`yaml`) and reports the
attempt **per root**, because `/plugin` and `/project` are two separate mounts
even under `repo: self`, where they are one tree — a regression that restores
one and not the other has to stay visible.

Per root:

| Field | Meaning |
|---|---|
| `resolved` | the package was reachable from that root (resolution walks up, as an ordinary `import` there would) |
| `used` | it also loaded and ran — a package directory can resolve and still fail to load |
| `entry` / `version` | which copy answered |
| `error` | why not, when `resolved` is false |

What each root should say, for the **self-declared** fixture — the one step 10
of `docs/262-plugins/real-instance-e2e.md` runs:

| Surface | `project` | `plugin` |
|---|---|---|
| CLI | `true` — `/project` is the working tree `agent.install` prepared | `true` — `/plugin` is that same tree |
| service | `true` — the same `/project` mount | `false`, expected: this fragment mounts its own directory at `/app`, so nothing is reachable above it |

Anything else on the self fixture is the regression this field exists for. On
the **consumer-declared** fixture both roots are other trees — `/project` is a
different repository and `/plugin` is a generation whose `install` installs
nothing — so neither value is asserted there. (`install.matchesActiveCommit` is
a different question entirely: it reads this plugin's own install stamp against
`SHIPIT_PLUGIN_COMMIT`, and says nothing about any `agent.install`.)

It is loaded with `createRequire`, not a static `import`, deliberately: a
missing dependency has to arrive as a **changed field in a report**, not as an
`ERR_MODULE_NOT_FOUND` traceback from a process that never printed one.

## The settings check — the same blindness, on the consumer's side

`settings.greeting` was reported from the first run, and it still could not
distinguish the two things that write it. Every fixture read the **manifest
default** (`hello from the probe`), because no consumer here had ever set an
`overrides.settings` value — so a build that ignored the consumer half outright
would have produced exactly the field the doc expected. That is how
nikzlabs/shipit#2298 finding 2 came to be reported as "a consuming project
cannot set a plugin setting": the feature worked, and nothing the project ran
could show it working.

This repo's own `shipit.yaml` now sets it, to a string the manifest does not
contain:

| Where | Value |
|---|---|
| `exports.plugins.probe.settings.greeting.default` (the plugin) | `hello from the probe` |
| `plugins.use[].overrides.settings.greeting` (this consumer) | `hello from the consuming project` |

So on the **self fixture** both surfaces must report `hello from the consuming
project`. The default arriving there means `overrides.settings` was dropped.
The **consumer fixture** (the inner dogfood project) sets no override, so the
default is the right answer there — which is also the check that the merge
still applies a default rather than emitting nothing.

Note the nesting the report cannot see: `settings:` written directly on a
`plugins.use` entry, one level above `overrides:`, sets nothing. ShipIt warns
about that key and names where it belongs (`shipit plugin status`, and the
Plugins tab), but the plugin just receives the default.

Layout:

- `docker-compose.yml` — the compose fragment (service `probe`, port 4820)
- `cli/probe.mjs` — the exported `probe` command (JSON report; `--host-check`)
- `service/server.mjs` — the report from the service surface + shared counter
- `lib/report.mjs` — the one report builder both surfaces share
- `install.mjs` — the manifest's `install`; stamps `.install-stamp.json`
  (gitignored) with the active commit
- `skills/probe/SKILL.md` — the exported skill

Everything but the `dependency` check above is dependency-free Node; that one
resolves at runtime and reports its own failure, so the fixture still runs
without the feature (missing contract pieces report as absent). It stays
outside `src/`, so tsc, eslint, and vitest never see it. The manifest lives in the repo root `shipit.yaml`
under `exports.plugins.probe`.
