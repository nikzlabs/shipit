# Checklist — Subdomain-only previews

## Decisions
- [x] Capability removal confirmed: raw-IP / dotless-without-wildcard-DNS /
      bare-MagicDNS access loses previews (gets a clear empty-state). — approved
- [x] Server `/preview/:id/:port/*` route + WS branch: **delete** (reachability is
      covered by `/api/preview-health`; the route returns misleading broken HTML). — approved
- [x] Setup-script Tailscale recipe: **Option A (native MagicDNS wildcard) only**
      — native wildcard is GA (stable v1.98.5). Drop Serve from the preview path;
      no sslip.io / owned-domain automation. HTTP over the tailnet. — approved
- [x] **Revised 2026-06:** Option A's `dns-subdomain-resolve` attr turned out to
      be **gated per-tailnet at the control plane** (Save → "tailnet is not
      permitted to use the 'dns-subdomain-resolve' node attribute"), so it can't
      be the zero-touch default. Script now **defaults to sslip.io** (Option B):
      `http://<dashed-tailnet-ip>.sslip.io:<port>`, previews resolve with no
      policy edit; Option A demoted to optional "cleaner hostname" upgrade,
      Option C (owned domain) the HTTPS path. No client/proxy changes needed.

## Client
- [x] `usePreviewHealthPoller.ts`: drop `?? preview.url`; return `null` when
      `subdomain` is null in container mode.
- [x] `usePreviewHealthPoller.ts`: remove `mode` param + `mode !== "always"`
      block from `buildSubdomainUrl`; keep the raw-IP/IPv6 guard; remove
      `PreviewSubdomainMode`.
- [x] `PreviewFrame.tsx`: remove `previewSubdomainMode` wiring; add the
      "host can't carry wildcard subdomain previews" empty-state.
- [x] `ui-store.ts`: remove `previewSubdomains` field/default/setter.
- [x] `App.tsx`: remove `previewSubdomains` bootstrap wiring.
- [x] `session-data.ts`: remove `HistoryResponse.previewSubdomains` + the
      `setPreviewSubdomains` call (primary bootstrap consumer).

## Server
- [x] `services/misc.ts`: remove `resolvePreviewSubdomainsMode` + bootstrap field.
- [x] `services/types.ts`: remove bootstrap field.
- [x] `preview-proxy.ts`: remove path-based route + WS branch; update header doc.

## Deployment & docs
- [x] `deployment/vps/docker-compose.yml`: remove `SHIPIT_PREVIEW_SUBDOMAINS=always`
      (now that the client mode-removal landed, the env var is a no-op).
- [x] `deployment/README.md`: rewrite Tailscale note (Option A).
- [x] `shipit-docs/preview.md`: note subdomain-routing (served at origin root).

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
- [x] `tailscale.sh` + `deployment/README.md`: pivot to **sslip.io default**
      (dashed-tailnet-IP host); demote the `nodeAttrs` grant to an optional
      upgrade; colorize the printed banner/steps/paste-block (TTY-guarded).
- [x] `plan.md`: revise the decision + wiring sections for the sslip.io default.
- [x] `tailscale.sh`: make the script idempotent for reruns — `SHIPIT_TAILSCALE_HOSTNAME`
      is now an opt-in override with no default; unset, the script never renames
      the node (neither on first `up` nor on a rerun `set`), so a bare rerun
      preserves the operator's Tailscale hostname.
- [ ] Manual verification on a real tailnet: open
      `http://<dashed-tailnet-ip>.sslip.io:4123`, confirm a preview subdomain
      resolves and renders. Separately, if the tailnet has the grant, confirm the
      MagicDNS hostname path too. (Cannot be done from this container.)

## Review pass (4 parallel reviewers)
- [x] Fixed: `buildSubdomainUrl` mangled bracketed IPv6 hosts (`[::1]:3000` →
      `http://…--3000.[/`) because `split(":")` ran before the `:`-guard — it
      emitted a garbage non-null URL so the empty-state never fired. Now handles
      bracketed IPv6 first (`::1` → localhost, others → null). + unit tests.
- [x] Fixed: `tailscale.sh` now runs `tailscale serve reset` so an upgraded box
      doesn't leave a stale (preview-less) Serve URL at `https://<node>`.
- [x] Fixed: stale "subdomain/path routing" comment in `buildUpstreamHeaders`.
- [x] Reviewers confirmed clean: the `previewSubdomains` removal (no orphans /
      contract drift) and the path-based proxy deletion (helpers still used, WS
      flow intact, no test/route depends on it).

## Tests
- [x] Rewrote `usePreviewHealthPoller` tests for the removed `mode` param
      (dotless/`.ts.net` now build subdomains; raw-IP → null).
- [x] Added test: container mode + raw-IP `apiHost` → `computePreviewUrl` returns
      null (drives empty-state).
- [x] Grepped for orphaned `previewSubdomains` references — none remain in
      source/deployment.
- [ ] Manual: open ShipIt over a raw-IP host with a running container preview,
      confirm the empty-state renders (not an infinite "Connecting…" spinner).
      (Cannot be done from this container.)
