# Ops session — implementation checklist

## Server

- [x] Add `kind?: "ops"` to `SessionInfo` + `SessionManager.setKind()` (migration 22 `kind TEXT`).
- [x] Parse top-level `x-shipit-host-mounts` in `shipit-config.ts`, allow-listed to
      `/var/run/docker.sock`, `/var/log/journal`, `/run/log/journal` (with unit tests).
- [x] Gate privileged host binds in `container-lifecycle.ts` on `config.opsSession`
      (derived from server-authoritative `session.kind === "ops"`, never a workspace file).
- [x] Point ops agents at the read-only `docker-socket-proxy` over TCP
      (`DOCKER_HOST=tcp://docker-socket-proxy:2375`), not the read-write session proxy.
- [x] Ops template (`templates-ops.ts`): README, shipit.yaml, hardened compose proxy, prompts.
      Resolvable by id but hidden from `listTemplates()`.
- [x] `applyTemplate` service stamps `kind="ops"` before container boot; refuses an
      existing `sessionId` (no retrofitting an ordinary session into a privileged one).
- [x] `getHostOverview` service + `GET /api/host/overview` route (read-only container list).

## Client

- [x] Pinned "Host / Ops" sidebar group keyed off `kind === "ops"` (separate from repo/orphan).
- [x] `ops` badge on ops session rows.
- [x] Settings → advanced "Create ops session for this host" affordance.
- [x] Per-kind right-panel tabs: hide Preview + PR, add read-only Host tab (`HostPanel`).
- [x] `"host"` added to `RightTab` union + persisted-tab allow-list.

## Docs & packaging

- [x] `src/server/shipit-docs/ops-session.md` — agent-facing read-only contract.
- [x] `docker/ops-session/docker-compose.proxy.yml` — canonical hardened proxy reference.
- [x] Embedded prompts: investigate-loop, diagnose-stuck-session, daily-health,
      verify-ops-access (live PASS/FAIL self-check covering Docker proxy, journal
      mounts, read-only enforcement, and the negative boundaries).

## Tests

- [x] `shipit-config.test.ts` — host-mount allow-list parsing.
- [x] `container-lifecycle.test.ts` — security gate: ops gets journal binds + ops DOCKER_HOST;
      a forged non-ops shipit.yaml gets nothing (mounts dropped).
- [x] `services/host.test.ts` — `getHostOverview` (docker null → unavailable; mapping/correlation).
- [x] `templates.test.ts` — ops template resolvable but hidden; embeds proxy + journal mounts.
- [x] `services/templates.test.ts` — `applyTemplate` stamps kind, rejects existing sessionId.
- [x] `SessionSidebar.test.tsx` — ops session renders in Host/Ops group, not a repo group.

## Provisioning fixes from the live audit (host `shipit-16gb`)

- [x] `DOCKER_HOST` precedence: ops agent must use the read-only proxy, never the
      read-write session proxy. `buildContainerConfig` forces `dockerAccess: false`
      for ops; `buildEnv` checks the ops gate before `dockerAccess`. Regression
      tests in `container-lifecycle.test.ts` (both layers). Fixes audit FAIL #1/#11.
- [x] `journalctl` installed in the docker-capable image (`docker/container-build/Dockerfile`
      installs `systemd`) so the journal recipes run. Fixes audit FAIL #14/#15.
- [x] Loud warning when an ops session boots without `SESSION_DOCKER_IMAGE` (base
      image → no `docker`/`journalctl`), instead of silently half-provisioning.

## Remaining

- [ ] Re-run `prompts/verify-ops-access.md` on a host deployed from this branch and
      confirm the PASS/FAIL table is all-PASS (B returns full host container list via
      `docker-socket-proxy:2375`, C mutations rejected, D journal readable via `journalctl`).
- [ ] Verify host `shipit-16gb` is redeployed with `SESSION_DOCKER_IMAGE` set to the
      docker-capable image — the audit showed `docker`/`journalctl` absent, which means
      it was running the base image (stale deploy or base-image warm standby).
- [ ] Follow-up: confirm an ops session is never served from a base-image **warm
      standby** (`warm-pool-manager.ts` creates standbys with the generic image and has
      no ops/image awareness). If it can be, ops sessions must force a fresh
      docker-capable container instead of claiming a base-image standby.
- [ ] Confirm `kind: "ops"` server-side creation path is wired to the Settings button end-to-end
      in a live environment (the gate is unit-tested; live verification pending).
