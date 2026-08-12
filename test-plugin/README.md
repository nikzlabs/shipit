# test-plugin — the docs/262 fixture

The deliberately tiny plugin that drives the plugin-repositories
implementation (docs/262-plugins/plan.md §5): one service, one CLI, one
skill, one setting, one credential name, one host. Each export is a **probe**:
it checks one part of the usage contract (plan §2) and reports what it finds,
so a contract regression shows up as a changed report field, not a guess.

Exercised through two fixtures, because self-use deliberately has no
checkout, generations, or refresh (req 27):

- **self-declared** — this repo's own `shipit.yaml` declares `repo: self`
  (name `shipit-dev`) and uses the `probe` plugin: the live working-tree
  path. `checkout.writable` must report `true` here.
- **consumer-declared** — a consuming project (the inner dogfood instance)
  declares this repo by `owner/name`: the checkout / generation / pin /
  refresh path. `checkout.writable` must report `false` here.

Layout:

- `docker-compose.yml` — the compose fragment (service `probe`, port 4820)
- `cli/probe.mjs` — the exported `probe` command (JSON report; `--host-check`)
- `service/server.mjs` — the report from the service surface + shared counter
- `lib/report.mjs` — the one report builder both surfaces share
- `install.mjs` — the manifest's `install`; stamps `.install-stamp.json`
  (gitignored) with the active commit
- `skills/probe/SKILL.md` — the exported skill

Everything is dependency-free Node, runs today without the feature (missing
contract pieces report as absent), and stays outside `src/`, so tsc, eslint,
and vitest never see it. The manifest lives in the repo root `shipit.yaml`
under `exports.plugins.probe`.
