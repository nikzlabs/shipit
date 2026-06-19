---
issue: https://linear.app/shipit-ai/issue/SHI-177
title: Tailscale MagicDNS app + sslip.io previews (preview-host override)
description: Serve the app/WS on the node's native MagicDNS name while routing only preview iframes through sslip.io, self-healing on tailnet IP changes.
---

# Tailscale MagicDNS app + sslip.io previews

## Problem

Over Tailscale a VPS can serve ShipIt three ways (see `docs/175`, commit `01d2acc5`):

- **sslip.io** (`100-x-y-z.sslip.io`) — works today, no ACL grant, but the app URL
  itself depends on a third-party resolver, and it's HTTP-only.
- **Native MagicDNS** (`<node>.<tailnet>.ts.net`) — clean, no third-party resolver,
  **but preview subdomains** (`{id}--{port}.<node>.ts.net`) need the
  `dns-subdomain-resolve` node attribute, which Tailscale **gates per-tailnet** and
  is still rolling out. On most tailnets the grant is rejected, so previews break.

The node's *own* MagicDNS name resolves with **no** grant — only the **wildcard**
preview subdomains need it. So we want a hybrid: **app + WebSocket on the native
MagicDNS name, and only the preview iframes routed through sslip.io.** That keeps
auth, the terminal, secrets, and the live WS on the pure WireGuard tailnet (no
third-party resolver), and confines sslip.io to sandboxed preview frames.

This is *not* expressible with the existing `VITE_API_HOST` override: it is
build-time, global, and also moves the WS/SSE connection — it would force *every*
access path (including Cloudflare) onto one host. We need a runtime, preview-only,
per-instance override.

## Client-side detection — when is the page in "tailscale + sslip" state?

The client applies the sslip preview host **only** when **both** signals hold:

1. **The server advertises an sslip preview host** — `bootstrap.tailnetPreviewHost`
   is a non-empty `host[:port]` string. It is populated only when the VPS forwarder
   is configured (see *Server* below), i.e. "there is a known sslip host that
   resolves to this node over the tailnet."
2. **The page is viewed over the node's native MagicDNS name** —
   `window.location.hostname` (lower-cased, port stripped) ends with `.ts.net`.
   This is exactly the case where previews built on the current host would land on
   `{id}--{port}.<node>.ts.net` and fail to resolve without the gated capability.

When both hold → use `tailnetPreviewHost` for preview subdomains. Otherwise → keep
today's behavior (`VITE_API_HOST || window.location.host`).

```ts
// resolvePreviewHost(locationHost, bootstrap): the host used to build
// {sessionId}--{port}.<host> preview URLs. Preview call sites ONLY.
export function resolvePreviewHost(locationHost: string, bootstrap: Bootstrap): string {
  if (import.meta.env.VITE_API_HOST) return import.meta.env.VITE_API_HOST; // dev/compose wins
  const hostname = locationHost.split(":")[0].toLowerCase();
  if (bootstrap.tailnetPreviewHost && hostname.endsWith(".ts.net")) {
    return bootstrap.tailnetPreviewHost; // MagicDNS browsing → sslip previews
  }
  return locationHost;
}
```

### Why AND both — the safety property

The `.ts.net` guard is what makes the override **safe**: it can never hijack a
preview path that already works. Truth table:

| Browsing host | `tailnetPreviewHost` set | host ends `.ts.net` | Preview host used | Correct |
|---|---|---|---|---|
| Cloudflare `shipit.example.com` | yes | no | `shipit.example.com` | ✓ Cloudflare wildcard resolves |
| sslip `100-x-y-z.sslip.io` | yes | no | `100-x-y-z.sslip.io` (= location) | ✓ already sslip |
| MagicDNS `node.tailnet.ts.net` | yes | yes | `100-x-y-z.sslip.io` (**override**) | ✓ the fix |
| MagicDNS, forwarder not configured | no | yes | `node.tailnet.ts.net` (= location) | ✓ falls back; resolves only with the grant |
| localhost dev | no | no | location | ✓ unchanged |

The override is strictly additive: every row that worked before still uses the same
host. Only the previously-broken MagicDNS row changes. Because the discriminator is
the *current* `location.host`, a Cloudflare user and a MagicDNS user hitting the
same instance simultaneously each get the right preview host — the property the
global `VITE_API_HOST` could not provide.

### Where it plugs in

`resolvePreviewHost()` replaces the `apiHost` computation at the **preview call
sites only**:

