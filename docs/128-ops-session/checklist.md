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

- [x] **`DOCKER_HOST` precedence (audit FAIL #1/#11).** The ops `shipit.yaml`
      declares `compose.docker-socket: true` (so the proxy *sibling* may mount the
      socket), and `resolveAgentDockerLimits` derives the *agent's* `dockerAccess`
      from that same flag — so an ops session reached `buildEnv` with both flags and
      got the **read-write** session proxy (host-blind for reads, write-forwarding).
      Fix: `buildContainerConfig` forces `dockerAccess: false` for ops sessions, and
      `buildEnv` checks the ops gate *before* `dockerAccess` as a structural backstop.
      Regression tests at both layers in `container-lifecycle.test.ts`.
- [x] **`journalctl` in the docker-capable image (audit FAIL #14/#15).**
      `docker/Dockerfile.session-worker.docker` now installs `systemd` (the binary
      reads the mounted journal dirs directly; not PID 1).
- [x] **Loud startup warning** when an ops session boots without
      `SESSION_WORKER_DOCKER_IMAGE` set (→ base image, no `docker`/`journalctl`),
      instead of silently half-provisioning. (`createContainer`.)

## Remaining — deployment gap (this is why the audit saw no `docker`/`journalctl`)

**Root cause found:** in prod, `SESSION_WORKER_DOCKER_IMAGE` is **not set** in
`deployment/vps/docker-compose.yml`, and the deploy only builds the base
`shipit-session-worker:prod` image (`deploy.sh … build session-worker shipit`).
That base image has neither the docker CLI nor `journalctl`. So `dockerImageName`
is `undefined` at runtime and ops sessions fall back to the base image — exactly
the audit's FAIL #4/#5/#14/#15. The `journalctl` fix above lands in
`Dockerfile.session-worker.docker`, which extends `:dev` and is **not built or
referenced in prod** — so prod needs the wiring below before any of this helps.

- [ ] **Build a docker-capable PROD session image** (docker CLI + `journalctl` on
      top of `shipit-session-worker:prod`) and build it in `deploy.sh`.
- [ ] **Set `SESSION_WORKER_DOCKER_IMAGE`** to that image in the prod orchestrator
      env (`deployment/vps/docker-compose.yml`), so `setDockerProxy` passes it to
      `dockerImageName` and ops/docker sessions boot the capable image. Until then
      the new startup warning will fire on every ops session.
- [ ] Re-run `prompts/verify-ops-access.md` on a host deployed from this branch and
      confirm all-PASS (B: full host container list via `docker-socket-proxy:2375`;
      C: mutations rejected; D: journal readable via `journalctl`).
- [ ] Confirm an ops session is never served from a base-image **warm standby**
      (`warm-pool-manager.ts` creates standbys with the generic image and has no
      ops/image awareness). If it can be, ops sessions must force a fresh
      docker-capable container instead of claiming a base-image standby.
- [ ] Confirm `kind: "ops"` server-side creation path is wired to the Settings button end-to-end
      in a live environment (the gate is unit-tested; live verification pending).
