---
issue: planning#486
title: Preview connects without a client-side gate
description: The preview proxy absorbs the wait for a dev server that is not listening yet, so the pane stops polling before it loads the iframe.
---

# Preview connects without a client-side gate

1. The preview pane must not add a wait of its own before the iframe starts to
   load. When the dev server is already serving, the preview must appear as
   quickly as the same URL opened in a browser tab.
2. A preview opened before the dev server listens must recover by itself and
   show the app when the server comes up. The user must not reload, click, or
   wait through a stage that ShipIt puts in front of the page.
3. Exactly one thing decides whether a preview is reachable: the browser's own
   request through the proxy. No second probe may hold a different opinion.
4. While the preview is not reachable yet, the pane must say that it is
   connecting.
5. ShipIt must not report a preview error, or wake auto-fix, for a failure that
   has not proved to be sustained.
6. A preview that stays unreachable must say what it waits for — the port and
   the last connection error — and must not claim that authentication is
   required.

## Open questions

None.

## Resolved questions

- 2026-08-30 — "What does this probe do? Can we remove it or make it not block
  the page?" Nik chose the proxy-side repair: the preview proxy retries the
  upstream connection itself, and the health probe and the client poll are
  deleted. The constraint that comes with the choice is that the repair belongs
  in the proxy, not in a smarter client-side gate — a gate is the thing being
  removed.
