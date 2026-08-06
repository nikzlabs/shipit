---
issue: roadmap#SHI-327
title: Local install — bind address and Tailscale access
description: Bind the local install to loopback by default, with an opt-in best-effort tailnet binding and sslip.io previews.
---

# Local install — bind address and Tailscale access

Implements [`requirements.md`](./requirements.md).

## Problem

Two independent gaps, both confined to the **local install**
(`deployment/local/` + `docker/local/prod/compose.yml`).

**1. The local install publishes on every interface, with no auth in front.**

```yaml
# docker/local/prod/compose.yml — before
ports:
  - "4123:4123"      # no host IP -> 0.0.0.0
  - "4124:5173"
```

ShipIt has no built-in authentication (`SECURITY-MODEL.md:336-338`); it relies on
the deployment putting an access layer in front. The VPS does exactly that — it
binds `127.0.0.1:4123` and fronts it with Caddy plus Cloudflare Zero Trust or the
Tailscale forwarder. The local install had neither, so a laptop on café wifi
exposed an unauthenticated agent with a shell and repo access to that network
(req 2).

A host firewall is not a reliable mitigation here. On Linux, Docker DNATs published
ports in `nat` PREROUTING and the packet then traverses `FORWARD`, where Docker's
own ACCEPT rules sit above ufw's — so `ufw default deny incoming` reports active
while the port stays reachable. On macOS the application firewall is off by
default. `docs/175-preview-subdomain-only/plan.md:212-217` had already prescribed
the right answer for the tailnet case: bind the specific address, "not `0.0.0.0`,
so it isn't exposed on a public interface."

**2. There is no local Tailscale path, and previews are what makes it hard.**

`deployment/vps/tailscale.sh` exists; `deployment/local/` has no counterpart —
docs/180 deliberately dropped Tailscale from the local path. But the app is the
easy half. Previews are subdomain-only since docs/175
(`{sessionId}--{port}.<host>`), so they need a host that can carry a wildcard
subdomain, and the client refuses to even build a URL for a raw IP:

```ts
// src/client/hooks/usePreviewHealthPoller.ts:43
if (/^\d+\.\d+\.\d+\.\d+$/.test(apiHostname) || apiHostname.includes(":")) return null;
```

So browsing at `http://100.83.12.47:4123` gives a working app and no previews.

## Approach

### Bind address (reqs 1, 2, 3)

One variable, defaulting to loopback:

```yaml
# docker/local/prod/compose.yml — after
ports:
  - "${SHIPIT_BIND_ADDR:-127.0.0.1}:4123:4123"
  - "${SHIPIT_BIND_ADDR:-127.0.0.1}:4124:5173"
```

It reuses the `.shipit.env` operator-preferences file `lib.sh` already sources, so
it survives image rebuilds and `git reset --hard` (`lib.sh:58-70`). A user who
genuinely wants LAN access sets `SHIPIT_BIND_ADDR=0.0.0.0` there.

The default changes behaviour for anyone currently reaching a local install across
the LAN — accepted deliberately (see the 2026-08-06 receipt in `requirements.md`).

`4124:5173` is retained but narrowed. Nothing listens on 5173 in the prod image:
`docker/Dockerfile.prod` runs `npm run build` at build time, its `CMD` starts only
the orchestrator, and the client is served from `dist/client/` by `@fastify/static`
(`app-assembly.ts:57`). `EXPOSE 3000 5173` is stale metadata. Removing the mapping
is probably correct but is not what was asked for, so it is flagged rather than
done.

### Tailnet binding is resolved at start, never pinned (reqs 5, 6)

The constraint that shapes this: Docker fails the **entire** container if any one
published binding can't be bound. A tailnet IP written into the compose file would
therefore turn "tailscaled is slow after a reboot" into "ShipIt does not start" —
violating req 5. So the tailnet binding is computed at every start:

```
shipit_refresh_tailnet_bind()          # lib.sh, called before every `up`
  SHIPIT_TAILNET_BIND=1 in .shipit.env ?   # opted in?
    no  -> remove the override file, done  # req 3: no-Tailscale users see nothing
  tailscale ip -4 returns an address ?
    no  -> remove the override file, warn  # req 5: still starts, loopback only
    yes -> write the override file with that address   # req 6: re-derived each time
```

The override is a generated compose file adding a second binding to the same
container port; Compose concatenates `ports` across `-f` files:

```yaml
# .shipit-tailnet.compose.yml — generated, git-ignored
services:
  shipit:
    ports:
      - "100.83.12.47:4123:4123"
```

`shipit_compose_files()` emits `-f base` plus `-f override` when the override
exists, and the `build`/`up` calls in `shipit_build_and_up` go through it.
`stop.sh` deliberately does not: `docker compose down` resolves by project name
(`name: shipit-prod` in the base file), and the overlay adds no service, network
or volume — only a port on the existing `shipit` service. Threading it there
would be inert. Loopback is
always present, so localhost never depends on Tailscale being up (req 5), and a
changed tailnet address is picked up on the next start with no hand-editing
(req 6).

Self-healing is bounded by process start, not by a poll loop — unlike the VPS
forwarder (docs/216), which supervises a long-lived `socat` and must therefore
watch for IP changes itself. Here the binding only matters at container start, so
re-deriving it there is sufficient and there is no daemon to own.

### `deployment/local/tailscale.sh` (reqs 4, 6)

The laptop counterpart to the VPS script, and much smaller, because the local
install publishes the port itself — there is no `socat` forwarder, no systemd unit,
and no privileged setup. It checks Tailscale is installed and authenticated
(instructing rather than installing), reads `tailscale ip -4`, writes
`SHIPIT_TAILNET_BIND=1` to `.shipit.env`, restarts, and prints the sslip.io URL.

