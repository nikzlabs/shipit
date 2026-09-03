# Writing a plugin

This page is for a session **on a plugin repository** — a repository whose
`shipit.yaml` declares `exports.plugins`. It covers testing your exports from
that repository, and the ways a consuming project differs from it.

**Read [plugins.md](plugins.md) first.** What a consuming project sees is what
you are shipping: the manifest schema and the `plugins.use` entry a consumer
writes are documented there (§ Declaring a plugin repository), and so are the
runtime facts you design against — the read-only checkout, the separate
container plugin code runs in, and how `install` and the shared dependency
store behave. This page does not repeat them.

## Working inside the plugin's own repository

A plugin repository can consume **itself**, so you can test its exports in a
session on the repository you are editing:

```yaml
exports:
  plugins:
    requirements: { ... }        # the manifest — schema in plugins.md
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
- The read-only checkout rule ([plugins.md](plugins.md) → What you see in this
  container) does not apply here — to you or to the plugin's own code. Editing
  the plugin IS the point, and an edit is live: the next command you run and
  the next service start read the working tree. `/plugin` is
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

### Your service does not choose its port

An exported compose fragment **must not declare `ports:`**. A fragment that does
is refused, and the plugin repository's card names the line to delete — there is
no migration window in which the old behaviour still runs.

The reason is that you cannot know what a consuming project already runs. When a
plugin picked its own port, a plugin serving on 5173 and a project serving on
5173 collapsed onto one preview address, and the consumer could not fix it: the
number came from your fragment, and their `overrides` had no key for it. 5173 is
the Vite default, so that was ordinary rather than exotic.

So the consumer writes the number, in their `plugins.use` entry, and **ShipIt
tells your container which port to serve on** through `SHIPIT_PLUGIN_PORT`:

```js
const port = Number(process.env.SHIPIT_PLUGIN_PORT ?? 8080)
server.listen(port, "0.0.0.0")
```

Two rules follow:

- **Read the variable; do not hardcode a port.** A server that binds its own
  number is unreachable. ShipIt notices — a service that is running with nothing
  listening on the port it was given gets a line in its own log saying so — but
  the consumer cannot fix your code, so they will be filing an issue.
- **Bind `0.0.0.0`, not `127.0.0.1`.** ShipIt reaches your container by IP on the
  session network, so a loopback-only bind answers nobody.

The variable is **absent** when the consuming project named no port. That is not
an error: it means nothing is previewing this service, so a worker or a database
can simply ignore it.

### Build in `install`, and declare where the build lands — on both sides

A consumer's `/plugin` is the checkout plus whatever `install` left behind, so
an install that builds is how built code gets there at all. Everything it writes
arrives ([plugins.md](plugins.md) → Install), with one exception you opt into:
declaring `install-inputs` on a *building* install turns store reuse back on,
and a store hit clears the
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

### A toolchain your install downloads goes under `/plugin`, not into the image

`install` borrows the session-worker image for its toolchain, but it runs as the
**consuming session's own uid** — so every path that image bakes in for its own
user is read-only to you. ShipIt redirects the two that a plugin actually
installs into, at both install time and run time, so a tool fetched by `install`
is still there when your CLI runs:

| Variable | Points at |
|---|---|
| `PLAYWRIGHT_BROWSERS_PATH` | `/plugin/.shipit-toolchain/playwright-browsers` |
| `NPM_CONFIG_PREFIX` | `/plugin/.shipit-toolchain/npm-global` (its `bin` is on `PATH`) |

You do **not** declare that directory in `dep-dirs` — ShipIt adds it to the
shared store itself, so a later commit that reuses your dependencies keeps the
browser instead of losing it. **A download does need egress**, though:
`playwright install` reaches `cdn.playwright.dev` and
`playwright.download.prss.microsoft.com`, both of which every session allows by
default. Anything else your install downloads from must be declared in the
plugin's `hosts:`, or the consuming session denies it.

Two limits of borrowing that image, both of which bite quietly:

- **`NODE_ENV` is `production`**, so `npm ci` in an `install:` installs no
  devDependencies. An install whose next step is `npm run build` then fails on a
  missing bundler — and an install that merely *ships* a devDependency at runtime
  exits 0 and fails much later. Pass `--include=dev` when you need them.
- **A toolchain the image bakes no variable for does not move.** The Android SDK
  at `/opt/android-sdk` is world-writable, so `sdkmanager` appears to work — but
  it writes into the install container's own disposable layer, which no CLI or
  service container shares. `HOME` is `/tmp`, a tmpfs the container discards, so
  anything cached under `$HOME` is likewise gone before a consumer sees it.

### Nothing may write the checkout, including the tools you depend on

For a consumer the tree is read-only at `/plugin` **and** at whatever path the
fragment mounts it at: a `- .:/app` that says nothing about writability is
forced read-only, because the rule is about the tree, not the path. In your own
repository the same mount is writable, so this is the rule you cannot break
locally — with one exception worth taking: a `repo: self` fragment **keeps what
it declared**, so writing `- .:/app:ro` explicitly gives your own session the
consumer's writability for that mount, at no cost to a consumer who gets it
either way.

You break it by depending on something that writes, not by writing anything
yourself. The usual suspects: dev servers and bundlers that cache next to the
code they read, anything with `--watch`, code generators, and tools that rewrite
a lockfile.

What a plugin's service container *can* write: its own image filesystem
(`/tmp`), any `tmpfs:` it declares, an anonymous volume (a `volumes:` entry with
no `:`), `/plugin-state`, and `/project`. A fragment cannot declare a named
volume, and its bind sources may only be its own files. The last two are mounted
read-write but owned by the **consuming session's own uid** — a per-session number
in 2000000–2999999, not a fixed 1000 — so a service that declares some other
`user:` can still be refused by the filesystem. Declare no `user:` and ShipIt
supplies that identity; a fragment cannot name it, since no fragment can know it.

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

One thing collides, and it is the name. A plugin service whose name matches one
of the project's own service names withholds **every** service that plugin
repository provides — the project's name wins — so the dev service needs a
different one.

Ports do not collide, because **an exported fragment does not declare one**. See
[Your service does not choose its port](#your-service-does-not-choose-its-port).

```yaml
# the plugin repository's own shipit.yaml
agent:
  install:
    - npm ci
    - npm run build        # the same build the manifest's `install` runs
  # a skipped install restores only these, so the build output is named too
  dep-dirs: [node_modules, plugins/web/dist]
