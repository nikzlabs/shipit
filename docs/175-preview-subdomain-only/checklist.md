# Checklist — Subdomain-only previews

## Decisions
- [x] Capability removal confirmed: raw-IP / dotless-without-wildcard-DNS /
      bare-MagicDNS access loses previews (gets a clear empty-state). — approved
- [x] Server `/preview/:id/:port/*` route + WS branch: **delete** (reachability is
      covered by `/api/preview-health`; the route returns misleading broken HTML). — approved
- [ ] Setup-script Tailscale recipe: confirm **sslip.io as default (HTTP)** +
      owned-wildcard-domain as opt-in (HTTPS), and stop pointing users at the
      Tailscale Serve URL for previews. — awaiting sign-off

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

## Tailscale previews (setup script)
- [ ] `deployment/vps/tailscale.sh`: bind ShipIt's listener to the node's
      Tailscale interface IP (`tailscale ip -4`, the `100.x` IP — not `0.0.0.0`)
      so subdomain requests reach the orchestrator over the tailnet.
- [ ] `tailscale.sh`: derive and print the sslip.io URL
      `http://<dashed-100-x>.sslip.io:<port>` (default recipe); add an opt-in
      prompt for an owned wildcard domain (HTTPS).
- [ ] `tailscale.sh`: stop presenting the Tailscale Serve URL as the preview
      entry point (Serve can't carry subdomains); keep Serve only as an optional
      bare-app URL if desired.
- [ ] `deployment/README.md` + `setup.sh` summary: document the sslip.io recipe
      and the owned-domain alternative; note native MagicDNS wildcard as the
      future zero-config path.

## Tests
- [ ] Update/trim `usePreviewHealthPoller` tests for the removed `mode` param.
- [ ] Add a test: container mode + raw-IP `apiHost` → `computePreviewUrl` returns
      null (drives empty-state).
- [ ] Grep for orphaned `previewSubdomains` references after removal.
