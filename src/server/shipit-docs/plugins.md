# Plugin repositories

A project can consume tools that live in **another repository** — services,
CLIs, skills, and settings — by declaring that repository in its own
`shipit.yaml`. ShipIt checks the plugin repository out beside your session and
makes it available inside this container. You never clone it, vendor it, or
copy anything from it into the project.

This page describes **what exists today**. Parts of the design are not built
yet; they are called out explicitly at the end rather than implied.

## Declaring a plugin repository

Two blocks, both optional, in the consuming project's `shipit.yaml`:

```yaml
plugins:
  repos:
    - repo: acme/dev-tools     # owner/name on GitHub, or `self`
      name: tools              # the local name, used everywhere else
      branch: main             # or `pin: v1.2.0` / a full SHA — never both
  use:
    - plugin: requirements     # an export the repo's manifest declares
      from: tools
      as: reqs                 # optional alias
```

The plugin repository declares what it exports, in **its** `shipit.yaml`:

```yaml
exports:
  plugins:
    requirements:
      compose: plugins/requirements/docker-compose.yml
      cli:
        reqs: plugins/requirements/cli
      skills: plugins/requirements/skills
      install: npm ci
      install-inputs: [package-lock.json]
      credentials: [FAL_KEY]     # names only — values live with each project
      hosts: [fal.run]           # informational
      settings:
        root:
          description: Directory the plugin reads and writes
          default: docs
```

Declaring a repository is a standing grant: ShipIt fetches and activates it
with no prompt on every session. The Plugins tab always shows which repository,
which ref, and which exact commit is live — that visible identity is what the
grant trades approval for.

## What you see in this container

`/plugins/<name>` is the plugin repository's checkout, at the exact commit
shown in the Plugins tab. Browse it, read it, run things from it.

**It is read-only, deliberately.** Fix a plugin in the plugin's own
repository, then let this project pick the change up — not by editing the
checkout here. Your edit would apply to this one session, vanish on the next
refresh, and reach nobody.

The path follows the live generation. When a plugin repository is refreshed
mid-session, `/plugins/<name>` points at the new commit with no restart.

## Environment

A plugin's own code — its `install`, and later its CLIs and services — runs
with:

| Variable | Meaning |
|---|---|
| `SHIPIT_PROJECT_DIR` | The consuming project's workspace (`/workspace`) |
| `SHIPIT_PLUGIN_COMMIT` | The exact commit of the live checkout. **Unset** when the plugin runs from a live working tree (`repo: self`), which has no exact commit |

## Install

If a plugin declares `install`, ShipIt runs it inside this container with
`cwd` set to that plugin repository's checkout root, so `node_modules` and
build output land in the disposable per-session checkout rather than in your
project.

It re-runs when — and only when — the commit, the install string, or the
content of the declared `install-inputs` changes. A failed install is not
recorded as done, so it is retried rather than silently skipped.

Install runs with the same authority `agent.install` has. It deliberately does
**not** receive ShipIt's repository-fetch credentials: those live in the
orchestrator and never enter this container at all, so plugin code cannot use
them to reach anything.

## Failure behaviour

A plugin repository that cannot be fetched or validated does not stop the
session. It opens, and the Plugins tab reports the repository as unavailable,
or as degraded with the previous commit still live. Each declared repository
succeeds or fails on its own.

## Not built yet

Declared in the manifest and parsed, but not yet wired into a session:

- **CLIs** on your `PATH`, with the plugin's credentials injected
- **Skills** materialized into the agent's discovery root
- **Services** from a plugin's compose fragment, and `/project` inside them
- **Settings** (`SHIPIT_SETTINGS`) and the per-plugin shared state directory
- **`shipit plugin refresh`**
- **`repo: self`** — parsed and shown, but it activates no checkout yet

Declaring any of these today is harmless: they are validated, surfaced in the
Plugins tab, and ignored otherwise.
