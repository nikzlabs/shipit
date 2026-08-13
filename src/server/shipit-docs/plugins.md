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
      alias: reqs              # optional local name (default: the plugin name)
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
shown in the Plugins tab. Browse it and read it.

**It is read-only, deliberately.** Fix a plugin in the plugin's own
repository, then let this project pick the change up — not by editing the
checkout here. Your edit would apply to this one session, vanish on the next
refresh, and reach nobody.

The path follows the live generation. When a plugin repository is refreshed
mid-session, `/plugins/<name>` points at the new commit with no restart.

## Plugin code does not run in your container

Everything a plugin *ships* — its `install`, its CLIs, its services — runs in a
separate container, with only what it declared: the checkout, its own writable
layer, its own credentials. `install` works this way today; CLIs and services
are not built yet.

This is not tidiness. Your container can reach ShipIt's own credential broker
on loopback, so anything running here can obtain a real GitHub token. Plugin
code comes from another repository, so it runs where that is not reachable.
Expect the same rule to apply to plugin CLIs when they land: the command on
your `PATH` will be a ShipIt wrapper, and the plugin's own code will run
elsewhere.

The practical consequence for you: `/plugins/<name>` shows plugin **source**.
It does not show a plugin's installed dependencies, because those live in a
layer that belongs to the plugin's own execution environment, not to yours.

## Install

A plugin's `install` command runs once per commit, in a container that holds
one thing: the plugin's checkout merged with its own writable layer. It runs
**before** the new commit goes live, so an install that fails is simply a
failed refresh — the previous commit stays active and the Plugins tab reports
why, with the command's own output.

You will not see the result. Dependencies and build output land in that
writable layer, which belongs to the plugin's execution environment; your
`/plugins/<name>` still shows plain source.

## Skills

A plugin can ship skills. ShipIt copies each imported plugin's skills into
this session's skill directories, so you discover them exactly like the
project's own — namespaced `plugins--<alias>--<skill>` so two plugins can ship
a skill with the same name.

They are **not part of the project**. ShipIt keeps them out of git for this
clone, so they never appear in a diff or a commit, and the project never holds
a copy that has to be kept in sync. Do not edit them: a refresh rewrites them
from the plugin repository, and your change would reach nobody. Fix the skill
in the plugin's own repository instead.

Removing the `use` entry removes the skills.

## Failure behaviour

A plugin repository that cannot be fetched or validated does not stop the
session. It opens, and the Plugins tab reports the repository as unavailable,
or as degraded with the previous commit still live. Each declared repository
succeeds or fails on its own.

## Not built yet

Declared in the manifest and parsed, but not yet wired into a session:

- **CLIs** on your `PATH`, with the plugin's credentials injected
- **Services** from a plugin's compose fragment, and `/project` inside them
- **Settings** (`SHIPIT_SETTINGS`) and the per-plugin shared state directory
- **`shipit plugin refresh`**
- **`repo: self`** — parsed and shown, but it activates no checkout yet

Declaring any of these today is harmless: they are validated, surfaced in the
Plugins tab, and ignored otherwise.
