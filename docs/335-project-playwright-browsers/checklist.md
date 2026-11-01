# Browser builds for a project's own Playwright — checklist

- [x] Pin the stable release as `playwright-stable` in `docker/agent-cli/package.json` and regenerate the lockfile (req 3).
- [x] Teach `check-deps` to read an `npm:` alias (req 3).
- [x] Install the stable release's Chromium and headless shell beside the MCP's build in the three images (req 2).
- [x] Measure the size and decide between one and two releases (req 4).
- [x] Give a session container a writable, persistent `PLAYWRIGHT_BROWSERS_PATH` and link the baked builds into it at worker boot (req 1, 5).
- [x] Start the built-in browser on the image's store for every harness (req 6).
- [x] Document the covered release and the way out in `environment.md` (req 7).
- [x] Verify in a container built from `Dockerfile.session-worker.prod` (req 8).
