# Checklist — Align the local install with the VPS install

## New scripts (`deployment/local/`)
- [ ] `lib.sh` — channel resolution, compose path, `local_build_and_up()`, `cleanup_sessions()`
- [ ] `setup.sh` — one-line installer: OS/docker/git preflight, clone to `~/.shipit`, default stable channel, Linux-only inotify bump, build + `up -d`
- [ ] `update.sh` — refuse-on-dirty, channel-aware fetch+reset, rebuild + `up -d`
- [ ] `stop.sh` — `compose down` + session-container/network sweep; `--purge` for volumes

## VPS stop script
- [ ] `deployment/vps/stop.sh` — `compose down` + `shipit-parent-session` / `shipit-stack=shipit` sweep; `--purge` for volumes

## Repointing
- [ ] `docker/local/prod.sh` — delegate to `deployment/local/update.sh`
- [ ] `src/server/orchestrator/services/updates.ts` — 503 message points at `deployment/local/update.sh`
- [ ] `README.md` — "Try it locally" one-liner + "Software updates" bullet
- [ ] `deployment/README.md` — "Local install" section + `SHIPIT_HOME` / `SHIPIT_REPO_URL` docs

## Verification
- [ ] `bash -n` + `shellcheck` on all new/changed scripts
- [ ] `npm run typecheck` after the `updates.ts` change
- [ ] Manual e2e on macOS + Linux (install / update / stop / vps stop)
