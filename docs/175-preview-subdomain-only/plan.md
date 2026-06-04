---
title: Subdomain-only previews (remove path-based fallback and the auto/always mode)
description: Drop the broken path-based preview iframe fallback and the previewSubdomains auto/always switch; standardize on subdomain routing with a clear empty-state when a host can't carry wildcard subdomains.
---

# Subdomain-only previews

## Summary

ShipIt renders Compose-service previews in an iframe. There are two routing
strategies in the code:

- **Subdomain routing** (`{sessionId}--{port}.{host}`) — the working path.
  Absolute asset paths (`/assets/index.js`, `/@vite/client`,
  `/gradio_api/...`) resolve naturally against the subdomain origin, so any
  framework works without HTML rewriting.
- **Path-based routing** (`/preview/{sessionId}/{port}/`) — a fallback the
  client uses when it can't build a subdomain URL. **It does not work for real
  apps.** The proxy injects only the HMR WebSocket shim into HTML; it does *not*
  inject a `<base href>` or rewrite absolute paths. So the container's root HTML
  loads, but every absolute asset/API URL resolves against the IDE origin
  *without* the `/preview/{id}/{port}` prefix and 404s. It only ever "works" for
  a trivial app whose every URL is relative — which Vite, Gradio, Dash, Streamlit
  are not.

This was surfaced by the Gradio preview bug (`docs`-adjacent, PR for the
`X-Forwarded-Host` proxy fix): under path-based routing Gradio computed
`localhost:7860/gradio_api/...` and failed with `ERR_CONNECTION_REFUSED`. The
forwarded-header fix made the **subdomain** path correct; this doc removes the
**path-based** path entirely because it can't be made correct without a much
larger HTML-rewriting effort we don't want to own.

Removing path-based also removes the reason the `previewSubdomains`
`auto`/`always` mode exists (its only differentiated behavior is "fall back to
path-based for risky hostnames"), so we collapse to subdomain-only and retire
the env var.

## Rationale

### Why path-based can't stay as a "best effort"

A fallback that silently 404s an app's assets is worse than an honest "preview
isn't available over this host" message: it looks like the app is broken, not
like the *access method* is unsupported. Keeping it also keeps the `mode` knob,
the `/preview/:id/:port/*` route, its WS-upgrade branch, and the bootstrap
plumbing alive purely to serve a broken path.

### Why removing `mode` follows (but isn't strictly forced)

Removing path-based doesn't *force* removing `mode` — post-removal, `mode` could
still gate "attempt a subdomain (`always`) vs show a clean message (`auto`)" for
dotless/Tailscale hosts. But that distinction isn't worth a config knob:
"always attempt the subdomain, let the existing load-failure detection surface
the error" is simpler and *more* correct, because `auto` currently hides a
working option from operators who *did* provision wildcard DNS on a dotless host.
So `mode` becomes vestigial and we remove it.

### What survives the change

1. **`preview.url` (`/preview/{id}/{port}/`) stays as a field.** It is not only
   the (removed) render target — it is the **container-mode sentinel**
   (`startsWith("/preview/")`) that distinguishes a Compose preview from the
   legacy in-process `http://localhost:port` path. We delete only the
   `?? preview.url` *render fallback*, not the field or the sentinel.
2. **Raw IP / IPv6 still can't be subdomained** (`buildSubdomainUrl` returns
   `null` for them — you cannot make `{id}--{port}.192.168.1.5` resolve). We are
   not deleting the `null` case; we are swapping its consequence from
   "render broken path-based" to "render a clear empty-state."

## The change

### Client

- `src/client/hooks/usePreviewHealthPoller.ts`
  - `computePreviewUrl`: drop `const url = subdomain ?? preview.url` → when
    `subdomain` is `null` in container mode, return `null` (no slot created).
  - `buildSubdomainUrl`: remove the `mode` parameter and the
    `if (mode !== "always") { … return null }` block. **Keep** the raw-IP/IPv6
    `return null` guard. Remove the `PreviewSubdomainMode` type.