Previews work through the same mechanism the VPS uses: browse ShipIt at
`http://<dashed-tailnet-ip>.sslip.io:4123` and previews are built as
`{sessionId}--{port}.<dashed-ip>.sslip.io:4123` from `window.location.host`, with
no server-side configuration. sslip.io maps any `<dashed-ip>.sslip.io` name back to
that IP, and the orchestrator's proxy regex is domain-agnostic
(`preview-proxy.ts:44` — `{uuid}--{port}.anything`). The dashed form also dodges the
raw-IPv4 guard quoted above.

Deliberately **not** reused from the VPS script: the `.tailnet-preview-host`
mechanism (docs/216). That exists so the app can be served on a native MagicDNS
`.ts.net` name while only preview iframes route through sslip.io, and it is
hard-gated to `.ts.net` browsing on the client (`preview-host.ts:29`) and to
sslip-shaped hosts on the server (`misc.ts:56`). Here the user browses the sslip
host directly, so `window.location.host` already carries it and the override would
be inert. Adding it would be mechanism with no observable effect.

Access is HTTP over WireGuard: encrypted on the wire, but not a secure context, so
`crypto.randomUUID` (already handled — `src/client/utils/random-id.ts`), clipboard,
and PWA install are unavailable. `random-id.ts` documents a real prior outage from
exactly this, so the caveat is field-proven, not theoretical. An owned wildcard
domain pointed at the tailnet IP is the path to real HTTPS.

### The update path (req 9)

`.shipit.env` is untracked but was never git-ignored, and `shipit_sync_checkout`
refused to sync when `git status --porcelain` was non-empty — which lists untracked
files. So writing operator preferences permanently broke `update.sh`. The egress
opt-out (`setup.sh`) already writes that file, so this bug predates this feature;
it is fixed here because this feature would otherwise widen it.

Two changes, and the second is the one that matters:

1. `.gitignore` now covers `.shipit.env` and the generated overlay.
2. `shipit_sync_checkout` checks `--untracked-files=no`.

The `.gitignore` entry alone would **not** have fixed anyone already affected:
`update.sh` sources the checkout's *own* copy of `lib.sh`, so an old copy rejects
the tree before it can fetch the commit carrying the new ignore rule. Narrowing the
check is what unblocks them, on the next update after this lands.

The narrowing is also just correct on its own terms: `git reset --hard` discards
changes to *tracked* files only and leaves untracked files alone, so refusing on
them never protected anything. Anyone stuck on a pre-fix copy needs one manual
`rm ~/.shipit/.shipit.env`, documented in `deployment/README.md`.

### Failure handling in the best-effort path

Every filesystem mutation in `shipit_refresh_tailnet_bind` is guarded, because the
callers run `set -euo pipefail` and the binding is best-effort by definition: a
read-only checkout or a full disk must degrade to "no tailnet binding", never to
"ShipIt refuses to start". Overlay *removal* is the exception to silent tolerance —
`shipit_compose_files` keys off the file's existence, so a leftover overlay would
keep binding an address the user opted out of, or one that no longer exists (which
fails the container outright). That case warns rather than passing quietly.

### Documentation corrections

- `SECURITY-MODEL.md:341` claimed the local install "binds to `localhost` only —
  nothing is exposed off the machine." False before this change; true after it, so
  it is extended to describe the opt-ins rather than merely corrected.
- `CLAUDE.md:231` still described path-based `/preview/:sessionId/:port/*` as the
  preview fallback. That route was deleted in docs/175; subdomain routing is the
  only mode and `preview.url` survives solely as a container-mode sentinel.
- `README.md` gains a local remote-access section (req 7).

### Preview empty state (req 8)

`PreviewFrame.tsx:493-508` already explains that previews need wildcard DNS. What
it does not do is name a host that works. When ShipIt is being browsed at a raw
IPv4, the copy now names that machine's `<dashed-ip>.sslip.io` form, which is
directly actionable.

## Key files

| File | Role |
|---|---|
| `docker/local/prod/compose.yml` | `SHIPIT_BIND_ADDR`, default `127.0.0.1` |
| `deployment/local/lib.sh` | `shipit_refresh_tailnet_bind()`, `shipit_compose_files()` |
| `deployment/local/tailscale.sh` | **new** — opt in, print the sslip.io URL |
| `deployment/local/setup.sh` · `update.sh` | pass the new compose files through |
| `.gitignore` | `.shipit.env`, `.shipit-tailnet.compose.yml` |
| `src/client/components/PreviewFrame/PreviewFrame.tsx` | name a usable host in the empty state |
| `SECURITY-MODEL.md` · `README.md` · `CLAUDE.md` | corrections + remote-access docs |

## Testing

`deployment/local/lib.test.ts` drives the **real** `lib.sh` with a stubbed
`tailscale` binary on `PATH`, following `services/update-script.test.ts` (which
drives the real VPS updater and stubs only Docker). The properties under test are
the requirements, not the implementation: no-Tailscale users get exactly one
loopback binding and no override file (req 3); an opted-in user with Tailscale up
gets loopback *plus* the tailnet address (req 4); an opted-in user with Tailscale
**down** still gets loopback and no failure (req 5); a changed address is re-derived
rather than reused (req 6); and a stale override is cleaned up when the user opts
out.

`compose-bind.test.ts` asserts the committed compose file defaults to `127.0.0.1`,
so the security property (req 2) fails a build rather than regressing silently.
