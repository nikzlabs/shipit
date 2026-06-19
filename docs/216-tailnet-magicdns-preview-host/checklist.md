# Checklist

- [ ] `resolvePreviewHost()` helper in `src/client/utils/` returning `{host, protocol}` (VITE_API_HOST precedence → `.ts.net` + `tailnetPreviewHost` override forcing `http:` → location.host)
- [ ] `buildSubdomainUrl()` in `usePreviewHealthPoller.ts` takes the resolved `protocol` instead of reading `window.location.protocol`
- [ ] Unit test for `resolvePreviewHost()` covering the truth table (Cloudflare, sslip-direct, MagicDNS→http override, MagicDNS-unconfigured, localhost)
- [ ] Wire helper into `PreviewFrame.tsx` and `PreviewServicesDrawer.tsx` (preview call sites only; leave WS/SSE on location.host)
- [ ] Confirm the VPS prod image leaves `VITE_API_HOST` unset (set only in `docker/local/dev/compose.yml`); this is a precondition for the override + WS/SSE behavior
- [ ] Add `tailnetPreviewHost?: string` to the `Bootstrap` type + `/api/bootstrap` response, read from `/opt/shipit/.tailnet-preview-host`
- [ ] Integration test: bootstrap surfaces `tailnetPreviewHost` when the file is present, omits it when absent
- [ ] `deployment/vps/tailscale.sh`: forwarder wrapper becomes a supervisor loop (polls `tailscale ip -4`, rewrites `/opt/shipit/.tailnet-preview-host` + rebinds `socat` on change; `Restart=always` on the wrapper); `bash -n` passes
- [ ] Verify a live tailnet IP change refreshes both the socat bind and the preview-host file within one poll interval (no manual restart)
- [ ] `tailscale.sh` printed output: app at MagicDNS name, previews via sslip.io (and keep the sslip-direct path documented)
- [ ] Cross-reference from `docs/175-preview-subdomain-only`
- [ ] `npm run typecheck` + `npm run lint:dev` clean
