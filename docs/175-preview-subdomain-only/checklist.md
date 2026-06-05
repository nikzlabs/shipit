# Checklist — Subdomain-only previews

## Decisions
- [x] Capability removal confirmed: raw-IP / dotless-without-wildcard-DNS /
      bare-MagicDNS access loses previews (gets a clear empty-state). — approved
- [x] Server `/preview/:id/:port/*` route + WS branch: **delete** (reachability is
      covered by `/api/preview-health`; the route returns misleading broken HTML). — approved
- [x] Setup-script Tailscale recipe: **Option A (native MagicDNS wildcard) only**
      — native wildcard is GA (stable v1.98.5). Drop Serve from the preview path;
      no sslip.io / owned-domain automation. HTTP over the tailnet. — approved

## Client
- [ ] `usePreviewHealthPoller.ts`: drop `?? preview.url`; return `null` when
      `subdomain` is null in container mode.
- [ ] `usePreviewHealthPoller.ts`: remove `mode` param + `mode !== "always"`
      block from `buildSubdomainUrl`; keep the raw-IP/IPv6 guard; remove
      `PreviewSubdomainMode`.
- [ ] `PreviewFrame.tsx`: remove `previewSubdomainMode` wiring; add the
      "host can't carry wildcard subdomain previews" empty-state.
- [ ] `ui-store.ts`: remove `previewSubdomains` field/default/setter.
- [ ] `App.tsx`: remove `previewSubdomains` bootstrap wiring.

## Server
- [ ] `services/misc.ts`: remove `resolvePreviewSubdomainsMode` + bootstrap field.
- [ ] `services/types.ts`: remove bootstrap field.
- [ ] `preview-proxy.ts`: (optional) remove path-based route + WS branch.

## Deployment & docs
- [ ] `deployment/vps/docker-compose.yml`: remove `SHIPIT_PREVIEW_SUBDOMAINS=always`.
- [ ] `deployment/README.md`: rewrite Tailscale note; link the Tailscale options.
- [ ] `shipit-docs/preview.md` / `compose.md`: note subdomain-only requirement.

## Tailscale previews (setup script) — Option A only
- [x] `deployment/vps/tailscale.sh`: Host-preserving `socat` forwarder (systemd
      unit + wrapper) bound to the node's tailnet IP (`tailscale ip -4`, not
      `0.0.0.0`) → `127.0.0.1:4123`; wrapper re-reads the IP so re-auth self-heals.
- [x] `tailscale.sh`: drop Tailscale Serve from the preview path; single URL is
      `http://shipit.tailnet.ts.net:4123` (app + previews, one origin).
- [x] `tailscale.sh`: print the `dns-subdomain-resolve` `nodeAttrs` block
      (targeting the node IP) + admin-console link; note the v1.96+ requirement.
- [x] `deployment/README.md` + `setup.sh` closing message: document Option A;
      mention the owned-domain alternative as a manual HTTPS option.
- [ ] Manual verification on a real tailnet: add the grant, open
      `http://shipit.tailnet.ts.net:4123`, confirm a preview subdomain resolves
      and renders. (Cannot be done from this container.)
- [ ] Decide whether to drop `SHIPIT_PREVIEW_SUBDOMAINS=always` only *after* the
      client mode-removal lands (Option A needs `.ts.net` subdomains built; today
      that requires `always`).

## Tests
- [ ] Update/trim `usePreviewHealthPoller` tests for the removed `mode` param.
- [ ] Add a test: container mode + raw-IP `apiHost` → `computePreviewUrl` returns
      null (drives empty-state).
- [ ] Grep for orphaned `previewSubdomains` references after removal.
