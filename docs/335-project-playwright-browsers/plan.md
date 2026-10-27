---
issue: planning#706
title: Browser builds for a project's own Playwright
description: The image bakes the current stable Playwright's Chromium beside the built-in browser's, and a session gets a writable, persistent browser store that links both in.
---

# Browser builds for a project's own Playwright

Implements [requirements.md](requirements.md).

## Problem

Seen on 2026-10-21, image built 2026-10-20. Every process in a session had
`PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`, a root-owned, read-only store
holding only `chromium-1247`, `chromium_headless_shell-1247` and `ffmpeg-1011`.
Build 1247 comes from `@playwright/mcp` 0.0.83, which pins
`playwright-core@1.64.0-alpha-1790635538000`. No stable release uses 1247 (1.63.0
uses 1243; 1.64.0 and 1.64.1 use 1248), so a project on `@playwright/test` failed
at launch with `Executable doesn't exist at …/chromium_headless_shell-1243/…`.
`npx playwright install` could not write the store and appeared to hang: Playwright
takes a lock in the store with 20 retries over about ten minutes
(`registry.install`, `__dirlock`) and only then fails.

## Design

### The pin (req 3)

`docker/agent-cli/package.json` pins `"playwright-stable": "npm:playwright-core@<x.y.z>"`.

- **An alias, not a second `playwright-core`.** `@playwright/mcp` depends on an exact
  alpha `playwright-core`. A plain top-level `playwright-core` would take that slot
  and push the MCP's copy into a nested `node_modules`. The alias installs beside it
  in `node_modules/playwright-stable`. Measured with npm 11 on 2026-10-21:
  `.bin/playwright-core` stays on the MCP's copy, and nothing else in `.bin` moves.
- **The agent CLI manifest, not a new one.** Renovate's agent CLI rule matches the
  file, so the pin gets the 7-day `minimumReleaseAge`, the grouped PR and the human
  merge with no new rule. Renovate's npm manager updates an `npm:` alias in place.
  `check-deps` reads an alias as an exact pin of the package it names
  (`pinnedPackage` in `scripts/check-dependency-age.ts`).

### The image (req 2)

The three images that bake the built-in browser (`Dockerfile.session-worker.prod`,
`.session-worker.dev`, `.dogfood`) run
`node /opt/agent-cli/node_modules/playwright-stable/cli.js install chromium` after
the MCP's install, in the same `RUN` and the same store. In 1.64.1 that installs
`chromium-1248`, `chromium_headless_shell-1248` and `ffmpeg-1013`.

- Playwright's install garbage collector keeps the MCP's builds: it keeps every
  build a package recorded in the store's `.links` still names, and the MCP's
  install recorded its `playwright-core` there first.
- System packages: `install-deps --dry-run chromium` lists the same packages for the
  MCP's alpha and for 1.64.1, so the existing `playwright install-deps chromium`
  covers both.

### The session's store (req 1, 5)

Playwright reads exactly one directory, and `install` must write it. So a session
container gets `PLAYWRIGHT_BROWSERS_PATH=/session-state/playwright-browsers`
(`buildEnv` in `container-lifecycle.ts`), and the worker prepares it at boot,
before its listener opens (`linkBakedPlaywrightBrowsers` in
`shared/playwright-browsers.ts`):

- It links every build of the image's store into it. A project on the covered
  release finds its build through the link; a project on another release runs
  `npx playwright install`, which writes a real directory beside the links and
  keeps it across container restarts.
- It copies the store's `.links` records. Without them, a project's `install`
  would garbage-collect the links of every build its own version does not use.
- It restores a link that `playwright uninstall --all` removed. It leaves a real
  directory alone: that is the project's own install.
- It does not sweep the link of a build an image update dropped. Playwright's
  own install GC removes it, because its marker file no longer exists, before
  it downloads anything.
- Only when it cannot create the directory at all does it set the worker's own
  `PLAYWRIGHT_BROWSERS_PATH` back to the read-only store, which every process the
  worker starts inherits: baked builds still launch, and `install` fails. A later
  failure (one link, one `.links` record) is logged and the session's store
  stays, so builds the project installed there stay visible.

Local mode (the dogfood inner instance) runs no session worker. It keeps the
image's `PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers`: the stable build
launches, and `install` still cannot write there.

