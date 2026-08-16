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
      overrides:               # everything the CONSUMER gets to decide
        settings:
          root: docs/specs     # a value for a setting the manifest declares
        services:
          api: { autostart: false, as: reqs-api }
        commands:
          reqs: { as: requirements }
```

**`overrides` is the consumer's whole say**, and it is one level deeper than it
looks like it should be. `settings`, `services` and `commands` go **under
`overrides:`** — writing `settings:` directly on the `use` entry sets nothing,
and ShipIt reports it on the Plugins card as an unknown key rather than failing.

A setting's value is type-checked against the plugin's declared default, so a
string setting cannot be given a number. A setting the consumer does not set
takes the manifest's default; a setting with no default and no value is simply
absent from the file.

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
      dep-dirs: [node_modules]   # what install populates; this is the default
      credentials: [FAL_KEY]     # names only — values live with each project
      hosts: [fal.run]           # informational
      settings:
        root:
          description: Directory the plugin reads and writes
          default: docs
```

A plugin reads its settings from the JSON file at `$SHIPIT_SETTINGS`, which
ShipIt writes from the manifest's defaults merged with the consumer's
`overrides.settings` above.

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

**The plugin's own code cannot write it either**, and for the same reason. A
plugin's CLIs and services see that checkout in their own containers, merged
with the plugin's writable layer, and every mount of it is read-only — at
`/plugin`, and at whatever path the plugin's own service definition mounts it
at. So what the Plugins tab says is live is what every surface of that
repository is running. The one writer is the plugin's `install`, which runs
before a commit goes live. A plugin's writable surfaces are its state directory
and this project's workspace, never its own source.

## Plugin code does not run in your container

Everything a plugin *ships* — its `install`, its CLIs, its services — runs in a
separate container, with only what it declared: the checkout, its own writable
layer, and the values for the credential names in its manifest. Both a plugin's
CLIs and its services receive those values.

This is not tidiness. Your container can reach ShipIt's own credential broker
on loopback, so anything running here can obtain a real GitHub token. Plugin
code comes from another repository, so it runs where that is not reachable.
A plugin's command on your `PATH` is therefore a ShipIt wrapper: you run it
like any other command, and the plugin's own code runs elsewhere.

The practical consequence for you: `/plugins/<name>` shows plugin **source**.
It does not show a plugin's installed dependencies, because those live in a
layer that belongs to the plugin's own execution environment, not to yours.

## What containment does not cover

**The project's own files are not a containment boundary.** `/project` is this
project's workspace, mounted read-write in a plugin's containers, and it is the
directory a companion CLI starts in — a purpose rather than a leak, since a
plugin that generates code, formats files, or records its output into the
project is the ordinary case, and a manifest's `settings` exist so this project
can say where. ShipIt does not restrict which paths inside the workspace a
plugin may write, so "it appeared under a path I did not expect" is not an
anomaly the platform will report — it is yours to notice.

**And the workspace is not only content.** `shipit.yaml` (a changed
`agent.install` is re-run), the project's `docker-compose.yml` (re-evaluated and
reconciled on change) and `.git` are consumed by the platform on its own,
whoever wrote them — a plugin, an npm `postinstall`, you. A write to one of
those is not a diff you get to read later; by the time you notice it, it may
already have run. Stop and surface it to the user.

Containment does not limit what a plugin **tells you to do**, and nothing
could. A plugin's skills are instructions you follow. A plugin CLI's output is
material you read and may act on. A plugin service serves pages the user's
browser loads. All three are the feature working as designed.

A plugin is a dependency this project declared, and a more contained one than a
package in `package.json`: its code runs in another container, which holds none
of your credentials. Read what it produces the way you read any file in the
workspace — the ordinary untrusted-input rule, and no more suspiciously than
that.

## Install

A plugin's `install` command runs in a container that holds the plugin's
checkout merged with its own writable layer, plus that repository's own package
download cache. It runs **before** the new commit goes live, so an install that
fails is simply a failed refresh — the previous commit stays active and the
Plugins tab reports why, with the command's own output.

