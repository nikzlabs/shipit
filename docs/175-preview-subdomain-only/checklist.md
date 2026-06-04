# Checklist — Subdomain-only previews

## Decisions to confirm before coding
- [ ] Confirm the capability removal: raw-IP / dotless-without-wildcard-DNS /
      bare-MagicDNS access loses previews (gets an empty-state). Sign-off needed.
- [ ] Which Tailscale option(s) should the empty-state copy + `deployment/README.md`
      recommend (A native MagicDNS wildcard / B sslip.io / C owned wildcard domain)?
- [ ] Delete the server `/preview/:id/:port/*` route + WS branch, or keep as a
      diagnostic? (Plan leans delete.)

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

## Tests
- [ ] Update/trim `usePreviewHealthPoller` tests for the removed `mode` param.
- [ ] Add a test: container mode + raw-IP `apiHost` → `computePreviewUrl` returns
      null (drives empty-state).
- [ ] Grep for orphaned `previewSubdomains` references after removal.
