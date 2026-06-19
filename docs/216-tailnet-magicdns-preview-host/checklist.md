# Checklist

- [ ] `resolvePreviewHost()` helper in `src/client/utils/` (VITE_API_HOST precedence → `.ts.net` + `tailnetPreviewHost` override → location.host)
- [ ] Unit test for `resolvePreviewHost()` covering the truth table (Cloudflare, sslip-direct, MagicDNS, MagicDNS-unconfigured, localhost)
- [ ] Wire helper into `PreviewFrame.tsx` and `PreviewServicesDrawer.tsx` (preview call sites only; leave WS/SSE on location.host)
- [ ] Add `tailnetPreviewHost?: string` to the `Bootstrap` type + `/api/bootstrap` response, read from `/opt/shipit/.tailnet-preview-host`
- [ ] Integration test: bootstrap surfaces `tailnetPreviewHost` when the file is present, omits it when absent
- [ ] `deployment/vps/tailscale.sh`: forwarder wrapper writes `/opt/shipit/.tailnet-preview-host` each start; `bash -n` passes
- [ ] `tailscale.sh` printed output: app at MagicDNS name, previews via sslip.io (and keep the sslip-direct path documented)
- [ ] Cross-reference from `docs/175-preview-subdomain-only`
- [ ] `npm run typecheck` + `npm run lint:dev` clean