You will not see the result. Dependencies and build output land in that
writable layer, which belongs to the plugin's execution environment; your
`/plugins/<name>` still shows plain source. The plugin's own containers see all
of it: the layer is merged over the checkout, so **everything an install writes
reaches `/plugin` whether or not the directory is declared in `dep-dirs`** — a
build artifact in `dist/` arrives exactly like `node_modules`.

**It does not run once per commit — it runs once per set of dependencies.** The
directories a plugin declares in `dep-dirs` (default `[node_modules]`) are
promoted into a store shared by every session and every project, keyed by the
repository, the runtime, and the *content* of the install's inputs. A new commit
whose `package-lock.json` did not change reuses that tree and runs no install at
all; a commit that does change it installs once, for everybody. So `dep-dirs`
decides what is **shared**, not what arrives: a declared directory reaches
`/plugin` mounted back out of that store, an undeclared one by staying in the
writable layer, and both are there.

Two things turn the reuse off, deliberately, and both are the plugin author's to
control:

- an install command that is not a plain dependency install (anything that
  builds or generates), and
- a `package.json` with a `preinstall` / `install` / `postinstall` / `prepare`
  script, because those run repository code the lockfile does not describe.

In either case, declaring `install-inputs` says what the install actually
consumes and turns reuse back on — it **replaces** the default input set, so
list every file that changes the result. Turning it back on for an install that
*builds* means declaring the build's output directory in `dep-dirs` too: a store
hit clears the writable layer and runs nothing, so output the store holds no
copy of is the one thing that does not arrive.

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

## Refreshing a plugin repository

A repository declared with a `branch:` tracks that branch, but it only
re-activates when `shipit.yaml` changes or the session opens. After you push a
change to the plugin repository, pull it in:

```
shipit plugin refresh            # every declared repository
shipit plugin refresh tools      # just this one
```

It waits for the work and prints the commit each repository moved from and to.
A failed refresh exits non-zero and leaves the previous version live — so the
session keeps working, on the OLD version. That distinction is the point of the
non-zero exit: nothing is broken, but you are not running what you think.

## Working inside the plugin's own repository

A plugin repository can consume **itself**, so you can test its exports in a
session on the repository you are editing:

```yaml
exports:
  plugins:
    requirements: { ... }        # the manifest, as above
plugins:
  repos:
    - repo: self                 # no `branch:` and no `pin:` — both are errors
      name: dev
  use:
    - plugin: requirements
      from: dev
```

This is the ordinary consumer path, pointed at this session. The services, the
commands on your `PATH`, the skills, the settings file and the credential needs
are the same ones a consuming project gets, from the same manifest — you do not
write a second compose file or a second declaration to make it work.

One thing differs, and everything else follows from it: **the checkout is this
session's own working tree.** So:

- There is no separate `/plugins/<name>`; the files are your workspace, where
  you are already editing them. The plugin's own code still sees itself at
  `/plugin`, exactly as it does in a consuming project.
- The read-only rule above does not apply here — to you or to the plugin's own
  code. Editing the plugin IS the point, and an edit is live: the next command
  you run and the next service start read the working tree. `/plugin` is
  writable in the plugin's CLI and service containers too, because it is the
  same working tree they already have at `/project`.
- There is no commit and no generation, so `SHIPIT_PLUGIN_COMMIT` is unset —
  which is how a plugin can tell "being developed in its own repository" from
  "running at a tracked commit".
- `shipit plugin refresh dev` is refused: there is no version to move to. What
  ShipIt *copies* rather than reads live — the materialized skills and the
  generated command wrappers — is re-applied on the next activation round, which
  a `shipit.yaml` save or the session opening runs. Editing a file the manifest
  *points at* does not run one, so a service you rename in the exported compose
  file keeps its old name — under the old definition — until you save
  `shipit.yaml`.
- The plugin's `install` does not run: it exists to populate a generation's
  writable layer, and there is none. Your repository's own `agent.install`
  prepares the working tree that the services and CLIs then run out of. That is
  settled, not pending: ShipIt does not write plugin-authored install output
  into a tree it auto-commits.

  Two consequences follow, and they are the ones you would otherwise trip over.
  Your dependency directories (`agent.dep-dirs`, `node_modules` by default) are
  the plugin's dependency directories: the same content the agent container
  sees, at `/plugin` and `/project` alike, since under `repo: self` they are one
  tree. And a self-declared plugin's **services wait for `agent.install`** the
  way your own do — they read what it writes, so starting first would start them
  against a half-written tree.
