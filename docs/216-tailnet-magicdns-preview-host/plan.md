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

When both hold → use `tailnetPreviewHost` for preview subdomains, **forcing the
preview origin to `http:`** (the sslip host has no wildcard TLS cert). Otherwise →
keep today's behavior (`VITE_API_HOST || window.location.host`, inheriting
`window.location.protocol`).

The helper therefore returns **host *and* protocol**, not just a host — preview URL
construction must not inherit `window.location.protocol` blindly, or an HTTPS app
origin would emit `https://{id}--{port}.<sslip>/`, which has no cert (see the
mixed-content constraint under *Non-goals*).

```ts
// resolvePreviewHost(locationHost, bootstrap): the {host, protocol} used to build
// {sessionId}--{port}.<host> preview URLs. Preview call sites ONLY.
export function resolvePreviewHost(
  locationHost: string,
  bootstrap: Bootstrap,
): { host: string; protocol: string } {
  // VITE_API_HOST is a DEV-ONLY override (set only in docker/local/dev/compose.yml,
  // unset in the VPS prod image — see "VITE_API_HOST is dev-only" below).
  if (import.meta.env.VITE_API_HOST) {
    return { host: import.meta.env.VITE_API_HOST, protocol: window.location.protocol };
  }
  const hostname = locationHost.split(":")[0].toLowerCase();
  if (bootstrap.tailnetPreviewHost && hostname.endsWith(".ts.net")) {
    // MagicDNS browsing → sslip previews. Force http: — sslip has no TLS, and the
    // MagicDNS app is itself HTTP, so there is no mixed-content downgrade here.
    return { host: bootstrap.tailnetPreviewHost, protocol: "http:" };
  }
  return { host: locationHost, protocol: window.location.protocol };
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
- `usePreviewHealthPoller.ts` receives `apiHost` as a param and already splits
  `host:port` to build `{sessionId}--{port}.{apiHostname}` via `buildSubdomainUrl()`,
  so a passed-through `host[:port]` works verbatim. **One change is required**:
  `buildSubdomainUrl()` currently hard-codes `window.location.protocol`; it must
  instead accept the resolved `protocol` so the sslip override can force `http:`
  (without it, an HTTPS app would emit an `https://…sslip…` URL with no cert).

**`useSessionWebSocket.ts` and `useServerEvents.ts` are deliberately left
unchanged** — the WS and SSE connections stay on `VITE_API_HOST ||
window.location.host` (the MagicDNS name), so the live channel rides the native
tailnet. This separation is the entire point of a preview-only override.

> **Precondition — `VITE_API_HOST` is dev-only.** Both the "WS/SSE unchanged" claim
> and the `VITE_API_HOST`-first precedence in `resolvePreviewHost()` are correct only
> because `VITE_API_HOST` is **unset in the VPS prod image** — it is set solely in
> `docker/local/dev/compose.yml` (`localhost:3001`) for the in-container dev loop. In
> prod the `|| window.location.host` branch always wins, so WS/SSE land on the
> MagicDNS host and the bootstrap override governs previews. **If any deployment ever
> set `VITE_API_HOST`, it would override *both* surfaces** — pinning WS/SSE *and*
> previews to that one host and bypassing `tailnetPreviewHost` entirely. The VPS prod
> compose must therefore leave `VITE_API_HOST` unset for this feature to hold; that is
> a hard precondition, not an incidental default.

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
change (node re-add, tailnet move). The advertised host must stay in lockstep with
the live forwarding bind, so we close the staleness window **actively** rather than
relying on a process restart.

> **Why a restart-only refresh is not enough.** Today's wrapper resolves `TS_IP`
> once, then `exec socat …,bind=$TS_IP`, and the systemd unit is `Restart=always`.
> But `Restart=always` only re-runs the wrapper if `socat` *exits* — a live tailnet
> IP change does **not** reliably make a bound `socat` exit. So a one-shot
> write-before-exec would leave both the old listener **and** a stale preview-host
> file in place until something forces a restart. Approach B therefore makes the
> forwarder a small **supervisor loop**, which also hardens the forwarding itself.

