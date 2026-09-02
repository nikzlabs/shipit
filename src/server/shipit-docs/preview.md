# Preview System

HTML served through an active Preview receives the [Agent Interface SDK](./agent-interface-sdk.md). It exposes `window.shipit.agent.sendMessage()` plus cooperative visibility state. Use visibility to suspend audio, animation, polling, and timers when hidden. A preview that is not on screen — a background port, or the whole pane sitting behind another tab — stays **mounted**, so its document, DOM and scroll position survive and returning to it is instant, but it is hidden with `display: none` and the browser stops giving it animation frames. Timers and **audio** keep running, which is what the visibility signal is for.

The preview pane shows a live view of the running application. It updates
automatically as you edit files.

## How it works

1. ShipIt reads `shipit.yaml` for the compose file path (or auto-detects
   `docker-compose.yml` / `compose.yml` at the workspace root).
2. If `agent.install` commands are specified, they run in the agent container.
   By default, every `auto` preview service **waits for install to finish**
   before it starts — it is held in `starting` ("waiting for install") rather
   than racing the agent and crash-looping on missing dependencies. This is
   the `x-shipit-depends-on-install` gate (see below), and it is `true` by
   default for `auto` services. Once install completes successfully, gated
   services start exactly once. If install fails, gated services are marked
   `error` with the message `agent.install failed — dependent service not
   started`, surfacing the real cause instead of a downstream symptom.

   A service that opts out (`x-shipit-depends-on-install: false`) starts
   immediately, in parallel with install. For those, the legacy safety net
   still applies: a non-zero exit during the install window is retried with
   backoff instead of being marked `error`, and once install finishes ShipIt
   does one explicit restart pass on any such service still in `error`.
3. Services defined in docker-compose.yml start as Docker Compose containers.
   Services marked as `auto` (or with `ports`) start automatically.
