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
- [x] System-prompt ops overlay: `buildAgentSystemInstructions({ isOps })` splices in an
      "Ops session" block (read-only privilege surface + `journalctl -D` rule), swaps the
      aggressive PR nudge for a read-only variant, drops the scaffold best-practice, and
      replaces "Live preview" with a "Compose services" note (the workspace compose only
      runs the host-access `docker-socket-proxy` — it's not an app preview, so hot-reload /
      `x-shipit-preview` guidance is irrelevant). Threaded from `session-agent-run-params.ts`
      off `session.kind === "ops"` (read in the pre-`await` DB block). Previously the agent
      got the generic build-oriented prompt and had no idea it was a privileged read-only
      host-debug session.

## Client

- [x] Pinned "Host / Ops" sidebar group keyed off `kind === "ops"` (separate from repo/orphan).
- [x] `ops` badge on ops session rows.
- [x] Settings → advanced "Create ops session for this host" affordance.
- [x] Per-session `⋯` menu "Investigate in Ops session" entry point (any non-ops row);
      seeds the new session's composer draft with a target-scoped investigation prompt.
- [x] `createOpsSession(targetSessionId?)` store action centralizing ops creation
      (Settings + sidebar both use it); refactored the Settings inline fetch onto it.
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
- [x] `services/templates.test.ts` — `applyTemplate` stamps kind, rejects existing sessionId,
      seeds a target-scoped prompt + `Ops — debug:` title for a known `targetSessionId`,
      and falls back to a generic ops session for an unknown id.
- [x] `SessionSidebar.test.tsx` — `⋯` menu offers "Investigate in Ops session" on a non-ops
      row (creates + navigates via `createOpsSession`), hides it on an ops row.
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
- [x] **Docker-capable image built + wired in prod (audit FAIL #4/#5/#14/#15 root
      cause).** Prod previously left `SESSION_WORKER_DOCKER_IMAGE` unset and never
      built the docker image, so docker/ops sessions fell back to the base image
      (no `docker`/`journalctl`). Now: a `session-worker-docker` build-only service
      (`deployment/vps/docker-compose.yml`) layers Docker CLI + journalctl on
      `shipit-session-worker:prod` → `shipit-session-worker:docker`; `deploy.sh`
      builds it after the base (separate step, no `--pull`, local base); the
      orchestrator env sets `SESSION_WORKER_DOCKER_IMAGE=shipit-session-worker:docker`.
      This also fixes ordinary `capabilities.docker` sessions, which had the same gap.
- [x] **Warm standby cannot serve an ops session (verified — no code change needed).**
      Traced the full path: `createStandby` has a single caller, the warm pool
      (`warm-pool-manager.ts`), which only runs per **repo URL**. A standby is keyed
      by `config.sessionId` (the warm session's own minted id) and is only matched
      when a session activates under that *same id*; a session inherits a warm id
      only via the claim path in `services/session.ts`, which **requires `repoUrl`**.
      Ops sessions are minted by `applyTemplate` with a fresh id, `kind="ops"`, and
      **no `remoteUrl`** (`services/templates.ts`), so they never enter the warm pool
      and never match a standby. On activation the runner factory finds no container
      for the ops id → fresh-create with `opsSession: kind === "ops"` → docker-capable
      image + ops wiring. So the docker-capable image fix above is sufficient; there
      is no base-image-standby bypass to close.

## Live re-audit (host deployed from this branch)

- [x] **Live re-audit PASSED.** `DOCKER_HOST` points at the hardened read-only
      `docker-socket-proxy:2375`; `docker` and `journalctl` are installed; read-only
      Docker returns the full host container list; mutations are rejected; the journal
      is readable.
- [x] **journalctl recipes use `-D /var/log/journal`.** The live run surfaced that a
      bare `journalctl` reads the agent container's own (empty) journal — the
      container's machine-id doesn't match the host's, so the default lookup returns
      "No journal files were found". `-D /var/log/journal` points it at the host's
      mounted journal (~30k lines/24h on the test host). Updated all three embedded
      prompts (investigate-loop, diagnose-stuck-session, daily-health), the
      `verify-ops-access` recipe, and `shipit-docs/ops-session.md`; noted that this
      host uses persistent storage (`/var/log/journal` populated; `/run/log/journal`
      empty).

## Remaining

- [x] Confirm `kind: "ops"` server-side creation path is wired to the Settings button end-to-end
      in a live environment (live re-audit on the branch-deployed host passed — see "Live re-audit").
