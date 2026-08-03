# Agent Interface SDK test preview

A tiny service preview that exercises `window.shipit` (docs/242) end to end. It exists
because the SDK's Preview path only really exists inside a proxied, cross-origin service
iframe — the bootstrap is injected by `preview-proxy.ts`, transpiled by whatever loader
the orchestrator runs under, and handshakes with `PreviewFrame` across origins. Two
production bugs lived in exactly the gap between that and the unit tests.

## Inside ShipIt

```
shipit service start sdk-test
```

Then open the preview. The page reports whether the SDK installed, whether the handshake
resolved, the current visibility, and can send a real message to the session's agent.

The page inlines the bootstrap from this checkout instead of waiting for the proxy to
inject it (`injectPreviewBootstrap` skips a response that already carries the marker), so
a bootstrap fix can be verified against production ShipIt before the orchestrator ships.

## Outside ShipIt

`--harness` also serves a stand-in ShipIt host that embeds the page cross-origin and
answers the `ready` / `visibility` / `agent_message` protocol the way `PreviewFrame` does:

```
node --import tsx test-preview/server.ts --harness
```

Open the printed harness URL. Use `node --import tsx` rather than plain `tsx`: it matches
the production orchestrator's loader (`docker/Dockerfile.prod`), which is what determines
how the bootstrap is serialized.

## What to check

- **window.shipit** — `installed`. `missing` means the injected script threw before
  defining the global; the browser console names the reference.
- **ready** — `resolved`. `rejected: … timed out` means the child's `ready` post never
  reached the host, or the host never answered it.
- **Navigate within the preview** — follow the link, then send again. This is the
  regression that broke the SDK for any multi-page or reloading app: the reloaded
  document's `document.referrer` becomes the preview's own origin.