4. ShipIt detects when ports are ready and routes browser traffic through a
   reverse proxy. Each preview is served on its **own subdomain origin**
   (`{sessionId}--{port}.<host>`), so your app is reached at the root of that
   origin — absolute asset/API paths like `/assets/app.js` or `/gradio_api/...`
   resolve naturally, with no path prefix to account for. (Bind the server to
   `0.0.0.0`, not `127.0.0.1`, or the proxy can't reach it.)

## Keeping a preview running

A preview does **not** stop just because its session went idle. ShipIt keeps
idle previews running while it is inside its memory budget, and when it has to
reclaim, an idle session gives up its agent container first and its preview only
if that was not enough. So an ordinary session's preview normally survives idle
periods on its own.

**Keep preview running** is the stronger, explicit guarantee: a reserved session
is exempt from reclaim entirely, including under memory pressure.

The session overflow menu has a checked **Keep preview running** action. Enabling
it immediately activates the ordinary session runtime and the same `auto`
Compose-service reconciliation described above. The reservation survives idle
periods and orchestrator restarts; unexpected agent-container exits are retried
with a bounded backoff. Disabling only releases the reservation — it does not
stop a healthy preview immediately, which returns to the normal idle lifecycle.

The URL and access boundary do not change. This is a private ShipIt preview, not
a public deployment, and the deployment admits only a bounded number (one by
default). Failures remain visible through the existing session status, service
error, and Logs surfaces.

## Repository trust gate

A freshly-cloned repository is **untrusted** until the user accepts it once. While
a repo is untrusted, ShipIt still clones it and lets you browse files, read diffs,
and chat — but it does **not** auto-run any repo-declared command: `agent.install`
is deferred and `auto` preview services do not start. This is a security boundary
(trust-on-first-use), so an opened repo can't run setup shell on the user's machine
before they've vetted it.

If install or the preview "isn't running" on a brand-new repo, the user simply
hasn't trusted it yet — the Preview tab shows a restricted state with a **Trust
this repository** button. Accepting unblocks install + previews for that remote
(now and for every future session cloned from it). Repos scaffolded from a ShipIt
template are trusted automatically. This is per-remote and one-time; it does not
recur per session.

## Where to put `npm install`

Put dependency-install commands in `agent.install` only. **Do not** also
prefix the compose service's `command` with an install step. The cleanest
shape is:

```yaml
# shipit.yaml
agent:
  install:
    - cd preview && npm install
compose: docker-compose.yml
```

```yaml
# docker-compose.yml
services:
  preview:
    image: node:24-slim
    command: npm run dev -- --host 0.0.0.0
    working_dir: /app/preview
    ports: ["5173:5173"]
    volumes: [".:/app"]
```

By default the dev server **waits** for `agent.install` to finish before it
starts (the `x-shipit-depends-on-install` gate), so there is no cold-boot
crash and no `127` ("vite: not found") noise. The preview shows `starting`
until install completes, then comes up cleanly in a single start.

> The `127` / "vite: not found" cold-boot crash only happens for services
> that explicitly opt out with `x-shipit-depends-on-install: false`. For those,
> the exit is expected and ShipIt retries with backoff until install finishes.

### Common pitfall: duplicate install in compose `command`

A pattern that looks defensive but is actively harmful:

```yaml
# DON'T — racy duplicate install
command: sh -c "(test -x node_modules/.bin/vite || npm install) && npm run dev"
```

When `agent.install` and a compose service both run `npm install` against
the same bind-mounted `node_modules` at the same time, two different
containers extract npm tarballs into the same physical directory. The
result is a flood of `TAR_ENTRY_ERROR ENOENT` warnings, half-extracted
packages, and a "successful" exit code. The next `test -x` check passes on
the broken tree, dev server fails with `vite: not found`, container exits
`127`. Keep install in the agent only.

## Service types

| `x-shipit-preview` | Behavior |
|---------------------|----------|
| `auto` (default for services with ports) | Starts automatically, shown in preview |
| `manual` (default for services without ports) | Started on demand — `shipit service start <name>`, or the user clicks "Start" in the UI |

Start a `manual` service yourself whenever your task needs it — a database to
migrate against, a cache to flush, an emulator to drive. Don't tell the user to
click Start:

```bash
shipit service list           # what exists, what's running, each service's url
shipit service start db
shipit service logs db --lines 200
```

The first start may pull a large image or run a `build:`, so it can take
minutes; `start` waits up to 10 minutes and a timeout means it's still going,
not that it failed. Full reference: [compose.md](compose.md) →
"Controlling services".

## Install gate (`x-shipit-depends-on-install`)

Controls whether a service waits for `agent.install` before starting.

| Value | Behavior |
|-------|----------|
| `true` (default for `auto` services) | Held in `starting` until `agent.install` finishes, then started exactly once. If it crashes within its first-boot window (e.g. the install signal raced ahead of `node_modules/.bin` landing on disk → exit 127), ShipIt restarts it with backoff a bounded number of times before giving up. If install fails, the service is marked `error` with `agent.install failed — dependent service not started`. |
| `false` (default for `manual` services) | Starts immediately, in parallel with install. Crash-loops while dependencies are missing are retried with backoff (the legacy net). |

```yaml
services:
  preview:
    image: node:24-slim
    command: npm run dev -- --host 0.0.0.0 --port 3000
    ports: ["3000:3000"]
    x-shipit-preview: auto
    x-shipit-depends-on-install: true   # default for auto — gate on install
```

Set it to `false` only when a preview service genuinely does not depend on
`agent.install` output and you want fail-fast feedback.

**Mid-session re-install.** Changing a dependency file — a lockfile
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, …) or the manifest your
install reads — re-runs `agent.install`. This fires for **git operations**
(`git reset`/`checkout`/`rebase` that pull in a different dependency tree) just
as it does for direct edits, so resetting the branch to a commit that added a
dependency recovers the preview automatically instead of leaving it 500'ing on
an unresolved import. The same applies to the tree rewrites **ShipIt** performs
on an idle session — a sync/rebase onto the base, a rollback, a post-merge reset
— which are reported directly instead of through the in-container file watcher.
Gated services are torn down while install re-runs and
restarted once it completes — so expect a brief preview blink. That's
intentional: the dependency tree changed, so the service relaunches against the
fresh `node_modules`. Reinstalls are throttled to one per 30s.

**When the re-install cannot run, or fails.** An `agent.install` that is not
content-keyable (a codegen step or a shell script, with no declared
`install-inputs`) is not re-run after a ShipIt-performed rewrite, and a re-install
that fails obviously leaves the tree uninstalled. Neither is silent: both post a
notice in chat, add a `Dependencies:` line to `shipit service list`, and prefix
your next turn with a `[System]` instruction naming the commands to run — which
repeats every turn until an install clears it. **Run the install before debugging
a `Failed to resolve import` as a code fault** — the
service still reports `running`, and restarting it does not help, because the
usual compose guard is `[ -d node_modules ] || npm ci` and the directory exists.
Re-run the install instead.

## Multi-service

Define multiple services in docker-compose.yml. Each service with ports gets
its own preview tab:

```yaml
services:
  frontend:
    image: node:24-slim
    command: npm run dev
    ports: ["5173:5173"]
    x-shipit-preview: auto

  api:
    image: node:24-slim
    command: npm run api
    ports: ["3001:3001"]
    x-shipit-preview: auto

  db:
    image: postgres:16
    x-shipit-preview: manual
```

## Hot Module Replacement (HMR)

ShipIt patches dev-server WebSocket URLs so HMR works through the reverse
proxy. No configuration needed — Vite, Next.js, and other frameworks work
out of the box.

## Renderer isolation — don't send `Origin-Agent-Cluster: ?0`

