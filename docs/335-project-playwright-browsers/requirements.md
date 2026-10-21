---
issue: planning#706
title: Browser builds for a project's own Playwright
description: A project on the current stable Playwright finds its Chromium in the session image; any other version installs its own, and the built-in browser keeps its build.
---

# Browser builds for a project's own Playwright

1. In a ShipIt session container, a project that uses the current stable Playwright release (`@playwright/test`) finds its own Chromium build, so `npx playwright test` works with no manual step.
2. The image provides the Chromium and headless-shell builds of the current stable Playwright release, in the same folder as the built-in browser's build, and both work.
3. That Playwright version is pinned the way the agent CLIs are pinned, so that Renovate keeps it current.
4. Whether the image covers one stable release or the latest two stable minor releases is decided from a measurement of the size each adds to the image.
5. A project whose Playwright version does not match gets a clear way out — for example `npx playwright install` works for it, into a folder that survives a container restart.
6. The built-in browser tool (`@playwright/mcp`) keeps its own build and keeps working.
7. The agent-facing docs (`environment.md`, the Playwright section) say which Playwright versions the image covers and what to do with another one.
8. In a container from the new image, a project with the current stable `@playwright/test` runs a headless test with no override, and the built-in browser tool still works.

## Open questions

## Resolved questions