- The repository's issues are already this session's, so `self` registers no
  separate feedback destination. File plugin bugs the ordinary way.

## Writing a plugin that survives its first consumer

Testing a plugin from its own repository is the right loop, and it is not a
substitute for a consuming project. Read the list above once more as **a list of
untested surfaces**: each difference is a place where a plugin works perfectly
for its author and fails on the first project that declares it.

| | the plugin's own repository | a consuming project |
|---|---|---|
| the checkout | this session's working tree, **writable** | a generation, **read-only at every mount** |
| the manifest's `install` | never runs — `agent.install` prepares the tree | runs, and is the only thing that populates the tree |
| a watcher on the source | sensible; you are editing it | pointless — the tree is one commit and cannot change |

Everything below follows from those three rows.

### Build in `install`, and declare where the build lands — on both sides

A consumer's `/plugin` is the checkout plus whatever `install` left behind, so
an install that builds is how built code gets there at all. Everything it writes
arrives (§ Install), with one exception you opt into: declaring `install-inputs`
on a *building* install turns store reuse back on, and a store hit clears the
writable layer and runs nothing — so a build output the store holds no copy of
is the one thing that does not arrive. Declare that directory in `dep-dirs` too
— and note that `install-inputs` takes literal paths, no globs, and *replaces*
the inferred set, so for a build it means naming every file that changes the
result. Leaving it off is the quiet default: the install re-runs per commit and
its output stays in the layer.

Under `repo: self` none of that runs. Your repository's own `agent.install` has
to do the same preparation, and `agent.dep-dirs` has to name the build output
for the same reason: a session that skips the install gets the committed files
and the declared dependency directories, and nothing else
([shipit-yaml.md](shipit-yaml.md) → Install behavior).

So the same preparation is declared **twice** — once in the manifest for
consumers, once under `agent:` for your own sessions — and only one of the two
runs in the session you develop in. Change one, change the other.

### Nothing may write the checkout, including the tools you depend on

For a consumer the tree is read-only at `/plugin` **and** at whatever path the
fragment mounts it at: a `- .:/app` that says nothing about writability is
forced read-only, because the rule is about the tree, not the path. In your own
repository the same mount is writable, so this is the rule you cannot break
locally.

You break it by depending on something that writes, not by writing anything
yourself. The usual suspects: dev servers and bundlers that cache next to the
code they read, anything with `--watch`, code generators, and tools that rewrite
a lockfile.

What a plugin's service container *can* write: its own image filesystem
(`/tmp`), any `tmpfs:` it declares, an anonymous volume (a `volumes:` entry with
no `:`), `/plugin-state`, and `/project`. A fragment cannot declare a named
volume, and its bind sources may only be its own files.

Relocating one tool's writes is the weaker fix — the tool's next release writes
somewhere new. The recipe below removes the need.

### Ship a built artifact; keep the dev server in your own repository

Nobody in a consuming project edits your source, and nothing a watcher could see
can ever change there — the tree is one commit, read-only. A dev server in an
exported fragment costs every consuming session a file watcher over an immutable
tree, forever, for a feature it structurally cannot use. Polling makes it worse.

Run two servers over one codebase:

1. **The exported fragment serves the build.** A plain HTTP server, no watcher,
   no `--watch`, no polling. Prefer a server whose own writes land in its image
   filesystem rather than in the tree it serves.
2. **The dev server lives in the plugin repository's own `docker-compose.yml`** —
   the file its `compose:` key names, not the file the manifest exports. Hot
   reload, watching, whatever you like: it is an ordinary project service in your
   own session and reaches no consumer.
3. **Take the exported service off autostart in your own `plugins.use` entry**,
   so the two do not both claim the preview. It stays one
   `shipit service start <name>` away, which is how you smoke-test what a
   consumer actually runs.

Two things collide if you are careless. A plugin service whose name matches one
of the project's own service names withholds **every** service that plugin
repository provides — the project's name wins — so the dev service needs a
different name. And both are real published ports, so give them different ones.