compose: docker-compose.yml        # the DEV service lives here

exports:
  plugins:
    web:
      compose: plugins/web/docker-compose.yml   # the PRODUCTION service
      install: npm ci && npm run build
      # `plugins/web/dist` is load-bearing the moment you add `install-inputs`
      dep-dirs: [node_modules, plugins/web/dist]

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
    # No `user:` — ShipIt supplies the consuming session's own uid, which is
    # per-session and therefore not something a fragment could name. A pinned
    # uid cannot own `/project`, so git and dependency caches fail there.
    working_dir: /app
    command: node /app/serve.mjs     # reads SHIPIT_PLUGIN_PORT; no watcher
    volumes: [".:/app:ro"]           # `.` is THIS FILE'S directory: plugins/web
    # no `ports:` — the consuming project names it, and the server reads
    # SHIPIT_PLUGIN_PORT. Declaring one here is refused.
```

**A fragment's `.` is the fragment's own directory, not the repository root** —
the same rule a standalone `docker compose up` in that directory would follow.
So `/app` above holds `plugins/web`, and the build has to land beside the
fragment (`plugins/web/dist`) for the service to serve it. Nothing above `/app`
is reachable from there either, so a server that imports a dependency from the
repository root's `node_modules` finds nothing. The whole tree is mounted as
well, at `/plugin`, for a service that would rather run from the root.

```yaml
# docker-compose.yml — your own session only; never reaches a consumer
services:
  web-dev:                       # a DIFFERENT name from the exported service
    image: node:22-alpine
    # No `user:` needed, in a contained session either — ShipIt fills in this
    # session's own identity, which is what lets the service write this mount.
    working_dir: /app
    command: npm run dev -- --host 0.0.0.0 --port 4301
    volumes: [".:/app"]          # writable here; watching and hot reload are fine
    ports: ["4301:4301"]
    x-shipit-preview: auto
```

Two consequences of running two servers follow, and they are the ones that bite.

### Share the dispatcher, not just the handlers

Extracting the route *handlers* and mounting them two ways leaves the matching
rules in two places, and they drift immediately — case sensitivity, trailing
slashes, where a segment ends. That produces a route that behaves one way in
development and another for a consumer: the exact bug the split was meant to
remove. Mount your own dispatcher at the root of both servers rather than
re-implementing a framework's matching rules on the side you do not develop on.

### The framework was catching your exceptions; a plain server is not

An exception thrown synchronously out of a `node:http` handler **exits the
process**, and the consuming project's preview stays down until someone restarts
it. Port the boundaries along with the routes:

- Decode failures: `decodeURIComponent('%')` throws. One malformed URL from
  anywhere is enough. Catch it and return 400.
- Streams: handle `error` on every one. `existsSync` says yes to a directory,
  and streaming a directory throws `EISDIR` **asynchronously**, where your
  `try` has already returned. Stat and check `isFile()`.
- Path containment: comparing a resolved path against the served root passes a
  symlink inside the root that points out of it, and the read then follows it.
  Resolve both sides with `realpathSync` and compare those.

### Write the failure message for someone who has only your install log's tail

A *failed* install is the easy case: its output tail rides the failure detail, so
the Plugins tab shows it, `shipit plugin refresh` reprints it, and
`shipit plugin status` still names it long after the round that failed. The hard
case is the one this recipe is for — an install that **succeeded** and left the
wrong tree. Your consumer can read what it printed (`shipit plugin status
--json`), and that is the tail of a build that thought it worked: it
shows what the install *claimed*, not which precondition your code then found
missing. Your runtime error message is still the diagnostic that names it:

- **Name the precondition that failed, specifically.** "Dependencies or build
  missing" is not actionable; "the build (`dist/`) is missing" is, and it tells a
  failed install apart from a dropped one.
- **Give them the sequence that works**: `shipit plugin status <name> --json` to
  see what the install did and printed, `shipit plugin refresh <name> --force`
  to run it again
  for the same version, and an issue on your repository
  (`shipit issue create --tracker <name>`) quoting that line if it survives both.
- **Say when their project cannot be the cause** — true of a missing build
  artifact, and not of a failure that depends on a setting, a credential, an
  egress rule or project data, which are theirs. Either way never point them at
  your manifest: it is in a repository they can read and cannot change.

### The read-only smoke test, in three commands

```
cp -a <your checkout> /tmp/ro-plugin
chmod -R a-w /tmp/ro-plugin
cd /tmp/ro-plugin && <the exact command your fragment declares>
```

The copy stands in for the mounted tree, so read the fragment's `/app` (or
whatever it mounts `.` at) as `/tmp/ro-plugin` when you run the command.

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
- No `ports:` in the exported fragment, and every server in it binds
  `SHIPIT_PLUGIN_PORT` on `0.0.0.0` rather than a port of its own.
- Every failure message names its precondition and is actionable by someone with
  no access to your repository.
- The exported service's name cannot collide with a consumer's own service names
  (a collision withholds the whole repository's services).