`/session-state`, not `/persist`: it is mounted for every session container, private
to the session, and kept across restarts, and it is where the session's npm cache
already lives. `/persist` is the user's scratch, with a retention period that is
about the user's files; a browser cache of hundreds of megabytes does not belong
in it. A writable `/opt/playwright-browsers` was not an option: a write there is
lost at the next restart, and some deployments run a read-only root filesystem.

### The built-in browser (req 6)

The launch command in `session/agents/playwright-mcp.ts` exports
`PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers` before it execs
`playwright-mcp`, for every harness. Nothing a project does in the session's store
reaches it. Codex no longer forwards the variable to the server: the command sets it.

## Decision: one stable release (req 4)

Measured on 2026-10-21 on the downloaded builds (gzip -6 of each directory):

| | 1.64.x (build 1248) | 1.63.0 (build 1243) |
|---|---|---|
| Chromium | 403 MiB / 176 MiB | 393 MiB / 172 MiB |
| Headless shell | 273 MiB / 108 MiB | 261 MiB / 103 MiB |
| ffmpeg | 6 MiB / 2 MiB (1013) | — (1011, already in the image) |
| **Added to the image** | **682 MiB / 286 MiB** | **654 MiB / 275 MiB** |

The image is about 4.9 GB on disk, so the current release adds about 14 %. The
latest two minors add both columns, 1.34 GiB on disk and 561 MiB compressed, about
27 %.

The image covers one release:

- **Renovate cannot keep a second pin one minor behind.** It moves every pin to the
  newest release that clears the cooldown, so a "previous minor" pin would either
  equal the first or need a human to move it every month.
- **A miss is cheap now.** With a writable store, a project one minor behind runs
  `npx playwright install chromium-headless-shell` once per session (about 108 MiB
  to download; 8 s in the verification below) instead of the manual override
  this replaced.

Revisit if sessions often pay that download for the same release.

## Verification (req 8)

On 2026-10-21 a temporary Compose service built `Dockerfile.session-worker.prod`
with one line changed: `uv` copied from the local `shipit-session-worker:prod`
image, because the build could not resolve `ghcr.io`. A script then ran in that
container as the non-root session user, with `PLAYWRIGHT_BROWSERS_PATH` set as
`buildEnv` sets it but under `/persist`, which a Compose service can mount:

- The store held 1247 (the MCP's) and 1248 (1.64.1's), read-only to the user;
  `.bin/playwright-core` still named the MCP's copy.
- `linkBakedPlaywrightBrowsers` linked all six builds into the session's store.
- A project on `@playwright/test` 1.64.1 passed a headless-shell test and a
  full-Chromium test (156.0.8078.4) with no override and no install.
- A project on 1.63.0 failed with `Executable doesn't exist at
  …/chromium_headless_shell-1243/…`; `npx playwright install
  chromium-headless-shell` finished in 8 s; the test then passed. Every baked
  link survived that install's GC, and the 1.64.1 project still passed.
- The MCP server, started with `PLAYWRIGHT_MCP_ARGS` while the caller pointed at
  the session's store, navigated a page on
  `/opt/playwright-browsers/chromium-1247`.

## Rejected alternatives

- **Keep the read-only store and document an override.** The ten-minute lock wait
  stays, and the override must be set on every run.
- **`PLAYWRIGHT_SKIP_BROWSER_GC=1` instead of copying `.links`.** It protects the
  links too, but it also keeps every build a project installed and later stopped
  using, for the life of the session.
- **A separate manifest for the pin.** It needs its own Renovate rule, `check-deps`
  entry and CI lockfile check; the agent CLI manifest already has all three.

## Key files

- `docker/agent-cli/package.json` — the `playwright-stable` pin.
- `docker/Dockerfile.session-worker.prod`, `.session-worker.dev`, `.dogfood` — the
  stable release's install beside the MCP's.
- `src/server/shared/playwright-browsers.ts` — the two stores and the boot-time linking.
- `src/server/session/session-worker.ts` — calls the linking before the listener opens.
- `src/server/orchestrator/container-lifecycle.ts` — `PLAYWRIGHT_BROWSERS_PATH` for a session container.
- `src/server/session/agents/playwright-mcp.ts` — the built-in browser's own store.
- `scripts/check-dependency-age.ts` — reads an `npm:` alias.
- `src/server/shipit-docs/environment.md` — the agent-facing Playwright section.