1. **Forwarder supervises the live host.** The wrapper becomes a poll loop: read
   `tailscale ip -4`; when it differs from the last seen IP, (a) write
   `${TS_IP//./-}.sslip.io` (+ `:PORT` when `LISTEN_PORT != 80`) to
   `/opt/shipit/.tailnet-preview-host`, and (b) restart the child `socat` bound to
   the new IP; then `sleep` (e.g. 10s) and repeat. systemd keeps `Restart=always` on
   the wrapper (now a long-lived supervisor, not an `exec`). This bounds staleness to
   one poll interval and keeps the advertised host and the socat bind refreshed by
   the **same** trigger, so they can never diverge. The file is untracked under
   `/opt/shipit`, so it survives UI "Update Now" (`git reset --hard`), exactly like
   `.release-channel`.
2. **Orchestrator reads it per bootstrap.** The orchestrator already mounts
   `/opt/shipit:/opt/shipit`, so it reads `/opt/shipit/.tailnet-preview-host` (trim
   whitespace; missing/empty → `undefined`) when building `GET /api/bootstrap`, and
   returns it as `tailnetPreviewHost`. Read at request time (cheap) so a refreshed
   file is reflected **without** an orchestrator restart — the self-healing property
   end to end.

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
- `src/client/hooks/usePreviewHealthPoller.ts` — `buildSubdomainUrl()` takes the resolved `protocol` (instead of reading `window.location.protocol`) so the sslip override can force `http:`.
- Bootstrap route + `Bootstrap` type — add `tailnetPreviewHost?: string`, read from `/opt/shipit/.tailnet-preview-host`.
- `deployment/vps/tailscale.sh` — forwarder wrapper becomes a supervisor loop (polls `tailscale ip -4`, rewrites `/opt/shipit/.tailnet-preview-host` and rebinds `socat` on change); printed instructions point the app at the MagicDNS name with previews via sslip.io.
- `docs/175-preview-subdomain-only` — cross-reference this hybrid.

## Non-goals / tradeoffs

- **Not a replacement for the grant.** If a tailnet gets `dns-subdomain-resolve`,
  all-MagicDNS (no sslip at all) is still the cleaner end state; this override exists
  for tailnets that can't get it. When the capability goes GA, this can be revisited.
- **Previews remain HTTP** over the sslip host (no wildcard TLS for those names),
  same as today's sslip default. The app/WS gain nothing/lose nothing on TLS here —
  they were already HTTP over the tailnet on the MagicDNS name.
- **The hybrid requires the app served over HTTP** (the default MagicDNS forwarder on
  port 80). The sslip preview origin is forced to `http:`, and a browser **blocks an
  HTTPS page from embedding an HTTP iframe** (mixed content). So this override is
  incompatible with an HTTPS app origin (e.g. Tailscale Serve's node cert, or an
  owned-domain HTTPS front): with HTTPS in front you must use the owned-wildcard-domain
  HTTPS preview path (`docs/175`) instead, where app and previews are both HTTPS. The
  `.ts.net` detection guard naturally scopes the override to the HTTP MagicDNS case.
- **sslip.io stays in the preview resolution path** (DNS-trust caveat from `docs/175`
  still applies) — but now *only* for preview iframes, not the app/auth/WS surface.
- **Client picks up a changed host on its next bootstrap, not live.** The server
  self-heals at request time, but the SPA reads `tailnetPreviewHost` once per
  `GET /api/bootstrap` (page load / reconnect) and keys preview slots by
  `sessionId:port`. An *already-open* tab would keep the old host until its next
  bootstrap. This is acceptable and not worth an SSE push + slot invalidation: a
  tailnet IP change tears down the very WireGuard path the open tab is using
  (the browser was talking to the old `100.x`), so the user reconnects over the
  new IP — a fresh load that re-bootstraps — as a direct consequence of the
  change. The window where the tab is open *and* still reachable *and* stale does
  not occur in practice.