- `PreviewFrame.tsx` (`apiHost`, currently `VITE_API_HOST || window.location.host`)
- `PreviewServicesDrawer.tsx` (`API_HOST`)
- `usePreviewHealthPoller.ts` receives `apiHost` as a param — no change there; it
  already splits `host:port` and builds `{sessionId}--{port}.{apiHostname}` via
  `buildSubdomainUrl()`, so a passed-through `host[:port]` works verbatim.

**`useSessionWebSocket.ts` and `useServerEvents.ts` are deliberately left
unchanged** — the WS and SSE connections stay on `VITE_API_HOST ||
window.location.host` (the MagicDNS name), so the live channel rides the native
tailnet. This separation is the entire point of a preview-only override.

### Edge cases

- **`VITE_API_HOST` precedence.** Kept first, so local dev / Compose is untouched.
- **`.ts.net` suffix.** Matched case-insensitively with the port stripped; MagicDNS
  FQDNs are always `*.ts.net`.
- **Port.** `tailnetPreviewHost` carries ShipIt's own `host[:port]` verbatim (e.g.
  `100-x-y-z.sslip.io` on port 80, or `…:4123` otherwise). `buildSubdomainUrl()`
  already separates the port.
- **Raw tailnet IP browsing (`100.x.y.z`).** Does not end in `.ts.net` → no override
  → the existing dotted-IPv4 guard in `buildSubdomainUrl()` returns `null` (empty
  state). Pre-existing behavior; out of scope (browsing the app by raw IP is
  degenerate — `100.x.y.z` can't carry the app's own subdomains either).

## Server — self-healing preview host (approach B)

The advertised host derives from the node's **tailnet IP**, which is stable but can
change (node re-add, tailnet move). The Tailscale forwarder already self-heals an IP
change — its wrapper re-reads `tailscale ip -4` on every start (`tailscale.sh:139`).
We extend that same self-heal to the advertised host so there is **no static
snapshot to go stale and no rerun required**:

1. **Forwarder writes the live host.** The wrapper, after resolving `TS_IP`, writes
   `${TS_IP//./-}.sslip.io` (+ `:PORT` when `LISTEN_PORT != 80`) to
   `/opt/shipit/.tailnet-preview-host` before `exec socat`. An IP change rewrites
   this file on the next forwarder restart — the same restart that already re-points
   the forwarding. Untracked file under `/opt/shipit`, so it survives UI "Update
   Now" (`git reset --hard`), exactly like `.release-channel`.
2. **Orchestrator reads it per bootstrap.** The orchestrator already mounts
   `/opt/shipit:/opt/shipit`, so it reads `/opt/shipit/.tailnet-preview-host` (trim
   whitespace; missing/empty → `undefined`) when building `GET /api/bootstrap`, and
   returns it as `tailnetPreviewHost`. Read at request time (cheap) so a forwarder
   restart is reflected **without** an orchestrator restart — the self-healing
   property end to end.

No `shipit.env` line and no Compose env passthrough are needed: the value travels
through the existing `/opt/shipit` mount as a file, not through process env. This is
strictly simpler and more robust than approach A (a static `shipit.env` write that
required a rerun + orchestrator restart on IP change).

Writing the file unconditionally whenever the forwarder runs is harmless: the client
only *uses* it when browsing over `.ts.net`, so an sslip-direct or Cloudflare user is
unaffected.

## Key files

- `src/client/utils/` — new `resolvePreviewHost()` helper (+ unit test).
- `src/client/components/PreviewFrame/PreviewFrame.tsx` — use the helper for `apiHost`.
- `src/client/components/PreviewServicesDrawer.tsx` — use the helper for `API_HOST`.
- `src/client/hooks/usePreviewHealthPoller.ts` — `buildSubdomainUrl()` unchanged (consumes resolved host).
- Bootstrap route + `Bootstrap` type — add `tailnetPreviewHost?: string`, read from `/opt/shipit/.tailnet-preview-host`.
- `deployment/vps/tailscale.sh` — forwarder wrapper writes the host file each start; printed instructions point the app at the MagicDNS name with previews via sslip.io.
- `docs/175-preview-subdomain-only` — cross-reference this hybrid.

## Non-goals / tradeoffs

- **Not a replacement for the grant.** If a tailnet gets `dns-subdomain-resolve`,
  all-MagicDNS (no sslip at all) is still the cleaner end state; this override exists
  for tailnets that can't get it. When the capability goes GA, this can be revisited.
- **Previews remain HTTP** over the sslip host (no wildcard TLS for those names),
  same as today's sslip default. The app/WS gain nothing/lose nothing on TLS here —
  they were already HTTP over the tailnet on the MagicDNS name.
- **sslip.io stays in the preview resolution path** (DNS-trust caveat from `docs/175`
  still applies) — but now *only* for preview iframes, not the app/auth/WS surface.