- `src/client/components/PreviewFrame.tsx`
  - Remove `previewSubdomainMode` (`useUiStore`) and its threading into the
    poller and `buildSubdomainUrl`.
  - Add an **empty-state** for "container-mode preview, but this host can't carry
    a wildcard subdomain" (i.e. `isContainerMode && activePort && preview.running
    && buildSubdomainUrl(...) === null`). Copy: explain that previews need a
    hostname with wildcard DNS (localhost, a wildcard domain, or one of the
    Tailscale options below), not a raw IP.
- `src/client/stores/ui-store.ts` — remove `previewSubdomains` field, default,
  and `setPreviewSubdomains`.
- `src/client/App.tsx` — remove the `previewSubdomains` bootstrap wiring.

### Server

- `src/server/orchestrator/services/misc.ts` — remove
  `resolvePreviewSubdomainsMode()` and the `previewSubdomains` bootstrap field.
- `src/server/orchestrator/services/types.ts` — remove the bootstrap field.
- `src/server/orchestrator/preview-proxy.ts` — **judgment call:** the
  `/preview/:sessionId/:port/*` HTTP route and its WS-upgrade branch are now
  unused by the iframe (the health poll uses the separate
  `/api/preview-health/...`). Options: (a) delete them for cleanliness, or
  (b) keep them as a cheap diagnostic escape hatch. Leaning **delete**, since a
  route nothing renders through is a maintenance liability and a source of the
  "but it half-works" confusion this doc is resolving.

### Deployment & docs

- `deployment/vps/docker-compose.yml` — remove `SHIPIT_PREVIEW_SUBDOMAINS=always`
  (subdomain routing is now unconditional).
- `deployment/README.md` — rewrite the Tailscale note: wildcard preview DNS is
  now an **unconditional** requirement for previews (not a mode-gated one), and
  point at the Tailscale options below.
- `src/server/shipit-docs/preview.md` / `compose.md` — note that previews are
  subdomain-routed and require a wildcard-resolvable host.

## Tradeoff (the capability being removed)

After this change, hosts that **cannot carry a wildcard subdomain** lose
previews entirely (replaced by a clear empty-state / load error):

- raw IP / IPv6 access (`http://192.168.1.5:3000`);
- dotless/Tailscale hostnames **without** wildcard DNS.

Because path-based only ever limped for trivial relative-URL apps, the only real
loss is "a trivial app over those hosts no longer even partially renders." This
is a deliberate, documented capability removal. Standard `localhost` dev and
standard Cloudflare (dotted-domain + wildcard) deployments are **unaffected** —
they already use subdomain routing.

## Tailscale options

Previews need `{sessionId}--{port}.{host}` to resolve. Bare Tailscale MagicDNS
gives you `host.tailnet.ts.net` but historically **no** `*.host`. The options,
in rough order of "least setup" → "most robust":

### Option A — Native MagicDNS wildcard (new, cleanest long-term)

Tailscale merged wildcard subdomain resolution into MagicDNS
([tailscale/tailscale#1196](https://github.com/tailscale/tailscale/issues/1196),
PR #18258, merged **2026-01-30**): a `dns-subdomain-resolve` node capability
makes `*.machine.tailnet.ts.net` resolve to that machine's IP
([MagicDNS docs](https://tailscale.com/docs/features/magicdns)). Once available,
`{id}--{port}.host.tailnet.ts.net` resolves with **zero external DNS**, and
ShipIt's existing subdomain proxy parses it unchanged.

- **Pros:** no external infra, keeps the clean MagicDNS name, future-proof.
- **Cons:** brand-new — as of research it was merged but unreleased (latest was
  v1.94.1; expected ~v1.96+), so it requires a recent Tailscale on **both** the
  node and the client. **No wildcard TLS** (tracked separately,
  [tailscale#7081](https://github.com/tailscale/tailscale/issues/7081)) → HTTP
  only, which is fine because tailnet traffic is already WireGuard-encrypted.

### Option B — `sslip.io` / `nip.io` magic wildcard DNS (zero setup, works today)

[sslip.io / nip.io](https://sslip.io/) resolve any hostname with an embedded IP
to that IP, with no configuration. Open ShipIt at
`http://100-64-1-2.sslip.io:3000` (dash notation of the node's Tailscale
`100.x.y.z` IP — dash notation avoids the left-to-right dotted-IP ambiguity
[nip.io notes](https://nip.io/)). Previews then resolve at
`{id}--{port}.100-64-1-2.sslip.io`, which ShipIt's subdomain regex
(`{uuid}--{port}.anything`) already matches — **no proxy changes**.

- **Pros:** works **today** on any Tailscale version, zero DNS/infra to own.
- **Cons:** depends on a third-party resolver (or self-host sslip.io — it's open
  source); **no wildcard TLS** (HTTP only, acceptable over the tailnet); some
  resolvers with DNS-rebinding protection refuse to resolve public names to
  CGNAT `100.64/10` space — sslip.io serves these, but a hardened local resolver
  may block it.

### Option C — Owned wildcard domain pointing at the Tailscale IP (most robust, current prod recipe)

Own a domain, add `*.shipit-tail.example.com` → the node's Tailscale `100.x` IP,
open ShipIt through that hostname. This is what `deployment/README.md` already
documents for production.

- **Pros:** real **wildcard TLS** via DNS-01 (so HTTPS previews work), fully
  under your control, no third-party at request time.
- **Cons:** requires owning a domain + a DNS provider + cert management.

### Option D — Tailscale Serve (rejected for multi-port previews)

[`tailscale serve`](https://tailscale.com/docs/reference/tailscale-cli/serve)
can reverse-proxy a local service and provision a per-node `*.ts.net` cert, but
DNS names are restricted to `device.tailnet.ts.net` — **no per-service
subdomains**. You'd have to route by sub-path, which is exactly the broken
path-based model we're removing. Not viable for `{id}--{port}` previews.

### Recommendation

- **Today / any version:** Option B (`sslip.io`) for an individual, Option C
  (owned wildcard domain) for a team/prod that wants HTTPS.
- **Going forward:** Option A (native MagicDNS wildcard) once a Tailscale release
  carrying it is widely deployed — then bare MagicDNS "just works" and we can
  simplify the docs.

The empty-state copy should link to these so a Tailscale user who hits it has a
concrete next step rather than a dead end.

## Rejected alternatives

- **Fix path-based properly** (inject `<base href="/preview/{id}/{port}/">` or
  rewrite absolute paths in the proxy's HTML pass). This would make path-based
  actually render, but base-href breaks apps that build URLs in JS from
  `location.origin`, and full absolute-path rewriting (HTML + CSS + JS-emitted
  URLs) is a large, fragile surface. Subdomain routing sidesteps all of it.
  Not worth owning when wildcard DNS is cheap (Options A–C).
- **Keep `mode`.** Covered above — vestigial once path-based is gone.

## Key files

| File | Role |
|---|---|
| `src/client/hooks/usePreviewHealthPoller.ts` | `buildSubdomainUrl` / `computePreviewUrl` — the fallback + mode removal |
| `src/client/components/PreviewFrame.tsx` | iframe slot rendering + new empty-state |
| `src/client/stores/ui-store.ts` | `previewSubdomains` field removal |
| `src/client/App.tsx` | bootstrap wiring removal |
| `src/server/orchestrator/services/misc.ts` / `types.ts` | bootstrap field + `resolvePreviewSubdomainsMode` removal |
| `src/server/orchestrator/preview-proxy.ts` | optional `/preview/:id/:port/*` route + WS branch removal |
| `deployment/vps/docker-compose.yml`, `deployment/README.md` | env var removal + Tailscale guidance |