```yaml
# the plugin repository's own shipit.yaml
agent:
  install:
    - npm ci
    - npm run build        # the same build the manifest's `install` runs
  dep-dirs: [node_modules, dist]   # `dist` because a skipped install restores only these
compose: docker-compose.yml        # the DEV service lives here

exports:
  plugins:
    web:
      compose: plugins/web/docker-compose.yml   # the PRODUCTION service
      install: npm ci && npm run build
      dep-dirs: [node_modules, dist]   # `dist` matters as soon as `install-inputs` is set

plugins:
  repos:
    - repo: self
      name: dev
  use:
    - plugin: web
      from: dev
      overrides:
        services:
          web: { autostart: false }   # the dev service owns the preview here
```

```yaml
# plugins/web/docker-compose.yml — what a consumer runs
services:
  web:
    image: node:22-alpine
    user: "1000:1000"
    working_dir: /app
    command: node /app/plugins/web/serve.mjs   # serves ./dist; no watcher
    volumes: [".:/app:ro"]
    ports: ["4300:4300"]
    x-shipit-preview: auto
```

```yaml
# docker-compose.yml — your own session only; never reaches a consumer
services:
  web-dev:                       # a DIFFERENT name and a DIFFERENT port
    image: node:22-alpine
    command: npm run dev -- --host 0.0.0.0 --port 4301
    ports: ["4301:4301"]
    x-shipit-preview: auto
```

### With two servers, share the dispatcher — not just the handlers

Extracting the route *handlers* and mounting them two ways leaves the matching
rules in two places, and they drift immediately: case sensitivity, trailing
slashes, where a path segment ends. The result is a route that behaves one way
in development and another for a consumer — the exact bug this exercise is meant
to remove. Mount your own dispatcher at the root of both servers instead of
reimplementing a framework's matching rules on the side you do not develop on.

### Outside a dev framework, nothing catches your exceptions

A framework's error boundary is a thing you had for free and no longer have. An
exception thrown synchronously out of a plain `node:http` handler **exits the
process**, and the consuming project's preview stays down until someone restarts
it. Port the boundaries with the routes:

- Decode failures: `decodeURIComponent('%')` throws. One malformed URL from
  anywhere is enough. Catch it and return 400.
- Streams: handle `error` on every one. `existsSync` says yes to a directory,
  and streaming a directory throws `EISDIR` **asynchronously**, where your
  `try` has already returned. Stat and check `isFile()`.
- Path containment: comparing a resolved path against the served root passes a
  symlink inside the root that points out of it, and the read then follows it.
  Resolve both sides with `realpathSync` and compare those.

### Write the failure message for someone who cannot see your install log

When a plugin fails in a consuming project, the artifact that would identify the
cause — the install's own output — is in the Plugins tab, which the session's
agent cannot read; `shipit plugin` has `refresh` and `exec` and no `logs`. Your
runtime error message is the whole diagnostic that reader gets, so:

- **Name the precondition that failed, specifically.** "Dependencies or build
  missing" is not actionable; "the build (`dist/`) is missing" is, and it tells a
  failed install apart from a dropped one.
- **Give the two actions they can take**: `shipit plugin refresh <name>`, and
  filing an issue on your repository with `shipit issue create --tracker <name>`
  quoting that line.
- **Say that nothing in their project caused it.** Never point them at your
  manifest — it is in a repository they do not have and cannot change.

### The read-only smoke test, in three commands

```
cp -a <your checkout> /tmp/ro-plugin
chmod -R a-w /tmp/ro-plugin
cd /tmp/ro-plugin && <the exact command your fragment declares>
```

That models the one property a self-consuming session can never have. It is
cheap enough to run before every publish, and it is the only one of these checks
that needs nothing from the platform.

It is an approximation, in one way worth knowing: the errno differs. An
unwritable copy gives `EACCES` where a real consumer's mount can give `ENOENT`,
and a dependency with error-code-specific fallbacks can therefore fail two
different ways for one defect. Trust it for "does anything write the checkout",
not for how a specific tool reacts.

### Before you publish

- `install` produces everything the plugin needs at run time, and
  `agent.install` produces the same thing for your own sessions.
