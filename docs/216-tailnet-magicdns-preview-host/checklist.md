# Checklist

- [x] `resolvePreviewHost()` helper in `src/client/utils/` returning `{host, protocol}` (VITE_API_HOST precedence → `.ts.net` + `tailnetPreviewHost` override forcing `http:` → location.host)
- [x] `buildSubdomainUrl()` in `usePreviewHealthPoller.ts` takes the resolved `protocol` instead of reading `window.location.protocol`
- [x] Unit test for `resolvePreviewHost()` covering the truth table (Cloudflare, sslip-direct, MagicDNS→http override, MagicDNS-unconfigured, localhost)
- [x] Wire helper into `PreviewFrame.tsx` and `PreviewServicesDrawer.tsx` (preview call sites only; leave WS/SSE on location.host)
- [x] Confirm the VPS prod image leaves `VITE_API_HOST` unset (set only in `docker/local/dev/compose.yml`); this is a precondition for the override + WS/SSE behavior
- [x] Add `tailnetPreviewHost?: string` to the `Bootstrap` type + `/api/bootstrap` response, read from `/opt/shipit/.tailnet-preview-host`
- [x] Integration test: bootstrap surfaces `tailnetPreviewHost` when the file is present, omits it when absent (also rejects garbage content)
- [x] `deployment/vps/tailscale.sh`: forwarder wrapper becomes a supervisor loop (polls `tailscale ip -4`, rewrites `/opt/shipit/.tailnet-preview-host` + rebinds `socat` on change; `Restart=always` on the wrapper); `bash -n` passes (outer + rendered inner)
- [x] `tailscale.sh` printed output: app at MagicDNS name with previews via sslip.io (and keep the sslip-direct path documented)
- [x] Cross-reference from `docs/175-preview-subdomain-only`
- [x] `npm run typecheck` + `npm run lint:dev` clean
- [x] Code review (Codex): signal/socat cleanup, host-validation tightening, client-refresh boundary documented
- [ ] **Runtime verify on a real Tailscale VPS** — a live IP change refreshes both the socat bind and the preview-host file within one poll interval (no manual restart); MagicDNS app URL yields working previews. (Cannot be done in-session; verify on deploy.)