Every preview response carries **`Origin-Agent-Cluster: ?1`**. Preview origins
are all subdomains of one domain, and browsers group same-site documents into a
single renderer process — so without this header every open session's preview
shares one main thread and one budget of 16 WebGL contexts, and the oldest
contexts get force-lost. A user with a 3D or canvas app sees a blank canvas,
caused by sessions they aren't even looking at.

ShipIt only sets the header when your app hasn't set one itself. So if your dev
server sends a security-headers middleware default of `Origin-Agent-Cluster: ?0`
(some do), it wins — and it puts your preview back in the shared renderer.
Unless you specifically need same-site frames in one agent cluster, leave the
header to ShipIt.

## Restart triggers

| Change | Effect |
|--------|--------|
| Source file edit | Hot reload (no restart) |
| `shipit.yaml` or compose file edit | Stack reconciliation (restart services) |
| `shipit.yaml`/compose file changed by a sync/rebase or rollback | Same reconciliation — services added by the incoming config appear without a session restart |
| Lockfile/manifest change (edit **or** git reset/checkout/rebase) | Install + restart (30s cooldown) |
| A ShipIt-performed rewrite where the install can't be re-checked, or its re-run failed | No restart — a `[System]` note and a `Dependencies:` line on `shipit service list` |

## Browser tools

You have headless Chrome available via Playwright MCP. Use these tools to
verify your work:

- **browser_navigate** — open the preview URL. Do not assume
  `127.0.0.1:<port>` works from the browser: previews run in Compose service
  containers, so `localhost` is the agent's own container, not the dev server.
  Inspect ShipIt's service registry and use the service's **`url`** field:
  `curl -s http://${SHIPIT_HOST}:${SHIPIT_PORT}/api/sessions/${SHIPIT_SESSION_ID}/services`.
  A service carries a ready-to-use `url`
  (e.g. `"url":"http://172.20.0.2:5173/"`) — `browser_navigate` to it, or `curl`
  it directly. The `url` is the service's own `containerIp` + `port`, and it is
  published as soon as the container has an address — including while the
  service still reads `status: "starting"`, because readiness is a separate
  question from where the service lives. So a `starting` service with a `url` is
  worth trying: connection-refused just means "not up yet, retry". A missing
  `url` means no container address is known yet — wait and re-query.
  Do **not** use the `{sessionId}--{port}.<host>` subdomain form — that origin is
  for the user's preview pane (served by the orchestrator proxy) and does not
  resolve from the agent's browser. (Egress containment allows the agent to reach
  its own session's service containers by IP; reaching the dev server this way is
  expected and supported.)
- **browser_snapshot** — read page content as an accessibility tree (preferred
  for understanding layout)
- **browser_click** / **browser_type** — interact with elements
- **browser_take_screenshot** — capture a visual screenshot for layout/styling.
  **Omit `filename`.** The MCP auto-names the file into its `--output-dir`,
  `/tmp/.playwright-mcp/`, so it stays out of git — and `@playwright/mcp`
  returns the image itself *only* when `filename` is omitted. Pass one and the
  result is a text-only link to a file on disk: you never see the page, and the
  screenshot does not render in the chat transcript. If you truly need a stable
  name, it must be an **absolute** path under `/tmp/.playwright-mcp/`, and
  `Read` the file afterwards to actually look at it. A **relative** name does
  not land in the output dir, whatever the tool's own description says: an
  explicit filename is resolved against `/workspace`, so `shot.png` becomes
  `/workspace/shot.png` and gets auto-committed. A bare `/tmp/foo.png` is
  rejected with "File access denied" — it is outside both allowed roots.

Use browser tools proactively after UI changes to catch issues early.

## Creating a compose file

If the project doesn't have a docker-compose.yml, see
[compose.md](compose.md) for how to create one for ShipIt.

## Troubleshooting

- **Preview not loading**: Check that docker-compose.yml has the correct
  command and port. Verify the service is running with ShipIt's service
  registry:
  `curl -s http://${SHIPIT_HOST}:${SHIPIT_PORT}/api/sessions/${SHIPIT_SESSION_ID}/services`.
  For browser verification, use the service's returned `url` (its
  `containerIp` + `port`) rather than guessing `localhost`.
- **Service stuck in `starting`**: try its `url` anyway — it is published as
  soon as the container has an address, so a service that is genuinely serving
  is reachable even before the registry has confirmed readiness. A service that
  is still `starting` after two minutes with no image build in flight resolves
  to `error` carrying the reason; `shipit service logs <name>` shows whether the
  process itself is healthy, and `shipit service restart <name>` re-probes it.
- **Port not detected**: Ensure `ports` is set in docker-compose.yml.
- **Connection refused**: The dev server may need a moment to start. Ensure it
  binds to `0.0.0.0` (set `HOST=0.0.0.0` in the compose environment).
- **HMR not working**: Ensure the dev server binds to `0.0.0.0`, not
  `127.0.0.1`. Add `HOST: "0.0.0.0"` to the service's environment.