- `dep-dirs` names the build output on both sides.
- Nothing the fragment runs writes into the tree — verified by the read-only
  copy above, not by reasoning about it.
- No watcher, no polling, no dev server in the exported fragment.
- Every failure message names its precondition and is actionable by someone with
  no access to your repository.
- The exported service's name cannot collide with a consumer's own service names
  (a collision withholds the whole repository's services).

## Reporting a problem with a plugin

A plugin misbehaving is not something to work around locally, and not something
to fix in `/plugins/<name>` — that checkout is read-only and reaches nobody.
File it on the **plugin's own repository**, from here:

```
shipit issue create --tracker tools --title "reqs CLI drops the --root flag" --body-file - <<'EOF'
## What happened
...
## Reproduction
1. ...
## Proposed fix
```diff
...
```
EOF
```

`--tracker` takes the name from the `plugins.repos` entry — declaring the
repository is what grants the channel, and nothing else has to be configured.
The tracker token stays orchestrator-side, exactly as for a declared tracker.

**ShipIt appends the exact plugin commit this session is running** to the body,
so you do not have to find it (and cannot get it wrong — the checkout is a
staged export with no `HEAD` to read). Everything else is yours: what happened,
how to reproduce it, and a proposed fix as a diff.

Filing an issue is the **whole** channel. A project session never pushes to a
plugin repository and opens no PR there; make the fix in a session on the plugin
repository itself, then `shipit plugin refresh` here to test it.

A plugin repository is not one of this project's trackers, so it gets no Issues
tab and `shipit issue list` does not default to it. If a repository really is
both, declare it in `issues.trackers` as well — both names then address it.

## Failure behaviour

A plugin repository that cannot be fetched or validated does not stop the
session. It opens, and the Plugins tab reports the repository as unavailable,
or as degraded with the previous commit still live. Each declared repository
succeeds or fails on its own.

One failure comes from **this project's own** `docker-compose.yml` rather than
from the plugin: a plugin's services must not collide with the project's, so a
version is not activated while ShipIt cannot list the project's service names.
The card and `shipit plugin refresh` say which of the two happened, and both
append the detail. "ShipIt could not read this project's own compose file"
means ShipIt could not make sense of it at all — unreadable on disk, invalid
YAML, or not a compose document; the appended detail says which. "ShipIt
refuses this project's own compose file" means it parses fine and a rule
declined it, and the detail names the service, the rule and the fix. On a
contained session the usual one is a service with no `user:`: contained
services must declare a numeric, non-root `user:`, so add one (or run the
project in an Open session if the image needs a root init).

## When a declared surface does not appear

The surfaces a manifest can declare — services, CLIs, skills, settings, and the
per-plugin state directory — are wired into a session. If one of them is not
there, that is reported rather than silent: the repository's card in the Plugins
tab names the plugin, the surface, and the reason. A command withheld because
two plugins claim the name, a settings value that no longer matches the
manifest, a service whose fragment was rejected — each says so on the card.

Declared `hosts:` are the exception, and by design: they tell you which external
hosts a plugin needs, and grant nothing. A plugin reaches exactly what any other
code in this session reaches, under the session's own egress configuration.

That applies to all three ways plugin code runs — a plugin service, a companion
CLI you invoke, and the plugin's own `install`. So on a contained session a call
to a host outside the allowlist fails the same way it would from your own code,
and the fix is the same: the repository's card lists the declared hosts that are
not allowed yet and offers to add them, for this session or for the whole
instance. Adding one takes effect on the next companion-CLI call; there is no
allow-once prompt from inside a plugin container.

Some hosts cannot be added at all, and the card says so **instead of** offering
the buttons — one row, no action. Two states read that way, and neither is
something you or the user can fix from the session:

- **This session's network access is off.** A sandbox session with `network`
  off reaches ShipIt and the model API and nothing else, whatever the allowlist
  holds. Turning network access on for the session is the only route.
- **This ShipIt allows no extra hosts.** The deployment runs egress control at
  its built-in floor only, so an allowlist entry has nothing to act on — in
  every session on it. Only whoever operates the deployment can change that.

If a plugin's host is in either state, stop trying to grant it: the entry saves
and changes nothing. Say which of the two it is and what would have to change.
