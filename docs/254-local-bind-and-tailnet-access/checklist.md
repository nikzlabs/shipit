# Checklist — local bind address and Tailscale access

- [x] `requirements.md` written from the human's own words, with both answers recorded as dated receipts
- [x] `docker/local/prod/compose.yml` binds `${SHIPIT_BIND_ADDR:-127.0.0.1}` (req 1, 2)
- [x] `lib.sh`: `shipit_refresh_tailnet_bind()` re-derives the tailnet binding at every start (req 5, 6)
- [x] `lib.sh`: `shipit_compose_files()` threads the generated overlay through every compose call
- [x] `lib.sh`: `|| true` on the `tailscale ip` substitution so a disconnected daemon can't abort `set -e` callers (req 5)
- [x] `deployment/local/tailscale.sh` — opt in, print the sslip.io URL (req 4)
- [x] `setup.sh` output points at `tailscale.sh` and states the loopback default
- [x] `.gitignore`: `.shipit.env` + generated overlay, unblocking `update.sh` (req 9)
- [x] `suggestWildcardHost()` + preview empty state names a usable host (req 8)
- [x] `SECURITY-MODEL.md` describes the real default and both opt-ins (req 7)
- [x] `README.md` + `deployment/README.md` remote-access sections (req 7)
- [x] `CLAUDE.md` preview-routing paragraph corrected (path-based fallback was deleted in docs/175)
- [x] Tests: `local-install-bind.test.ts` (7) drives the real `lib.sh` against a stubbed `tailscale`
- [x] Tests: `preview-host.test.ts` extended for `suggestWildcardHost` (7 new)
- [x] `npm run lint:dev` + `npm run typecheck` clean
- [x] Independent requirements review by a fresh-context reviewer

## Deliberately not done

- **Removing the `4124:5173` mapping.** Nothing listens on 5173 in the prod image — the client is
  built at image-build time and served from `dist/client/` on 4123, and `EXPOSE 3000 5173` in
  `Dockerfile.prod` is stale metadata. The mapping is narrowed to the bind variable rather than
  deleted, because deleting it is beyond what was asked and wants its own change.
- **A `SHIPIT_BIND_ADDR` equivalent for the VPS.** It already binds `127.0.0.1` behind Caddy plus
  Zero Trust or the tailnet forwarder, so there is no exposed port to harden.
- **Reusing the docs/216 `.tailnet-preview-host` mechanism.** It exists to serve the app on a native
  MagicDNS `.ts.net` name while routing only preview iframes through sslip.io, and is hard-gated to
  `.ts.net` browsing. Here the user browses the sslip host directly, so it would be inert.
