# Checklist — Rootless VPS install

## Decisions to confirm before implementing
- [ ] Confirm scope: reduced-root (one-time `sudo` bootstrap) is acceptable vs. holding out for an unattainable zero-root install
- [ ] Confirm v1 drops Cloudflare/Tailscale (expose separately) and UI self-update (manual `update.sh`)
- [ ] Confirm socket strategy: Option A (compose-mount remap, no code change) for v1

## Bootstrap preflight (root-only, check-and-instruct)
- [ ] Detect `newuidmap`/`newgidmap`; instruct `apt install uidmap` if missing
- [ ] Detect `/etc/subuid` + `/etc/subgid` entries for `$USER`; instruct if missing
- [ ] Detect `fs.inotify.max_user_watches` below threshold; instruct the sysctl bump (524288 / 512)
- [ ] Never auto-`sudo`; print exact lines and exit non-zero

## `deployment/vps-rootless/`
- [ ] `setup.sh` — Linux-only OS gate, bootstrap preflight, install Rootless Docker, clone to `~/.shipit` (stable channel), write `~/.config/docker/daemon.json` pools, build + `up -d`
- [ ] `compose.yml` (or override) — socket mount source `${XDG_RUNTIME_DIR}/docker.sock`, repo mount `${SHIPIT_HOME}:/opt/shipit`
- [ ] `update.sh` — reuse `deployment/local/lib.sh`, default `SHIPIT_HOME=~/.shipit`, export rootless `DOCKER_HOST`
- [ ] `stop.sh` — `compose down` + session sweep; `--purge` for volumes
- [ ] Reuse `deployment/local/lib.sh` for channel resolution / `shipit_sync_checkout` / `shipit_build_and_up`

## Orchestrator (only if Option B is chosen)
- [ ] Wire `DOCKER_SOCKET_PATH` env → `SessionContainerManager` `socketPath` in `app-di.ts`

## Docs
- [ ] `README.md` — reduced-root VPS one-liner + bootstrap note + limitations
- [ ] `deployment/README.md` — "Rootless VPS install" section, bootstrap steps, known limitations
- [ ] Update `docs/180-align-local-install/plan.md` cross-reference if the lib.sh contract changes

## Verification
- [ ] `bash -n` on all new scripts
- [ ] `npm run typecheck` if any orchestrator code changes (Option B)
- [ ] Manual e2e on a fresh Linux VPS: bootstrap → rootless setup → ShipIt at localhost:4123, sessions spawn, update + stop work
- [ ] Verify the container sees the repo at `/opt/shipit` (Settings → Software Updates resolves)
- [ ] Verify many-session file watching against the admin-set inotify ceiling
